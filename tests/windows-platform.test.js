import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowsPlatform, profileInCommand } from '../src/host/platform/windows.js';
const exe='C:\\Program Files\\Chrome\\chrome.exe', profile='C:\\flock\\test';
const runtime={executablePath:exe};
const proc=(pid,parentPid,commandLine,startTime='2026-10-19T00:00:00Z')=>({pid,parentPid,commandLine,startTime,executablePath:exe});
const instance={profilePath:profile,processIdentity:null};
test('profile matching respects whole argv values and quoted spaces',()=>{
 assert.equal(profileInCommand('chrome --user-data-dir="C:\\Test Space\\Profile"','C:\\Test Space\\Profile'),true);
 assert.equal(profileInCommand('chrome --user-data-dir=C:\\flock\\test-other',profile),false);
 assert.equal(profileInCommand('firefox -profile "C:\\Test Space\\Profile"','C:\\Test Space\\Profile'),true);
});
test('other live browser tree does not prevent confirmation of stopped instance',async()=>{
 const platform=new WindowsPlatform(); platform.processes=async()=>[proc(10,1,'chrome'),proc(11,10,'chrome --type=renderer')];
 assert.equal((await platform.inspectInstance(instance,runtime)).status,'stopped');
});
test('orphan browser child keeps ownership unknown',async()=>{
 const platform=new WindowsPlatform(); platform.processes=async()=>[proc(11,10,'chrome --type=renderer')];
 assert.equal((await platform.inspectInstance(instance,runtime)).status,'unknown');
});
test('remembered surviving child prevents cleanup even with another live tree',async()=>{
 const child=proc(11,10,'chrome --type=renderer');
 const platform=new WindowsPlatform(); platform.processes=async()=>[proc(10,1,'chrome'),child];
 assert.equal((await platform.inspectInstance({...instance,processIdentity:{pid:90,startTime:'old',children:[child]}},runtime)).status,'unknown');
});
test('reboot PID reuse by protected non-browser processes does not block stopped state',async()=>{
  const root=proc(90,1,`chrome --user-data-dir=${profile}`),child=proc(91,90,'chrome --type=renderer');
  const platform=new WindowsPlatform();
  platform.processes=async()=>[90,91].map(pid=>({pid,name:'svchost.exe',startTime:'2026-10-21T00:00:00Z',executablePath:null,commandLine:null}));
  const result=await platform.inspectInstance({...instance,processIdentity:{...root,children:[child]}},runtime);
  assert.equal(result.status,'stopped');assert.deepEqual(result.processes,[]);
});
test('reused PID with a known different executable is unrelated even without command line',async()=>{
  const platform=new WindowsPlatform();platform.processes=async()=>[{pid:90,startTime:'2026-10-21T00:00:00Z',executablePath:'C:\\Windows\\system.exe',commandLine:null}];
  assert.equal((await platform.inspectInstance({...instance,processIdentity:proc(90,1,'chrome')},runtime)).status,'stopped');
});
test('PID reuse does not dismiss inaccessible browser or unproven process identity',async()=>{
  const platform=new WindowsPlatform(),old=proc(90,1,'chrome');
  for(const row of [
    {pid:90,name:'chrome.exe',startTime:'2026-10-21T00:00:00Z'},
    {pid:90,startTime:'2026-10-21T00:00:00Z'},
    {pid:90,name:'svchost.exe',startTime:null},
    {pid:90,name:'svchost.exe',startTime:'invalid'},
    {pid:90,name:'svchost.exe',startTime:old.startTime},
    {pid:92,name:'chrome.exe',startTime:'2026-10-21T00:00:00Z'},
  ]) {
    platform.processes=async()=>[row];
    assert.equal((await platform.inspectInstance({...instance,processIdentity:old},runtime)).status,'unknown',JSON.stringify(row));
  }
});
test('new browser process using the same profile remains running after PID reuse',async()=>{
  const platform=new WindowsPlatform(),old=proc(90,1,'chrome');
  const current=proc(90,1,`chrome --user-data-dir=${profile}`,'2026-10-21T00:00:00Z');
  platform.processes=async()=>[current];
  const result=await platform.inspectInstance({...instance,processIdentity:old},runtime);
  assert.equal(result.status,'running');assert.equal(result.processIdentity.startTime,current.startTime);
});
test('owned profile tree includes descendants but excludes unrelated browser',async()=>{
 const platform=new WindowsPlatform();platform.processes=async()=>[proc(10,1,`chrome --user-data-dir=${profile}`),proc(11,10,'chrome --type=renderer'),proc(20,1,'chrome')];
 const result=await platform.inspectInstance(instance,runtime);
 assert.equal(result.status,'running');assert.deepEqual(result.processes.map(p=>p.pid),[10,11]);
});
