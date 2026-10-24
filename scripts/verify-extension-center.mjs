import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {generateKeyPairSync,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {Repository} from '../src/host/repository.js';
import {RuntimeRegistry} from '../src/host/runtime-registry.js';
import {InstanceManager} from '../src/host/instance-manager.js';
import {WindowsPlatform} from '../src/host/platform/windows.js';
import {ExtensionLibrary} from '../src/host/extensions.js';
import {loadUnpackedExtension} from '../src/host/cdp.js';
const root=await mkdtemp(path.join(os.tmpdir(),'browser-flock-extension-center-qa-'));
const repository=await new Repository(root).open(),platform=new WindowsPlatform();
const runtimes=new RuntimeRegistry(repository,platform),manager=new InstanceManager(repository,runtimes,platform);
const library=new ExtensionLibrary(repository,runtimes,manager);manager.extensionLibrary=library;
const results=[];let safe=true;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function endpoint(instance){let ep;for(let i=0;i<20;i++){ep=await manager.getCdp(instance.id);if(ep.status==='ready')return ep;await delay(250);}throw Error(`CDP ${ep?.status}`);}
async function connection(instance){
 const ep=await endpoint(instance),socket=new WebSocket(ep.websocket_url),pending=new Map();let next=0;
 socket.addEventListener('message',event=>{const v=JSON.parse(event.data),p=pending.get(v.id);if(p){pending.delete(v.id);clearTimeout(p.timer);v.error?p.reject(Error(JSON.stringify(v.error))):p.resolve(v.result);}});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{socket.close();reject(Error('CDP open timeout'));},5000);socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});socket.addEventListener('error',()=>{clearTimeout(timer);reject(Error('CDP error'));},{once:true});});
 return {call(method,params={},sessionId){const id=++next;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error(`Timeout ${method}`));},7000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});},close(){socket.close();for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Closed'));}pending.clear();}};
}
async function evidence(instance,id,setValue){
 const c=await connection(instance);let target;
 try{
  target=await c.call('Target.createTarget',{url:`chrome-extension://${id}/proof.html`});const {sessionId}=await c.call('Target.attachToTarget',{targetId:target.targetId,flatten:true});let proof;
  for(let n=0;n<16;n++){const r=await c.call('Runtime.evaluate',{expression:'JSON.stringify({url:location.href,text:document.body?.innerText,id:globalThis.chrome?.runtime?.id})',returnByValue:true},sessionId);proof=JSON.parse(r.result.value??'null');if(proof?.text==='EXTENSION_CENTER_PROOF')break;await delay(250);}
  assert.equal(proof?.text,'EXTENSION_CENTER_PROOF',JSON.stringify(proof));assert.equal(proof.id,id);
  const before=await c.call('Runtime.evaluate',{expression:'localStorage.getItem("owner")',returnByValue:true},sessionId);
  if(setValue!==undefined)await c.call('Runtime.evaluate',{expression:`localStorage.setItem("owner",${JSON.stringify(setValue)})`,returnByValue:true},sessionId);
  const after=await c.call('Runtime.evaluate',{expression:'localStorage.getItem("owner")',returnByValue:true},sessionId);
  return {...proof,ownerBefore:before.result.value??null,ownerAfter:after.result.value??null};
 }finally{if(target)await c.call('Target.closeTarget',{targetId:target.targetId}).catch(()=>{});c.close();}
}
try{
 for(const [browser,executable] of [['chrome','C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],['edge','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'],['brave','C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe']]){
  const row={browser};results.push(row);const owned=[];
  try{
   const runtime=await runtimes.register({browser,path:executable});row.version=runtime.version;
   const a=(await manager.open({runtime_id:runtime.id,name:'Extension source QA',mode:'persistent',proxy:{mode:'direct'}})).instance;owned.push(a);
   const key=generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({type:'spki',format:'der'});
   const extensionId=[...createHash('sha256').update(key).digest().subarray(0,16)].map(b=>String.fromCharCode(97+(b>>4),97+(b&15))).join('');
   const source=path.join(a.profilePath,'Default','Extensions',extensionId,'1.0_0');await mkdir(source,{recursive:true});
   await writeFile(path.join(source,'manifest.json'),JSON.stringify({manifest_version:3,name:'Extension Center Owned QA',version:'1.0',key:key.toString('base64'),permissions:['storage'],action:{default_popup:'proof.html'}}));
   await writeFile(path.join(source,'proof.html'),'<!doctype html><meta charset="utf-8"><title>Owned extension center QA</title><body>EXTENSION_CENTER_PROOF</body>');
   row.sourceLoad=await loadUnpackedExtension(await endpoint(a),source);assert.equal(row.sourceLoad.id,extensionId);
   row.sourceInitial=await evidence(a,extensionId,'A');assert.equal(row.sourceInitial.ownerBefore,null);
   row.scanned=await library.listInstalled(a.id);assert.ok(row.scanned.items.some(e=>e.extension_id===extensionId));
   const entry=await library.capture({instance_id:a.id,extension_id:extensionId,source_profile:'Default'});row.captured=entry;
   let b=(await manager.open({runtime_id:runtime.id,name:'Extension destination QA',mode:'persistent',proxy:{mode:'direct'}})).instance;owned.push(b);
   row.install=await manager.installExtension({instance_id:b.id,library_id:entry.id});
   row.destinationInitial=await evidence(b,extensionId,'B');assert.equal(row.destinationInitial.ownerBefore,null);assert.equal(row.destinationInitial.ownerAfter,'B');
   row.destinationClose=(await manager.close(b.id,{timeout_ms:15000})).instance.status;assert.equal(row.destinationClose,'stopped');
   b=(await manager.open({instance_id:b.id})).instance;row.destinationReopened=await evidence(b,extensionId);assert.equal(row.destinationReopened.ownerBefore,'B');
   row.sourceAfter=await evidence(a,extensionId);assert.equal(row.sourceAfter.ownerBefore,'A');row.success=true;
  }catch(error){row.error=error.stack;process.exitCode=1;}
  finally{
   row.cleanup=[];for(const item of owned.reverse()){try{const current=manager.get(item.id);if(current.status!=='stopped'){const closed=await manager.close(item.id,{timeout_ms:15000});assert.equal(closed.instance.status,'stopped');}await manager.delete(item.id);row.cleanup.push({id:item.id,deleted:true});}catch(error){safe=false;process.exitCode=1;row.cleanup.push({id:item.id,error:error.message});}}
  }
  console.log(JSON.stringify(row));
 }
}finally{
 await platform.dispose();await repository.close();
 await writeFile(new URL('./verify-extension-center-result.json',import.meta.url),JSON.stringify({root,results,safe},null,2));
 if(safe){if(await realpath(root)!==root||!path.basename(root).startsWith('browser-flock-extension-center-qa-'))throw Error('Unexpected cleanup path');await rm(root,{recursive:true});console.log('Owned extension center test root cleaned');}else console.log(`Retained test root: ${root}`);
}
