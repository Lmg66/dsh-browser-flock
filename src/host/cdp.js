import fs from 'node:fs/promises';
import path from 'node:path';

/** Send one bounded command to a previously verified owned browser endpoint. */
export async function cdpCommand(endpoint,method,params={}, {WebSocketImpl=WebSocket,timeoutMs=8000}={}) {
  const address=new URL(endpoint?.websocket_url);
  if(endpoint?.status!=='ready'||address.protocol!=='ws:'||address.hostname!=='127.0.0.1'||address.username||address.password||!/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(address.pathname)) throw new Error('A verified local browser connection is required.');
  return new Promise((resolve,reject)=>{
    let done=false,socket;
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);try{socket?.close();}catch{};error?reject(error):resolve(value);};
    const timer=setTimeout(()=>finish(new Error('Browser command timed out.')),timeoutMs);
    try {
      socket=new WebSocketImpl(address.href);
      socket.addEventListener('open',()=>socket.send(JSON.stringify({id:1,method,params})));
      socket.addEventListener('error',()=>finish(new Error('Browser connection failed.')));
      socket.addEventListener('close',()=>finish(new Error('Browser connection closed before completion.')));
      socket.addEventListener('message',event=>{
        if(typeof event.data!=='string'||event.data.length>1048576){finish(new Error('Invalid browser response.'));return;}
        try {const reply=JSON.parse(event.data);if(reply.id!==1)return;if(reply.error)finish(new Error(String(reply.error.message||'Browser rejected the command.')));else finish(null,reply.result??{});}catch(error){finish(error);}
      });
    } catch(error){finish(error);}
  });
}
export async function loadUnpackedExtension(endpoint,extensionPath,options) {
  if(typeof extensionPath!=='string'||!path.isAbsolute(extensionPath)) throw new Error('Extension package path must be absolute.');
  const result=await cdpCommand(endpoint,'Extensions.loadUnpacked',{path:extensionPath},options);
  if(typeof result.id!=='string'||!/^([a-p]{32})$/.test(result.id)) throw new Error('Browser did not confirm a valid extension ID.');
  return result;
}

/** Chromium's experimental Extensions.uninstall supports unpacked extensions only. */
export async function uninstallExtension(endpoint,extensionId,options) {
  if(typeof extensionId!=='string'||! /^[a-p]{32}$/.test(extensionId)) throw new Error('A confirmed extension ID is required.');
  return cdpCommand(endpoint,'Extensions.uninstall',{id:extensionId},options);
}

/** Discover only the currently owned browser's loopback endpoint. Never persist ephemeral ports. */
export async function discoverCdp(instance, runtime, {fetchImpl=fetch}={}) {
  if(runtime.browser==='firefox') return {supported:false,enabled:false,status:'unsupported'};
  if(!instance.cdpEnabled) return {supported:true,enabled:false,status:instance.status==='running'?'restart_required':'disabled'};
  if(instance.status!=='running') return {supported:true,enabled:true,status:'stopped'};
  const pending={supported:true,enabled:true,status:'not_ready'};
  try {
    const file=path.join(instance.profilePath,'DevToolsActivePort');
    const stat=await fs.lstat(file);
    if(!stat.isFile() || stat.isSymbolicLink() || stat.size>1024 || stat.mtimeMs+1000<Date.parse(instance.processIdentity.startTime)) return pending;
    const [portText,wsPath]= (await fs.readFile(file,'utf8')).trim().split(/\r?\n/);
    if(!/^\d{1,5}$/.test(portText) || +portText<1 || +portText>65535 || !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(wsPath)) return pending;
    const http_endpoint=`http://127.0.0.1:${+portText}`;
    const response=await fetchImpl(`${http_endpoint}/json/version`,{signal:AbortSignal.timeout(1500),redirect:'error'});
    if(!response.ok) return pending;
    const body=await response.text();
    if(body.length>65536) return pending;
    const version=JSON.parse(body), socket=new URL(version.webSocketDebuggerUrl);
    if(socket.protocol!=='ws:' || !['127.0.0.1','localhost','[::1]'].includes(socket.hostname) || +socket.port!==+portText || socket.pathname!==wsPath || socket.username || socket.password || socket.search || socket.hash) return pending;
    return {supported:true,enabled:true,status:'ready',http_endpoint,websocket_url:`ws://127.0.0.1:${+portText}${wsPath}`,browser:version.Browser??null,protocol_version:version['Protocol-Version']??null};
  } catch { return pending; }
}
