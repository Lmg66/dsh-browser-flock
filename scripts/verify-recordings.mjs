import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {Repository} from '../src/host/repository.js';
import {RuntimeRegistry} from '../src/host/runtime-registry.js';
import {InstanceManager} from '../src/host/instance-manager.js';
import {WindowsPlatform} from '../src/host/platform/windows.js';
import {RecordingManager} from '../src/host/recordings.js';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'bf-recording-live-'));
const repository=await new Repository(root).open(),platform=new WindowsPlatform(),runtimes=new RuntimeRegistry(repository,platform),manager=new InstanceManager(repository,runtimes,platform),recordings=await new RecordingManager(repository,manager).open();
const server=http.createServer((req,res)=>{if(req.url==='/api'){let data='';req.on('data',c=>data+=c);req.on('end',()=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,received:data}));});}else{res.setHeader('content-type','text/html');res.end('<input id="field"><button id="go" onclick="fetch(\'/api\',{method:\'POST\',headers:{Authorization:\'Bearer fixture-secret\'},body:document.querySelector(\'#field\').value}).then(r=>r.json()).then(v=>document.title=\'done\')">Send</button><iframe src="/frame"></iframe>'.replace(req.url==='/frame'?'<iframe src="/frame"></iframe>':'NO_REPLACE',''));}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let instance,socket;const pending=new Map();let next=0;
const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timed out'));},8000);pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});socket.send(JSON.stringify({id,method,params,sessionId}));});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const browser=process.argv[2]??'chrome';
const paths={chrome:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',edge:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',brave:'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'};
try{const rt=await runtimes.register({browser,path:paths[browser]});instance=(await manager.open({runtime_id:rt.id,name:'Recording isolated QA',mode:'persistent',proxy:{mode:'direct'}})).instance;
const s=await recordings.start({instance_id:instance.id});const ep=await manager.getCdp(instance.id);socket=new WebSocket(ep.websocket_url);socket.addEventListener('message',e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}});await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
const {targetId}=await call('Target.createTarget',{url:'http://127.0.0.1:'+server.address().port+'/'});const {sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});
for(let i=0;i<30;i++){const r=await call('Runtime.evaluate',{expression:'!!document.querySelector("#go")',returnByValue:true},sessionId);if(r.result.value)break;await delay(100);}
for(let i=0;i<50;i++){const events=await recordings.listEvents({recording_id:s.id,limit:500});if(events.items.some(e=>e.type==='target_attached'&&e.target_id===targetId))break;await delay(100);}
await call('Page.navigate',{url:'http://127.0.0.1:'+server.address().port+'/?ready=1'},sessionId);await delay(500);
await call('Runtime.evaluate',{expression:'document.querySelector("#field").value="fixture-password";document.querySelector("#field").dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#go").click()',returnByValue:true},sessionId);
for(let i=0;i<30;i++){const r=await call('Runtime.evaluate',{expression:'document.title',returnByValue:true},sessionId);if(r.result.value==='done')break;await delay(100);}
await delay(250);const stopped=await recordings.stop({recording_id:s.id});const events=await recordings.listEvents({recording_id:s.id,limit:500});const row=events.items.find(e=>e.type==='request'&&e.url?.endsWith('/api'));assert.ok(row,'HTTP POST must be recorded');const detail=await recordings.getRequest({recording_id:s.id,request_id:row.request_id});assert.equal(detail.request_body.data,'fixture-password');assert.match(detail.response_body.data,/fixture-password/);assert.equal(detail.headers.Authorization,'Bearer fixture-secret');assert.ok(events.items.some(e=>e.action?.type==='click'));assert.ok(events.items.some(e=>e.action?.type==='input'));assert.ok(events.items.some(e=>e.type==='navigation'));await recordings.close();const again=await new RecordingManager(repository,manager).open();assert.equal((await again.getRequest({recording_id:s.id,request_id:row.request_id})).response_body.data,detail.response_body.data);await again.close();console.log(JSON.stringify({success:true,recording_id:s.id,event_count:stopped.event_count,request_count:stopped.request_count,rawCredentials:true,input:true,click:true,body:true,persistence:true,root}));
}finally{socket?.close();for(const p of pending.values())p.reject(Error('closed'));await recordings.close();if(instance){const closed=await manager.close(instance.id,{timeout_ms:15000});if(closed.instance.status==='stopped')await manager.delete(instance.id);else console.error('QA browser cleanup incomplete',instance.id,root);}await new Promise(resolve=>server.close(resolve));await platform.dispose();await repository.close();}
