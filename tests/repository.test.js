import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {writeFileSync, renameSync} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Repository } from '../src/host/repository.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const markerName = '.browser-flock-owner.json';
async function fixture(t) {
  // All writes/deletes are confined to an exclusively allocated test fixture.
  const base = await fs.mkdtemp(path.join(testDirectory, '.repository-test-'));
  const root = path.join(base, 'repository');
  const repository = new Repository(root);
  t.after(async () => {
    await repository.close();
    assert.equal(path.dirname(base), testDirectory);
    assert.ok(path.basename(base).startsWith('.repository-test-'));
    await fs.rm(base, { recursive: true, force: true });
  });
  await repository.open();
  return { base, root, repository };
}

async function linkDirectory(target, link) {
  await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

test('exclusive lock rejects another live repository and permits reopening after close', async t => {
  const { root, repository } = await fixture(t);
  const second = new Repository(root);
  await assert.rejects(second.open(), { code: 'REPOSITORY_LOCKED' });
  await second.close();
  assert.ok(await fs.stat(path.join(root, 'repository.lock')));
  await repository.close();
  await second.open();
  await second.close();
  assert.equal((await fs.readdir(root)).includes('repository.recovery.lock'), false);
});

test('actual crashed process lock is recovered and committed data survives', async t => {
  const { root, repository } = await fixture(t);
  await repository.transaction(state => { state.requests.preserved = true; });
  await repository.close();
  const moduleURL = new URL('../src/host/repository.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {Repository} from ${JSON.stringify(moduleURL)}; await new Repository(${JSON.stringify(root)}).open(); process.exit(0);`], {stdio:'inherit'});
  assert.equal(await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);}),0);
  const before = JSON.parse(await fs.readFile(path.join(root,'repository.lock'),'utf8'));
  assert.equal(before.pid,child.pid);
  await repository.open();
  assert.equal(repository.snapshot().requests.preserved,true);
  const after = JSON.parse(await fs.readFile(path.join(root,'repository.lock'),'utf8'));
  assert.equal(after.pid,process.pid);assert.notEqual(after.token,before.token);
});

test('only ESRCH permits recovery: reused live PID, EPERM and unknown errors preserve lock', async t => {
  const {root,repository}=await fixture(t);await repository.close();
  const lock=path.join(root,'repository.lock');
  const text=JSON.stringify({token:randomUUID(),pid:process.pid});
  await fs.writeFile(lock,text,{flag:'wx'});
  for(const code of [null,'EPERM','EINVAL']) {
    const mock=t.mock.method(process,'kill',(pid,signal)=>{assert.equal(pid,process.pid);assert.equal(signal,0);if(code)throw Object.assign(new Error(code),{code});return true;});
    try {await assert.rejects(repository.open(),{code:'REPOSITORY_LOCKED'});assert.equal(await fs.readFile(lock,'utf8'),text);assert.equal((await fs.readdir(root)).includes('repository.recovery.lock'),false);}
    finally {mock.mock.restore();}
  }
});

test('malformed and incomplete locks remain blocked without probing arbitrary PIDs', async t => {
  const {root,repository}=await fixture(t);await repository.close();
  const lock=path.join(root,'repository.lock');
  const mock=t.mock.method(process,'kill',()=>{throw new Error('must not probe');});
  for(const text of ['', '{', 'null', JSON.stringify({token:randomUUID(),pid:0}),JSON.stringify({token:randomUUID(),pid:-1}),JSON.stringify({token:randomUUID(),pid:'123'}),JSON.stringify({pid:123}),JSON.stringify({token:randomUUID(),pid:1.5})]) {
    await fs.writeFile(lock,text);
    await assert.rejects(repository.open(),{code:'REPOSITORY_LOCKED'});
    assert.equal(await fs.readFile(lock,'utf8'),text);
  }
  assert.equal(mock.mock.callCount(),0);
});

test('concurrent dead-owner reclaimers elect one writer and preserve its new lock', async t => {
  const {root,repository}=await fixture(t);await repository.close();
  const lock=path.join(root,'repository.lock');
  await fs.writeFile(lock,JSON.stringify({token:randomUUID(),pid:99999999}));
  const originalKill=process.kill;
  t.mock.method(process,'kill',(pid,signal)=>{if(pid===99999999)throw Object.assign(new Error('dead'),{code:'ESRCH'});return originalKill(pid,signal);});
  const contenders=Array.from({length:12},()=>new Repository(root));
  t.after(async()=>{for(const contender of contenders)await contender.close();});
  const results=await Promise.allSettled(contenders.map(r=>r.open()));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  for(const result of results.filter(r=>r.status==='rejected'))assert.equal(result.reason.code,'REPOSITORY_LOCKED');
  const winner=results.find(r=>r.status==='fulfilled').value;
  await winner.transaction(state=>{state.requests.winner=true;});
  assert.equal(winner.snapshot().requests.winner,true);
  await winner.close();
});

test('recovery re-reads token and file identity before unlinking a changed lock', async t => {
  const {root,repository}=await fixture(t);await repository.close();
  const lock=path.join(root,'repository.lock');
  for(const replaceFile of [false,true]) {
    const original=JSON.stringify({token:randomUUID(),pid:99999999});
    const replacement=JSON.stringify({token:randomUUID(),pid:process.pid});
    await fs.writeFile(lock,original);
    const mock=t.mock.method(process,'kill',()=>{
      if(replaceFile)renameSync(lock,path.join(root,'displaced.lock'));
      writeFileSync(lock,replacement);
      throw Object.assign(new Error('dead'),{code:'ESRCH'});
    });
    try {await assert.rejects(repository.open(),{code:'REPOSITORY_LOCKED'});assert.equal(await fs.readFile(lock,'utf8'),replacement);}
    finally {mock.mock.restore();}
  }
});

test('an abandoned recovery gate blocks acquisition without deleting either lock', async t => {
  const {root,repository}=await fixture(t);await repository.close();
  const gate=path.join(root,'repository.recovery.lock');
  await fs.writeFile(gate,'abandoned');
  await assert.rejects(repository.open(),{code:'REPOSITORY_LOCKED'});
  assert.equal(await fs.readFile(gate,'utf8'),'abandoned');
});

test('lock collision is enforced across Node processes', async t => {
  const { root } = await fixture(t);
  const moduleURL = new URL('../src/host/repository.js', import.meta.url).href;
  const script = `import { Repository } from ${JSON.stringify(moduleURL)};
    try { await new Repository(${JSON.stringify(root)}).open(); process.exitCode = 2; }
    catch (error) { process.exitCode = error.code === 'REPOSITORY_LOCKED' ? 0 : 3; }`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 0);
});

test('close preserves a replacement lock it does not own', async t => {
  const { root, repository } = await fixture(t);
  const lock = path.join(root, 'repository.lock');
  await fs.rename(lock, path.join(root, 'original.lock'));
  const replacement = JSON.stringify({ token: randomUUID() });
  await fs.writeFile(lock, replacement, { flag: 'wx' });
  await assert.rejects(repository.transaction(state => { state.defaultRuntimeId = 'bad'; }), { code: 'LOCK_LOST' });
  await repository.close();
  assert.equal(await fs.readFile(lock, 'utf8'), replacement);
});

test('atomic snapshots persist and reopen with clone isolation', async t => {
  const { root, repository } = await fixture(t);
  assert.deepEqual(repository.snapshot(), { schemaVersion: 1, extensionLibrary: [], proxyPresets: [], runtimes: [], instances: [], defaultRuntimeId: null, requests: {}, tombstones: [] });
  let retained;
  assert.equal(await repository.transaction(state => {
    retained = state;
    state.runtimes.push({ id: 'runtime', browser: 'edge' });
    state.defaultRuntimeId = 'runtime';
    state.requests.request = { instanceId: 'instance' };
    return 'result';
  }), 'result');
  retained.runtimes[0].browser = 'changed';
  const snapshot = repository.snapshot();
  snapshot.runtimes[0].browser = 'also changed';
  assert.equal(repository.snapshot().runtimes[0].browser, 'edge');
  const committed = repository.snapshot();
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'state.json'), 'utf8')), committed);
  await repository.close();
  await repository.open();
  assert.deepEqual(repository.snapshot(), committed);
  assert.equal((await fs.readdir(root)).filter(name => name.endsWith('.tmp')).length, 0);
});

test('mutator and serialization failures roll back and do not poison the queue', async t => {
  const { root, repository } = await fixture(t);
  const before = repository.snapshot();
  const disk = await fs.readFile(path.join(root, 'state.json'), 'utf8');
  await assert.rejects(repository.transaction(async state => {
    state.instances.push({ id: 'discard' });
    throw new Error('mutator failed');
  }), /mutator failed/);
  await assert.rejects(repository.transaction(state => { state.requests.big = 1n; }), /BigInt/);
  await assert.rejects(repository.transaction(state => { state.schemaVersion = 2; }), { code: 'INVALID_STATE' });
  assert.deepEqual(repository.snapshot(), before);
  assert.equal(await fs.readFile(path.join(root, 'state.json'), 'utf8'), disk);
  await repository.transaction(state => { state.requests.success = true; });
  assert.equal(repository.snapshot().requests.success, true);
});

test('failed atomic rename leaves in-memory state unchanged', async t => {
  const { root, repository } = await fixture(t);
  const before = repository.snapshot();
  const target = path.join(root, 'state.json');
  await fs.rename(target, path.join(root, 'saved-state.json'));
  await fs.mkdir(target);
  await assert.rejects(repository.transaction(state => { state.requests.uncommitted = true; }));
  assert.deepEqual(repository.snapshot(), before);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'saved-state.json'), 'utf8')), before);
  assert.equal((await fs.readdir(root)).filter(name => name.endsWith('.tmp')).length, 0);
});

test('asynchronous transactions serialize; close waits for queued work', async t => {
  const { repository } = await fixture(t);
  let enter;
  const entered = new Promise(resolve => { enter = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const events = [];
  const first = repository.transaction(async state => {
    events.push('first:start'); enter(); await gate;
    state.requests.count = 1; events.push('first:end');
  });
  await entered;
  const second = repository.transaction(state => {
    events.push('second'); state.requests.count += 1;
  });
  const closing = repository.close();
  assert.deepEqual(events, ['first:start']);
  release();
  await Promise.all([first, second, closing]);
  assert.deepEqual(events, ['first:start', 'first:end', 'second']);
  await repository.open();
  assert.equal(repository.snapshot().requests.count, 2);
});

test('createProfile is exclusive and ownership survives reopening', async t => {
  const { repository } = await fixture(t);
  const id = randomUUID();
  const target = await repository.createProfile(id);
  assert.equal(target, repository.profilePath(id));
  await fs.mkdir(path.join(target, 'Default'));
  await fs.writeFile(path.join(target, 'Default', 'data'), 'fixture data');
  await assert.rejects(repository.createProfile(id));
  await repository.close(); await repository.open();
  await repository.removeProfile(id);
  await assert.rejects(fs.lstat(target), { code: 'ENOENT' });
});

test('UUID validation rejects traversal and arbitrary paths', async t => {
  const { repository } = await fixture(t);
  for (const id of ['..', '../outside', 'a/b', 'a\\b', 'C:\\Users', '', randomUUID() + '/..', null]) {
    assert.throws(() => repository.profilePath(id), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(repository.createProfile(id), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(repository.removeProfile(id), { code: 'INVALID_ARGUMENT' });
  }
});

test('foreign directory and copied marker cannot establish ownership', async t => {
  const { repository } = await fixture(t);
  const ownedId = randomUUID();
  const owned = await repository.createProfile(ownedId);
  const foreignId = randomUUID();
  const foreign = repository.profilePath(foreignId);
  await fs.mkdir(foreign);
  await fs.writeFile(path.join(foreign, 'keep'), 'foreign fixture');
  await fs.copyFile(path.join(owned, markerName), path.join(foreign, markerName));
  await assert.rejects(repository.createProfile(foreignId), { code: 'EEXIST' });
  await assert.rejects(repository.removeProfile(foreignId), { code: 'OWNERSHIP_UNVERIFIED' });
  assert.equal(await fs.readFile(path.join(foreign, 'keep'), 'utf8'), 'foreign fixture');
  const marker = JSON.parse(await fs.readFile(path.join(owned, markerName), 'utf8'));
  marker.token = randomUUID();
  await fs.writeFile(path.join(owned, markerName), JSON.stringify(marker));
  await assert.rejects(repository.removeProfile(ownedId), { code: 'OWNERSHIP_UNVERIFIED' });
});

test('nested junction/symlink refuses deletion before any profile data is removed', async t => {
  const { base, repository } = await fixture(t);
  const id = randomUUID();
  const target = await repository.createProfile(id);
  const outside = path.join(base, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'keep'), 'outside fixture');
  await fs.writeFile(path.join(target, 'aaa-keep'), 'profile fixture');
  await fs.mkdir(path.join(target, 'nested'));
  await linkDirectory(outside, path.join(target, 'nested', 'link'));
  await assert.rejects(repository.removeProfile(id), { code: 'OWNERSHIP_UNVERIFIED' });
  assert.equal(await fs.readFile(path.join(outside, 'keep'), 'utf8'), 'outside fixture');
  assert.equal(await fs.readFile(path.join(target, 'aaa-keep'), 'utf8'), 'profile fixture');
  assert.ok(await fs.stat(path.join(target, markerName)));
});

test('profile junction and profiles-root junction are refused', async t => {
  const { base, root, repository } = await fixture(t);
  const id = randomUUID();
  const target = await repository.createProfile(id);
  const moved = path.join(base, 'moved-profile');
  await fs.rename(target, moved);
  await linkDirectory(moved, target);
  await assert.rejects(repository.removeProfile(id), { code: 'OWNERSHIP_UNVERIFIED' });
  assert.ok(await fs.stat(path.join(moved, markerName)));
  const profiles = path.join(root, 'profiles');
  const movedProfiles = path.join(base, 'moved-profiles');
  await fs.rename(profiles, movedProfiles);
  await linkDirectory(movedProfiles, profiles);
  await assert.rejects(repository.createProfile(randomUUID()), { code: 'OWNERSHIP_UNVERIFIED' });
});

test('repository root junction is rejected and corrupt state does not retain the lock', async t => {
  const { base, root, repository } = await fixture(t);
  const alias = path.join(base, 'alias');
  await linkDirectory(root, alias);
  await assert.rejects(new Repository(alias).open(), { code: 'OWNERSHIP_UNVERIFIED' });
  await assert.rejects(new Repository(path.join(alias, 'must-not-create')).open(), { code: 'OWNERSHIP_UNVERIFIED' });
  await assert.rejects(fs.lstat(path.join(root, 'must-not-create')), { code: 'ENOENT' });
  await repository.close();
  await fs.writeFile(path.join(root, 'state.json'), '{broken');
  await assert.rejects(repository.open(), SyntaxError);
  await assert.rejects(fs.lstat(path.join(root, 'repository.lock')), { code: 'ENOENT' });
});
