import {mkdtemp,rm,realpath} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {Repository} from '../src/host/repository.js';
import {RuntimeRegistry} from '../src/host/runtime-registry.js';
import {InstanceManager} from '../src/host/instance-manager.js';
import {WindowsPlatform} from '../src/host/platform/windows.js';
const root=await mkdtemp(path.join(os.tmpdir(),'browser-flock-proxy-qa-'));
const repository=await new Repository(root).open();
const platform=new WindowsPlatform();
const runtimes=new RuntimeRegistry(repository,platform);
const manager=new InstanceManager(repository,runtimes,platform);
let instance,clean=false,seen=false;
const proxy=http.createServer((req,res)=>{if(req.url==='http://browser-flock-proxy-test.invalid/probe')seen=true;res.writeHead(200,{'Content-Type':'text/plain'});res.end('Browser Flock local proxy verification');});
proxy.on('connection',socket=>socket.on('error',()=>{}));
proxy.on('connect',(req,socket)=>socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
try {
 const browser=process.argv[2]??'chrome';
 const paths={chrome:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',edge:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',brave:'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',firefox:'C:\\Program Files\\Mozilla Firefox\\firefox.exe'};
 const runtime=await runtimes.register({browser,path:paths[browser]});
 ({instance}=await manager.open({runtime_id:runtime.id,name:'Proxy verification',mode:'ephemeral',proxy:{mode:'http',host:'127.0.0.1',port:proxy.address().port},url:'http://browser-flock-proxy-test.invalid/probe'}));
 const deadline=Date.now()+10000;
 while(!seen && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,200));
 if(!seen)throw Error('Test navigation did not reach local proxy');
 console.log(JSON.stringify({proxyRequestObserved:seen,mode:instance.proxy?.mode}));
} catch(error){console.error(error);process.exitCode=1;}
finally {
 if(instance){try{const result=await manager.close(instance.id,{timeout_ms:15000});clean=result.instance.status==='deleted';console.log(JSON.stringify({cleanup:result.instance.status}));}catch(error){console.error(error);process.exitCode=1;}}
 proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));
 await platform.dispose();await repository.close();
 if(clean){if(await realpath(root)!==root||!path.basename(root).startsWith('browser-flock-proxy-qa-'))throw Error('Unexpected cleanup path');await rm(root,{recursive:true});}else console.log(JSON.stringify({retained:root}));
}
