import test from 'node:test';
import assert from 'node:assert/strict';
import {windowIdentityPayload} from '../src/host/platform/window-identity.js';
const runtime={executablePath:'C:\\Browser\\chrome.exe'};
const instance={id:'12345678-1234-4234-9234-123456789abc',profilePath:'C:\\Owned profile\\12345678',processIdentity:{pid:123,startTime:'2026-10-20T01:00:00.0000000Z',executablePath:runtime.executablePath,commandLine:'"C:\\Browser\\chrome.exe" "--user-data-dir=C:\\Owned profile\\12345678"'}};
test('window identity is instance-specific, deterministic artwork and fresh request token',()=>{
 const a=windowIdentityPayload(instance,runtime),b=windowIdentityPayload(instance,runtime);
 assert.equal(a.appId,`BrowserFlock.Instance.${instance.id}`);assert.equal(a.color,b.color);assert.equal(a.label,b.label);assert.notEqual(a.requestId,b.requestId);
 const c=windowIdentityPayload({...instance,id:'87654321-1234-4234-9234-123456789abc'},runtime);assert.notEqual(a.appId,c.appId);assert.notEqual(a.label,c.label);
});
test('window identity rejects absent or mismatched process evidence',()=>{
 for(const patch of [{processIdentity:null},{processIdentity:{...instance.processIdentity,pid:0}},{processIdentity:{...instance.processIdentity,executablePath:'C:\\Other\\chrome.exe'}},{processIdentity:{...instance.processIdentity,commandLine:'chrome.exe --user-data-dir=C:\\Personal'}}])assert.throws(()=>windowIdentityPayload({...instance,...patch},runtime));
});
test('window identity requires exact profile argv match, rejects prefix collisions and traversal IDs',()=>{
 assert.throws(()=>windowIdentityPayload({...instance,profilePath:instance.profilePath.slice(0,-1)},runtime));
 assert.throws(()=>windowIdentityPayload({...instance,id:'../../escape'},runtime));
 assert.throws(()=>windowIdentityPayload({...instance,profilePath:'relative'},runtime));
});
