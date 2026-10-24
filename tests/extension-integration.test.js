import test from 'node:test';
import assert from 'node:assert/strict';
import {InstanceManager} from '../src/host/instance-manager.js';
import {Operations} from '../src/host/operations.js';
import {apply as applyTools} from '../src/host/tools.js';
function fixture({status='stopped',browser='chrome',cdp=true,fail=false,uninstallFail=false}={}) {
  const state={instances:[{id:'i',runtimeId:'r',status,mode:'persistent',cdpEnabled:cdp,profilePath:'fake'}],tombstones:[],runtimes:[]};
  const repository={snapshot:()=>structuredClone(state),transaction:async fn=>fn(state),assertProfile:async()=> 'fake'};
  const runtimes={get:()=>({id:'r',browser,available:true}),freshness:()=>({})};
  let loads=0;const uninstalls=[];
  const manager=new InstanceManager(repository,runtimes,{inspectInstance:async()=>({status:state.instances[0].status})},{discoverExtensionCdp:async()=>({status:'ready',websocket_url:'ws://127.0.0.1:1'}),loadExtension:async()=>{loads++;if(fail)throw Error('load refused');return {id:'a'.repeat(32)};},unloadExtension:async(endpoint,id)=>{uninstalls.push(id);assert.deepEqual(state.instances[0].extensionLibraryIds,['lib']);if(uninstallFail)throw Error('method not found');}});
  manager.extensionLibrary={list:()=>[{id:'lib'}],copyForInstance:async()=>({path:'fake-extension',entry:{id:'lib'}}),listInstalled:async()=>({items:[],instance_id:'i'}),capture:async()=>({id:'lib'}),remove:async()=>({removed:true})};
  return {manager,state,runtimes,repository,uninstalls,loads:()=>loads};
}
test('stopped install queues, startup applies selections, and stopped removal omits next launch',async()=>{
  const f=fixture();const queued=await f.manager.installExtension({instance_id:'i',library_id:'lib'});
  assert.equal(queued.status,'queued');assert.equal(f.loads(),0);assert.deepEqual(queued.instance.extensionLibraryIds,['lib']);
  f.state.instances[0].status='running';const results=await f.manager.reapplyExtensions(f.manager.get('i'),f.runtimes.get());
  assert.equal(results[0].status,'installed');assert.equal(f.loads(),1);
  assert.deepEqual(f.uninstalls,[]);
  f.state.instances[0].status='stopped';const removed=await f.manager.removeExtension({instance_id:'i',library_id:'lib'});assert.deepEqual(removed.instance.extensionLibraryIds,[]);
});
test('running removal uninstalls the confirmed center extension before dropping selection',async()=>{
  for(const mode of ['persistent','ephemeral']) {
    const f=fixture({status:'running'});f.state.instances[0].mode=mode;
    await f.manager.installExtension({instance_id:'i',library_id:'lib'});
    const result=await f.manager.removeExtension({instance_id:'i',library_id:'lib'});
    assert.deepEqual(f.uninstalls,['a'.repeat(32)]);assert.equal(result.status,'uninstalled');
    assert.equal(result.instance.status,'running');assert.deepEqual(result.instance.extensionLibraryIds,[]);assert.deepEqual(result.instance.extensionLoadResults,[]);
  }
});
test('failed uninstall retains selection and loaded identity',async()=>{
  const f=fixture({status:'running',uninstallFail:true});await f.manager.installExtension({instance_id:'i',library_id:'lib'});
  const before=f.manager.get('i');
  await assert.rejects(f.manager.removeExtension({instance_id:'i',library_id:'lib'}),{code:'EXTENSION_UNINSTALL_FAILED'});
  assert.deepEqual(f.manager.get('i').extensionLibraryIds,before.extensionLibraryIds);
  assert.deepEqual(f.manager.get('i').extensionLoadResults,before.extensionLoadResults);assert.equal(f.manager.get('i').status,'running');
});
test('running removal rejects unselected, unverified, disabled and uncertain targets without uninstall',async()=>{
  for(const kind of ['unselected','missing','invalid','failed','disabled','unknown']) {
    const f=fixture({status:'running'});await f.manager.installExtension({instance_id:'i',library_id:'lib'});
    const row=f.state.instances[0];let code='EXTENSION_ID_UNVERIFIED';
    if(kind==='unselected'){row.extensionLibraryIds=[];code='EXTENSION_NOT_SELECTED';}
    if(kind==='missing')row.extensionLoadResults=[];
    if(kind==='invalid')row.extensionLoadResults[0].extension_id='lib';
    if(kind==='failed')row.extensionLoadResults[0].status='error';
    if(kind==='disabled'){row.cdpEnabled=false;code='CDP_DISABLED';}
    if(kind==='unknown'){row.status='unknown';code='INSTANCE_BUSY';}
    const selections=structuredClone(row.extensionLibraryIds);
    await assert.rejects(f.manager.removeExtension({instance_id:'i',library_id:'lib'}),{code});
    assert.deepEqual(f.uninstalls,[]);assert.deepEqual(row.extensionLibraryIds,selections);
  }
});
test('failed running load never commits selection and startup failure retains running state',async()=>{
  const f=fixture({status:'running',fail:true});await assert.rejects(f.manager.installExtension({instance_id:'i',library_id:'lib'}),/load refused/);
  assert.equal(f.manager.get('i').extensionLibraryIds,undefined);
  f.state.instances[0].extensionLibraryIds=['lib'];const results=await f.manager.reapplyExtensions(f.manager.get('i'),f.runtimes.get());
  assert.equal(results[0].status,'error');assert.equal(f.manager.get('i').status,'running');
});
test('unsupported and CDP-disabled instances reject before load',async()=>{
  for(const options of [{browser:'firefox'},{status:'running',cdp:false}]) {
    const f=fixture(options);await assert.rejects(f.manager.installExtension({instance_id:'i',library_id:'lib'}));assert.equal(f.loads(),0);
  }
});
test('extension AI tools execute through shared dispatcher and snapshot exposes library',async()=>{
  const f=fixture();const ops=new Operations(f.repository,f.runtimes,f.manager);const tools=new Map();
  applyTools({tools:{register:t=>tools.set(t.name,t)},sandboxPolicy:{resolve:()=>({mode:'danger-full-access'})},browserFlock:ops,get:()=>undefined});
  const call=async(name,args)=>JSON.parse(await tools.get(name).execute(args,{signal:new AbortController().signal}));
  assert.equal((await call('list_instance_extensions',{instance_id:'i'})).ok,true);
  assert.equal((await call('capture_browser_extension',{instance_id:'i',extension_id:'x'})).data.id,'lib');
  assert.equal((await call('install_browser_extension',{instance_id:'i',library_id:'lib'})).data.status,'queued');
  assert.equal((await call('remove_instance_extension',{instance_id:'i',library_id:'lib'})).data.removed,true);
  assert.equal((await call('remove_browser_extension',{library_id:'lib'})).ok,true);
  assert.equal(ops.snapshot().extension_library[0].id,'lib');
});
