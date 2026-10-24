import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeRegistry } from '../src/host/runtime-registry.js';
import { Operations } from '../src/host/operations.js';
import { startBackgroundUpdates } from '../src/host/index.js';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const memory=state=>({snapshot:()=>structuredClone(state),transaction:async fn=>fn(state)});

test('saved snapshot returns while signature discovery and instance queues are blocked; strict read-only args',async()=>{
  const gate=deferred();let checks=0;
  const repository=memory({runtimes:[{id:'chrome',browser:'chrome',executablePath:'C:\\Chrome\\chrome.exe',sources:['manual'],lastCheckedAt:'2025-01-01T00:00:00.000Z'}],instances:[{id:'work',status:'running'}],defaultRuntimeId:'chrome'});
  const registry=new RuntimeRegistry(repository,{platform:'win32',env:{},inspectExecutable:async()=>{checks++;await gate.promise;throw Error('unavailable');}});
  const scanning=registry.scan();
  const ops=new Operations(repository,registry,{list(){throw Error('snapshot must not reconcile');},exclusive(){throw Error('snapshot must not queue');}});
  const result=await ops.dispatch({action:'get_browser_flock_snapshot'});
  assert.equal(result.ok,true);assert.equal(result.data.instances[0].status,'running');assert.equal(result.data.default_runtime_id,'chrome');
  assert.equal(result.data.freshness.runtimes.state,'updating');assert.equal(result.data.freshness.instances.state,'pending');
  assert.ok(checks>0);assert.equal((await ops.dispatch({action:'get_browser_flock_snapshot',args:{refresh:true}})).ok,false);
  result.data.instances[0].status='deleted';assert.equal(repository.snapshot().instances[0].status,'running');
  gate.resolve();await scanning;
});

test('discovery deduplicates case-insensitive Windows paths and preserves sources; explicit refresh bypasses cache',async()=>{
  const repository=memory({runtimes:[{id:'old',browser:'chrome',name:'Custom',executablePath:'C:\\Browsers\\chrome.exe',sources:['manual']}],instances:[]});
  const counts=new Map();
  const platform={platform:'win32',env:{},additionalCandidates:async()=>[{browser:'chrome',path:'c:\\browsers\\CHROME.exe',source:'discovered'}],inspectExecutable:async candidate=>{
    const key=candidate.path.toLowerCase();counts.set(key,(counts.get(key)??0)+1);
    if(key!=='c:\\browsers\\chrome.exe')throw Error('missing');
    return {browser:'chrome',executablePath:'C:\\Browsers\\chrome.exe',available:true};
  }};
  const registry=new RuntimeRegistry(repository,platform);await registry.scan();
  assert.equal(counts.get('c:\\browsers\\chrome.exe'),1);
  const found=registry.list().find(x=>x.available);assert.deepEqual(found.sources.sort(),['discovered','manual']);
  assert.equal(registry.freshness().state,'current');assert.ok(registry.freshness().last_checked_at);
  await registry.scan();assert.equal(counts.get('c:\\browsers\\chrome.exe'),1);
  await registry.scan({refresh:true});assert.equal(counts.get('c:\\browsers\\chrome.exe'),2);
});

test('background worker starts after mount, does not overlap, and disposal waits for recovery and scan',async()=>{
  const recovery=deferred(),scan=deferred(),timers=[],events=[],status={state:'pending',last_checked_at:null};
  const stop=startBackgroundUpdates({scan:()=>{events.push('scan');return scan.promise;}},{recover:()=>{events.push('recover');return recovery.promise;}},status,{schedule:(fn,delay)=>{timers.push({fn,delay});return timers.length;},cancel:id=>events.push(['cancel',id])});
  assert.deepEqual(events,[]);assert.equal(timers[0].delay,0);timers[0].fn();
  assert.deepEqual(events,['scan','recover']);assert.equal(status.state,'updating');assert.equal(timers.length,1);
  let stopped=false;const stopping=stop().then(()=>stopped=true);await flush();assert.equal(stopped,false);
  recovery.resolve();await flush();assert.equal(stopped,false);scan.resolve();await stopping;
  assert.equal(status.state,'current');assert.ok(status.last_checked_at);assert.equal(timers.length,1);
});

test('periodic worker reconciles active instances only, reports errors honestly and retries without overlapping',async()=>{
  const timers=[],status={state:'pending',last_checked_at:null},errors=[],seen=[];
  const instances={recover:async()=>{throw Error('recovery failed');},list:()=>[{id:'run',status:'running'},{id:'stop',status:'stopped'},{id:'cleanup',status:'cleanup_pending'}],reconcile:async id=>seen.push(id)};
  const stop=startBackgroundUpdates({scan:async()=>[]},instances,status,{schedule:(fn,delay)=>{timers.push({fn,delay});return timers.length;},cancel:()=>{},onError:error=>errors.push(error.message)});
  timers[0].fn();await flush();assert.equal(status.state,'error');assert.equal(status.last_checked_at,null);assert.deepEqual(errors,['recovery failed']);
  assert.equal(timers[1].delay,2000);timers[1].fn();await flush();assert.deepEqual(seen,['run','cleanup']);assert.equal(status.state,'current');await stop();
});
