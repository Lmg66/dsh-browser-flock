import test from 'node:test';
import assert from 'node:assert/strict';
import { InstanceManager } from '../src/host/instance-manager.js';
import { Operations } from '../src/host/operations.js';
import { apply as applyTools } from '../src/host/tools.js';

const a='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',b='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
function fixture({browser='chrome',fail=false,endpointFail=false}={}) {
  const state={instances:[],tombstones:[],requests:{}};
  const calls={create:0,launch:0,load:0,copy:0};
  const repository={snapshot:()=>structuredClone(state),transaction:async fn=>fn(state),profilePath:id=>`profile/${id}`,assertProfile:async id=>`profile/${id}`,createProfile:async id=>{
    calls.create++;assert.deepEqual(state.instances.find(i=>i.id===id).extensionLibraryIds,[a,b]);
  }};
  const runtimes={get:()=>({id:'r',browser,available:true})};
  const platform={launch:async()=>{calls.launch++;assert.deepEqual(state.instances[0].extensionLibraryIds,[a,b]);return {processIdentity:{pid:1}};},inspectInstance:async()=>({status:state.instances[0].status}),closeInstance:async()=>({status:'stopped'})};
  const manager=new InstanceManager(repository,runtimes,platform,{discoverExtensionCdp:async()=>{if(endpointFail)throw Error('CDP refused');return {status:'ready'};},loadExtension:async()=>{calls.load++;if(fail)throw Error('load refused');return {id:'loaded'};}});
  manager.extensionLibrary={list:()=>[{id:a},{id:b}],copyForInstance:async id=>{calls.copy++;return {path:id};}};
  return {manager,state,calls,operations:new Operations(repository,runtimes,manager)};
}

test('new selections are persisted before profile creation and launch and reapplied on reopen',async()=>{
  const f=fixture();const result=await f.operations.dispatch({action:'open_browser_instance',args:{runtime_id:'r',extension_library_ids:[a,b]}});
  assert.equal(result.ok,true);assert.equal(result.data.instance.status,'running');assert.equal(f.calls.load,2);
  const id=result.data.instance.id;
  for(const list of [[],[a]])await assert.rejects(f.manager.open({instance_id:id,extension_library_ids:list}),{code:'INVALID_ARGUMENT'});
  await f.manager.close(id);
  const reopened=await f.manager.open({instance_id:id});
  assert.deepEqual(reopened.instance.extensionLibraryIds,[a,b]);assert.equal(f.calls.load,4);assert.equal(f.calls.create,1);
});

test('extension request fingerprints replay identical inputs and reject changed lists',async()=>{
  const f=fixture();const input={runtime_id:'r',extension_library_ids:[a,b],request_id:'once'};
  await f.manager.open(input);assert.equal((await f.manager.open(input)).replayed,true);
  for(const extension_library_ids of [[b,a],[a],[],undefined])await assert.rejects(f.manager.open({...input,extension_library_ids}),{code:'REQUEST_CONFLICT'});
  assert.equal(f.calls.launch,1);assert.equal(f.calls.load,2);
});

test('invalid selections fail before state, profile, copy or launch effects',async()=>{
  for(const extension_library_ids of [null,'bad',{},[null],['bad'],[a,a],Array(33).fill(a),new Array(1),['cccccccc-cccc-cccc-cccc-cccccccccccc']]) {
    const f=fixture();const result=await f.operations.dispatch({action:'open_browser_instance',args:{runtime_id:'r',extension_library_ids,request_id:'invalid'}});
    assert.equal(result.ok,false);assert.ok(['INVALID_ARGUMENT','EXTENSION_NOT_FOUND'].includes(result.error.code));
    assert.deepEqual(f.calls,{create:0,launch:0,load:0,copy:0});assert.deepEqual(f.state,{instances:[],tombstones:[],requests:{}});
  }
});

test('extension creation requires Chromium and enabled CDP before profile creation',async()=>{
  for(const [browser,cdp,code] of [['firefox',undefined,'EXTENSION_UNSUPPORTED'],['chrome',false,'CDP_DISABLED'],['other',true,'EXTENSION_UNSUPPORTED']]) {
    const f=fixture({browser});await assert.rejects(f.manager.open({runtime_id:'r',cdp,extension_library_ids:[a,b]}),{code});
    assert.equal(f.calls.create,0);assert.equal(f.calls.launch,0);assert.equal(f.state.instances.length,0);
  }
});

for(const options of [{fail:true},{endpointFail:true}])test(`startup extension failures return warnings and preserve browser: ${JSON.stringify(options)}`,async()=>{
  const f=fixture(options);const result=await f.manager.open({runtime_id:'r',extension_library_ids:[a,b]});
  assert.equal(result.instance.status,'running');assert.equal(result.instance.lastError,null);assert.equal(result.warnings.length,2);
  assert.deepEqual(result.instance.extensionLibraryIds,[a,b]);assert.equal(result.instance.extensionLoadResults.length,2);
});

test('open tool exposes extension list and forwards it through the dispatcher',async()=>{
  const f=fixture(),tools=new Map();applyTools({tools:{register:t=>tools.set(t.name,t)},sandboxPolicy:{resolve:()=>({mode:'danger-full-access'})},browserFlock:f.operations,get:()=>undefined});
  const tool=tools.get('open_browser_instance');
  const schema=tool.parameters.properties.extension_library_ids;
  assert.equal(schema.type,'array');assert.equal(schema.items.type,'string');
  const result=JSON.parse(await tool.execute({runtime_id:'r',extension_library_ids:[a,b]},{signal:new AbortController().signal}));
  assert.equal(result.ok,true);assert.deepEqual(result.data.instance.extensionLibraryIds,[a,b]);
});
