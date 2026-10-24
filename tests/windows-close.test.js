import test from 'node:test';
import assert from 'node:assert/strict';
import {WindowsPlatform} from '../src/host/platform/windows.js';
const exe='C:\\Program Files\\Chrome\\chrome.exe',profile='C:\\flock\\test';
const runtime={executablePath:exe};
const proc=(pid,parentPid,commandLine)=>({pid,parentPid,commandLine,executablePath:exe,startTime:'2026-10-19T00:00:00Z'});
const root=proc(10,1,`chrome --user-data-dir=${profile}`);
const child=proc(11,10,`chrome --type=renderer --user-data-dir=${profile}`);
const instance={profilePath:profile,processIdentity:{...root,children:[child]}};

test('normal close signals only owned root even when children repeat profile argument',async()=>{
 const platform=new WindowsPlatform();let queries=0;const signals=[];
 platform.processes=async()=>++queries===1?[root,child,proc(20,1,'chrome')]:[];
 platform.powershell=async(body,input)=>{signals.push(input);return true;};
 const result=await platform.closeInstance(instance,runtime);
 assert.equal(result.status,'stopped');assert.equal(queries,2);
 assert.equal(signals.length,1);assert.equal(signals[0].force,false);
 assert.deepEqual(signals[0].targets.map(p=>p.pid),[10]);
});
test('normal close waits for transient orphan children to exit within its deadline',async()=>{
 const platform=new WindowsPlatform();let queries=0;const signals=[];
 platform.processes=async()=>{queries++;const orphan={...child,commandLine:'chrome --type=renderer'};return queries===1?[root,orphan]:queries===2?[orphan]:[];};
 platform.powershell=async(body,input)=>{signals.push(input);};
 const result=await platform.closeInstance(instance,runtime,{timeoutMs:1500});
 assert.equal(result.status,'stopped');assert.equal(queries,3);
 assert.equal(signals.length,1);assert.deepEqual(signals[0].targets.map(p=>p.pid),[10]);
});
test('post-signal unknown retains freshly observed child identity across retries',async()=>{
 const platform=new WindowsPlatform();let queries=0;const remembered=[];
 platform.processes=async(runtime,previous)=>{remembered.push(previous);queries++;return queries===1?[root,child]:queries<4?[{...child,executablePath:'C:\\other.exe'}]:[];};
 platform.powershell=async()=>{};
 const result=await platform.closeInstance({...instance,processIdentity:root},runtime,{timeoutMs:2000});
 assert.equal(result.status,'stopped');assert.equal(queries,4);
 for(const previous of remembered.slice(1))assert.deepEqual(previous.children.map(p=>p.pid),[11]);
});
test('persistent post-signal uncertainty remains unknown at the deadline without force escalation',async()=>{
 const platform=new WindowsPlatform();let queries=0;const signals=[];
 platform.processes=async()=>{const orphan={...child,commandLine:'chrome --type=renderer'};return ++queries===1?[root,orphan]:[orphan];};
 platform.powershell=async(body,input)=>{signals.push(input);};
 const result=await platform.closeInstance(instance,runtime,{timeoutMs:80});
 assert.equal(result.status,'unknown');assert.ok(queries>=2);
 assert.equal(signals.length,1);assert.equal(signals[0].force,false);
});
test('post-signal query failure can recover but never proves exit by itself',async()=>{
 const platform=new WindowsPlatform();let queries=0;
 platform.processes=async()=>{queries++;if(queries===2)throw Error('CIM temporarily unavailable');return queries===1?[root]:[];};
 platform.powershell=async()=>{};
 assert.equal((await platform.closeInstance(instance,runtime,{timeoutMs:1500})).status,'stopped');assert.equal(queries,3);
});
test('explicit force batches owned descendants and excludes unrelated browser',async()=>{
 const platform=new WindowsPlatform();let queries=0;const signals=[];
 platform.processes=async()=>++queries===1?[root,child,proc(20,1,'chrome')]:[];
 platform.powershell=async(body,input)=>{signals.push(input);};
 assert.equal((await platform.closeInstance(instance,runtime,{force:true})).status,'stopped');
 assert.equal(signals.length,1);assert.equal(signals[0].force,true);
 assert.deepEqual(signals[0].targets.map(p=>p.pid),[11,10]);
});
test('inaccessible browser evidence preserves unknown without signalling or second query',async()=>{
 const platform=new WindowsPlatform();let queries=0;
 platform.processes=async()=>{queries++;return [{pid:10,startTime:root.startTime,executablePath:null,commandLine:null}];};
 platform.powershell=async()=>assert.fail('must not signal or query again');
 assert.equal((await platform.closeInstance(instance,runtime)).status,'unknown');assert.equal(queries,1);
});
test('query failure cannot prove exit or trigger a signal',async()=>{
 const platform=new WindowsPlatform();platform.processes=async()=>{throw Error('CIM failed');};
 platform.powershell=async()=>assert.fail('must not signal');
 assert.equal((await platform.closeInstance(instance,runtime)).status,'unknown');
});
test('initial ownership query consumes timeout budget and cannot trigger late signal',async()=>{
 const platform=new WindowsPlatform();
 platform.processes=async()=>{await new Promise(resolve=>setTimeout(resolve,30));return [root];};
 platform.powershell=async()=>assert.fail('deadline already elapsed');
 assert.equal((await platform.closeInstance(instance,runtime,{timeoutMs:5})).status,'running');
});
test('process filter includes browser name and remembered PIDs, shell honors query budget',async()=>{
 let capture;
 const platform=new WindowsPlatform({executeCommand:async(exe,args,options)=>{capture={script:Buffer.from(args.at(-1),'base64').toString('utf16le'),options};return {stdout:'[]'};}});
 assert.deepEqual(await platform.processes(runtime,instance.processIdentity,{timeoutMs:123}),[]);
 const input=JSON.parse(Buffer.from(capture.script.match(/FromBase64String\('([^']+)'\)/)[1],'base64').toString());
 assert.equal(input.filter,"Name = 'chrome.exe' OR ProcessId = 10 OR ProcessId = 11");
 assert.equal(capture.options.timeout,123);
 assert.ok(capture.script.includes('@{n="name";e={$_.Name}}'));
});
test('remembered same-identity child outside executable match still prevents exit confirmation',async()=>{
 const platform=new WindowsPlatform();platform.processes=async()=>[{...child,executablePath:'C:\\other.exe'}];
 assert.equal((await platform.inspectInstance(instance,runtime)).status,'unknown');
});
