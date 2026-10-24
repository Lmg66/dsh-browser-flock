import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {discoverCdp,loadUnpackedExtension,uninstallExtension} from '../src/host/cdp.js';
import {launchArguments} from '../src/host/browser-adapters.js';
import {openInput} from '../src/shared/validation.js';

test('extension CDP validates load IDs and sends exact uninstall ID; protocol failures reject',async()=>{
  const endpoint={status:'ready',websocket_url:'ws://127.0.0.1:43123/devtools/browser/test-id'},sent=[];
  let response={result:{}};
  class Socket {
    constructor(){this.listeners={};queueMicrotask(()=>this.listeners.open());}
    addEventListener(name,fn){this.listeners[name]=fn;}
    send(body){sent.push(JSON.parse(body));queueMicrotask(()=>this.listeners.message({data:JSON.stringify({id:1,...response})}));}
    close(){}
  }
  const options={WebSocketImpl:Socket},id='b'.repeat(32);
  await uninstallExtension(endpoint,id,options);
  assert.deepEqual(sent.pop(),{id:1,method:'Extensions.uninstall',params:{id}});
  for(const invalid of [undefined,'library-id','z'.repeat(32)])await assert.rejects(uninstallExtension(endpoint,invalid,options),/confirmed extension ID/);
  assert.equal(sent.length,0);
  response={error:{code:-32601,message:'Method not found'}};
  await assert.rejects(uninstallExtension(endpoint,id,options),/Method not found/);
  response={result:{id:'invalid'}};
  await assert.rejects(loadUnpackedExtension(endpoint,path.resolve('extension'),options),/valid extension ID/);
  response={result:{id}};
  assert.equal((await loadUnpackedExtension(endpoint,path.resolve('extension'),options)).id,id);
});

test('CDP launch uses random loopback port and refuses Firefox',()=>{
  const profile=path.resolve('profile');
  for(const browser of ['chrome','edge','brave']) {
    const args=launchArguments({browser},profile,undefined,{cdp:true});
    assert.ok(args.includes('--remote-debugging-port=0'));
    assert.ok(args.includes('--remote-debugging-address=127.0.0.1'));
    assert.ok(!args.some(a=>a.includes('remote-allow-origins')));
  }
  assert.throws(()=>launchArguments({browser:'firefox'},profile,undefined,{cdp:true}),{code:'CDP_UNSUPPORTED'});
  assert.throws(()=>openInput({runtime_id:'a',cdp:'yes'}),{code:'INVALID_ARGUMENT'});
  assert.equal(openInput({instance_id:'a',cdp:false}).cdp,false);
});
test('CDP discovery rejects stale port files and mismatched or remote sockets',async()=>{
  const profilePath=await fs.mkdtemp(path.join(os.tmpdir(),'flock-cdp-test-'));
  const file=path.join(profilePath,'DevToolsActivePort');
  try {
    const runtime={browser:'chrome'}, instance={profilePath,status:'running',cdpEnabled:true,processIdentity:{startTime:new Date(Date.now()-5000).toISOString()}};
    const good='ws://127.0.0.1:43123/devtools/browser/test-id';
    const fake=(socket)=>async()=>({ok:true,text:async()=>JSON.stringify({webSocketDebuggerUrl:socket,Browser:'Chrome/test'})});
    await fs.writeFile(file,'43123\n/devtools/browser/test-id\n');
    const result=await discoverCdp(instance,runtime,{fetchImpl:fake(good)});
    assert.equal(result.status,'ready');assert.equal(result.websocket_url,good);
    for(const socket of ['ws://example.com:43123/devtools/browser/test-id','ws://127.0.0.1:43124/devtools/browser/test-id','ws://127.0.0.1:43123/devtools/browser/other']) assert.equal((await discoverCdp(instance,runtime,{fetchImpl:fake(socket)})).status,'not_ready');
    await fs.utimes(file,new Date(0),new Date(0));
    assert.equal((await discoverCdp(instance,runtime,{fetchImpl:()=>{throw Error('must not fetch');}})).status,'not_ready');
    assert.equal((await discoverCdp({...instance,cdpEnabled:false},runtime)).status,'restart_required');
    assert.equal((await discoverCdp({...instance,status:'stopped'},runtime)).status,'stopped');
    assert.equal((await discoverCdp(instance,{browser:'firefox'})).status,'unsupported');
  } finally { await fs.rm(profilePath,{recursive:true,force:true}); }
});
