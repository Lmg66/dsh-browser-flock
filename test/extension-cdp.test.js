import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {cdpCommand,loadUnpackedExtension} from '../src/host/cdp.js';
const endpoint={status:'ready',websocket_url:'ws://127.0.0.1:12345/devtools/browser/test'};
class Socket extends EventTarget {
 static response={id:1,result:{id:'a'.repeat(32)}};
 constructor(){super();queueMicrotask(()=>this.dispatchEvent(new Event('open')));}
 send(text){this.sent=JSON.parse(text);Socket.sent=this.sent;queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(Socket.response)})));}
 close(){this.closed=true;}
}
test('extension loading validates owned endpoint and propagates browser acceptance/rejection',async()=>{
 await assert.rejects(cdpCommand({...endpoint,websocket_url:'ws://example.com/devtools/browser/test'},'Extensions.loadUnpacked'),/verified local/);
 const result=await loadUnpackedExtension(endpoint,path.resolve('fixture-extension'),{WebSocketImpl:Socket});
 assert.equal(result.id,'a'.repeat(32));assert.equal(Socket.sent.method,'Extensions.loadUnpacked');assert.deepEqual(Socket.sent.params,{path:path.resolve('fixture-extension')});
 Socket.response={id:1,error:{message:'Extension manifest is invalid'}};
 await assert.rejects(loadUnpackedExtension(endpoint,path.resolve('fixture-extension'),{WebSocketImpl:Socket}),/manifest is invalid/);
 Socket.response={id:1,result:{}};
 await assert.rejects(loadUnpackedExtension(endpoint,path.resolve('fixture-extension'),{WebSocketImpl:Socket}),/did not confirm/);
});
test('extension browser commands have bounded response wait',async()=>{
 class Silent extends Socket {send(){}}
 await assert.rejects(cdpCommand(endpoint,'Extensions.loadUnpacked',{}, {WebSocketImpl:Silent,timeoutMs:5}),/timed out/);
});
