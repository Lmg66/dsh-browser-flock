import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {RecordingManager} from '../src/host/recordings.js';
class Socket extends EventTarget {
 static sockets=[];
 constructor(){super();this.calls=[];Socket.sockets.push(this);queueMicrotask(()=>this.dispatchEvent(new Event('open')));}
 emit(method,params,sessionId='s1'){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({method,params,sessionId})}));}
 send(text){const m=JSON.parse(text);this.calls.push(m);let result={};if(m.method==='Target.getTargets')result={targetInfos:[{targetId:'tab1',type:'page',url:'https://example.test'}]};if(m.method==='Target.attachToTarget')result={sessionId:'s1'};if(m.method==='Page.addScriptToEvaluateOnNewDocument')result={identifier:'script1'};if(m.method==='Network.getResponseBody')result={body:'response-secret-abcdefghij',base64Encoded:false};queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id:m.id,result})})));}
 close(){this.dispatchEvent(new Event('close'));}
}
async function setup(options={}){const root=await fs.mkdtemp(path.join(os.tmpdir(),'bf-recordings-'));const repo={recordingsRoot:async()=>root,snapshot:()=>({instances:[{id:'owned',name:'Browser'}]})};const instances={getCdp:async()=>({status:'ready',websocket_url:'ws://127.0.0.1:1234/devtools/browser/abc'})};const manager=await new RecordingManager(repo,instances,{WebSocketImpl:Socket,commandTimeoutMs:100,...options}).open();return {root,repo,instances,manager,async cleanup(){await manager.close();await fs.rm(root,{recursive:true,force:true});}};}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('record HTTP raw credentials, input, navigation and bounded bodies; survives manager reopen',async()=>{const x=await setup({maxBodyBytes:16});try{const s=await x.manager.start({instance_id:'owned'}),socket=Socket.sockets.at(-1);assert.deepEqual(structuredClone(s),JSON.parse(JSON.stringify(s)),'summary must be lossless JSON for RPC');const binding=socket.calls.find(c=>c.method==='Runtime.addBinding').params.name;socket.emit('Network.requestWillBeSentExtraInfo',{requestId:'r1',headers:{Cookie:'early-secret'}});socket.emit('Runtime.bindingCalled',{name:binding,payload:JSON.stringify({type:'input',value:'secret-password',input_type:'password'})});socket.emit('Page.frameNavigated',{frame:{id:'frame',url:'https://example.test/next'}});socket.emit('Network.requestWillBeSent',{requestId:'r1',wallTime:1,timestamp:2,request:{url:'https://example.test/api',method:'POST',headers:{Authorization:'Bearer secret',Cookie:'session=secret'},postData:'password=secret'}});socket.emit('Network.responseReceived',{requestId:'r1',response:{url:'https://example.test/api',status:200,headers:{'set-cookie':'secret'}}});socket.emit('Network.loadingFinished',{requestId:'r1',encodedDataLength:30});await tick();const stopped=await x.manager.stop({recording_id:s.id});assert.equal(stopped.status,'stopped');assert.equal(stopped.request_count,1);const events=await x.manager.listEvents({recording_id:s.id});assert.ok(events.items.some(e=>e.action?.value==='secret-password'));assert.ok(events.items.some(e=>e.type==='navigation'));const request_id=events.items.find(e=>e.type==='request').request_id;const detail=await x.manager.getRequest({recording_id:s.id,request_id});assert.equal(detail.extra_request_headers.Cookie,'early-secret');assert.equal(detail.headers.Authorization,'Bearer secret');assert.equal(detail.request_body.data,'password=secret');assert.equal(detail.response_body.status,'truncated');assert.equal(detail.response_body.captured_bytes,16);assert.ok(socket.calls.some(c=>c.method==='Runtime.removeBinding'));const reopened=await new RecordingManager(x.repo,x.instances,{WebSocketImpl:Socket}).open();assert.equal(reopened.get({recording_id:s.id}).status,'stopped');assert.equal((await reopened.getRequest({recording_id:s.id,request_id})).headers.Cookie,'session=secret');await reopened.close();}finally{await x.cleanup();}});
test('new tabs and iframe contexts are instrumented, disconnect interrupts and marks unavailable bodies',async()=>{const x=await setup();try{const s=await x.manager.start({instance_id:'owned'}),socket=Socket.sockets.at(-1);socket.emit('Target.attachedToTarget',{sessionId:'s2',targetInfo:{targetId:'tab2',type:'page',url:'https://example.test'}});await tick();socket.emit('Runtime.executionContextCreated',{context:{id:42,auxData:{isDefault:true}}},'s2');socket.emit('Network.requestWillBeSent',{requestId:'pending',request:{url:'https://example.test',method:'GET',headers:{}}},'s2');await tick();assert.ok(socket.calls.some(c=>c.method==='Runtime.evaluate'&&c.sessionId==='s2'&&c.params.contextId===42));socket.close();await tick();await tick();const result=await x.manager.stop({recording_id:s.id});assert.equal(result.status,'interrupted');const events=await x.manager.listEvents({recording_id:s.id});const detail=await x.manager.getRequest({recording_id:s.id,request_id:events.items.find(e=>e.type==='request').request_id});assert.equal(detail.response_body.status,'missing');}finally{await x.cleanup();}});
test('restart marks incomplete records interrupted; rejects foreign endpoints and path traversal',async()=>{const x=await setup();try{const s=await x.manager.start({instance_id:'owned'});await assert.rejects(x.manager.start({instance_id:'owned'}),/already/);const reopened=await new RecordingManager(x.repo,x.instances).open();assert.equal(reopened.get({recording_id:s.id}).status,'interrupted');await reopened.close();await assert.rejects(x.manager.getRequest({recording_id:s.id,request_id:'../summary'}),/Invalid/);x.instances.getCdp=async()=>({status:'ready',websocket_url:'ws://evil.test/devtools/browser/id'});await assert.rejects(x.manager.start({instance_id:'other'}),/verified/);}finally{await x.cleanup();}});
test('capture limits and protocol body timeout remain explicit, stop releases recording',async()=>{class SlowBody extends Socket{send(text){if(JSON.parse(text).method!=='Network.getResponseBody')super.send(text);}}const x=await setup({maxRequests:1,maxEvents:3,WebSocketImpl:SlowBody,commandTimeoutMs:20});try{const s=await x.manager.start({instance_id:'owned'}),socket=Socket.sockets.at(-1);socket.emit('Network.requestWillBeSent',{requestId:'one',request:{url:'https://example.test',method:'GET',headers:{}}});socket.emit('Network.loadingFinished',{requestId:'one'});socket.emit('Network.requestWillBeSent',{requestId:'two',request:{url:'https://example.test',method:'GET',headers:{}}});const done=await x.manager.stop({recording_id:s.id});assert.equal(done.omitted_requests,1);assert.ok(done.omitted_events>0);const events=await x.manager.listEvents({recording_id:s.id});const detail=await x.manager.getRequest({recording_id:s.id,request_id:events.items.find(e=>e.type==='request').request_id});assert.equal(detail.response_body.status,'missing');assert.match(detail.response_body.reason,/timed out/);assert.equal(x.manager.active.size,0);}finally{await x.cleanup();}});

test('bursts batch disk writes, retain every event and latest request, and never pause targets',async(t)=>{
 const x=await setup();try{
  const s=await x.manager.start({instance_id:'owned'}),socket=Socket.sockets.at(-1);
  let renames=0,appends=0;const rename=fs.rename,append=fs.appendFile;
  t.mock.method(fs,'rename',async(...args)=>{renames++;return rename(...args);});
  t.mock.method(fs,'appendFile',async(...args)=>{appends++;return append(...args);});
  const binding=socket.calls.find(c=>c.method==='Runtime.addBinding').params.name;
  for(let i=0;i<100;i++)socket.emit('Runtime.bindingCalled',{name:binding,payload:JSON.stringify({type:'input',value:'raw-secret-'+i})});
  socket.emit('Network.requestWillBeSent',{requestId:'burst',request:{url:'https://example.test',method:'GET',headers:{}}});
  for(let i=0;i<40;i++)socket.emit('Network.requestWillBeSentExtraInfo',{requestId:'burst',headers:{Authorization:'secret-'+i}});
  const events=await x.manager.listEvents({recording_id:s.id,limit:500});
  assert.equal(events.items.filter(e=>e.type==='interaction').length,100);
  const req=await x.manager.getRequest({recording_id:s.id,request_id:events.items.find(e=>e.type==='request').request_id});
  assert.equal(req.extra_request_headers.Authorization,'secret-39');
  assert.ok(renames<=3,`expected coalescing, got ${renames} atomic writes`);assert.equal(appends,1);
  assert.ok(socket.calls.filter(c=>c.method==='Target.setAutoAttach').every(c=>c.params.waitForDebuggerOnStart===false));
  const source=socket.calls.find(c=>c.method==='Page.addScriptToEvaluateOnNewDocument').params.source;
  assert.ok(!source.includes('innerText'));assert.ok(source.includes('count++<32'));
  await x.manager.stop({recording_id:s.id});const disk=JSON.parse(await fs.readFile(path.join(x.root,s.id,'summary.json'),'utf8'));assert.equal(disk.status,'stopped');assert.equal(disk.event_count,x.manager.get({recording_id:s.id}).event_count);
 }finally{t.mock.restoreAll();await x.cleanup();}
});

test('delete refuses active records, serializes reads, and removes only selected stopped data',async()=>{
 const x=await setup();try{
  const s=await x.manager.start({instance_id:'owned'});
  await assert.rejects(x.manager.delete({recording_id:s.id}),/Stop recording/);
  await assert.rejects(x.manager.delete({recording_id:'../escape'}),/not found/);
  await x.manager.stop({recording_id:s.id});
  x.manager.summaries.get(s.id).status='starting';
  await assert.rejects(x.manager.delete({recording_id:s.id}),/Stop recording/);
  x.manager.summaries.get(s.id).status='stopped';
  const other=await x.manager.start({instance_id:'owned'});await x.manager.stop({recording_id:other.id});
  const [events,result]=await Promise.all([x.manager.listEvents({recording_id:s.id}),x.manager.delete({recording_id:s.id})]);
  assert.ok(events.items.length);assert.deepEqual(result,{recording_id:s.id,deleted:true});
  assert.throws(()=>x.manager.get({recording_id:s.id}),/not found/);
  await assert.rejects(x.manager.listEvents({recording_id:s.id}),/not found/);
  await assert.rejects(fs.stat(path.join(x.root,s.id)),{code:'ENOENT'});
  assert.equal(x.manager.get({recording_id:other.id}).status,'stopped');
  const reopened=await new RecordingManager(x.repo,x.instances).open();assert.equal(reopened.list().total,1);await reopened.close();
 }finally{await x.cleanup();}
});

test('delete accepts interrupted records but refuses substituted roots and linked directories',async()=>{
 const x=await setup();const outside=await fs.mkdtemp(path.join(os.tmpdir(),'bf-recordings-outside-'));try{
  const s=await x.manager.start({instance_id:'owned'});await x.manager.finish(x.manager.active.get(s.id),'interrupted','test');
  const original=x.repo.recordingsRoot;x.repo.recordingsRoot=async()=>outside;
  await assert.rejects(x.manager.delete({recording_id:s.id}),/root changed/);x.repo.recordingsRoot=original;
  const dir=path.join(x.root,s.id),saved=path.join(x.root,s.id+'-saved');
  assert.equal(path.dirname(dir),x.root);await fs.rename(dir,saved);
  await fs.writeFile(path.join(outside,'sentinel'),'keep');await fs.symlink(outside,dir,'junction');
  await assert.rejects(x.manager.delete({recording_id:s.id}),/Unsafe/);
  assert.equal(await fs.readFile(path.join(outside,'sentinel'),'utf8'),'keep');
  assert.equal(path.dirname(dir),x.root);await fs.unlink(dir);await fs.rename(saved,dir);
  assert.deepEqual(await x.manager.delete({recording_id:s.id}),{recording_id:s.id,deleted:true});
 }finally{await x.cleanup();assert.ok(path.basename(outside).startsWith('bf-recordings-outside-'));await fs.rm(outside,{recursive:true,force:true});}
});
