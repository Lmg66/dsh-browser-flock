import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Repository } from '../src/host/repository.js';
import { RuntimeRegistry } from '../src/host/runtime-registry.js';
import { InstanceManager } from '../src/host/instance-manager.js';

const ownerMarker = '.browser-flock-owner.json';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flock-instance-test-'));
  const repository = new Repository(root);
  t.after(async () => {
    try { await repository.close(); }
    finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  await repository.open();
  const calls = { launch: [], close: [], inspect: [] };
  const statuses = new Map();
  const platform = {
    platform: process.platform,
    async inspectExecutable(candidate) {
      return { browser: candidate.browser, executablePath: candidate.path, available: true, name: 'Fake browser' };
    },
    async launch(runtime, profilePath, url, options) {
      calls.launch.push({ runtime, profilePath, url, options });
      statuses.set(profilePath, 'running');
      return { processIdentity: { pid: 1000 + calls.launch.length, startTime: 'fake-start' }, readiness: 'unknown' };
    },
    async inspectInstance(instance, runtime) {
      calls.inspect.push({ instance, runtime });
      return { status: statuses.get(instance.profilePath) ?? 'unknown' };
    },
    async closeInstance(instance, runtime, options) {
      calls.close.push({ instance, runtime, options });
      statuses.set(instance.profilePath, 'stopped');
      return { status: 'stopped' };
    },
  };
  const runtimes = new RuntimeRegistry(repository, platform);
  // inspectExecutable is fake: neither registration nor launch touches an executable.
  const runtime = await runtimes.register({ browser: 'chrome', path: path.join(root, 'fake-chrome') });
  const manager = new InstanceManager(repository, runtimes, platform);
  return { root, repository, platform, runtime, manager, calls, statuses };
}

test('CDP defaults on for Chromium, persists opt-out, and only changes after close', async t => {
  const {manager,runtime,calls}=await fixture(t);
  const {instance}=await manager.open({runtime_id:runtime.id});
  assert.equal(instance.cdpEnabled,true);
  assert.equal(calls.launch[0].options.cdp,true);
  await assert.rejects(manager.open({instance_id:instance.id,cdp:false}),{code:'INSTANCE_ALREADY_RUNNING'});
  await manager.close(instance.id);
  const reopened=await manager.open({instance_id:instance.id,cdp:false});
  assert.equal(reopened.instance.cdpEnabled,false);
  await manager.close(instance.id);
  await manager.open({instance_id:instance.id});
  assert.equal(calls.launch.at(-1).options.cdp,false);
});

test('CDP request id conflict does not launch twice', async t => {
  const {manager,runtime,calls}=await fixture(t);
  await manager.open({runtime_id:runtime.id,cdp:false,request_id:'cdp-once'});
  await assert.rejects(manager.open({runtime_id:runtime.id,cdp:true,request_id:'cdp-once'}),{code:'REQUEST_CONFLICT'});
  assert.equal(calls.launch.length,1);
});

test('new extension selections survive repository reload and failed browser launch', async t => {
  const {root,repository,platform,runtime,manager}=await fixture(t);
  const library_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  manager.extensionLibrary={list:()=>[{id:library_id}]};
  platform.launch=async()=>{throw Object.assign(new Error('launch failed'),{code:'START_FAILED'});};
  await assert.rejects(manager.open({runtime_id:runtime.id,extension_library_ids:[library_id]}),{code:'START_FAILED'});
  const [instance]=manager.list();
  assert.deepEqual((await persisted(root)).instances[0].extensionLibraryIds,[library_id]);
  await repository.close();
  await repository.open();
  assert.deepEqual(repository.snapshot().instances[0].extensionLibraryIds,[library_id]);
  assert.equal(repository.snapshot().instances[0].id,instance.id);
});

async function persisted(root) {
  return JSON.parse(await fs.readFile(path.join(root, 'state.json'), 'utf8'));
}

async function assertProfile(profilePath) {
  assert.equal((await fs.stat(profilePath)).isDirectory(), true);
  return JSON.parse(await fs.readFile(path.join(profilePath, ownerMarker), 'utf8'));
}

test('concurrent creation with the same request ID launches once and replays one instance', async t => {
  const { root, repository, platform, runtime, manager, calls } = await fixture(t);
  let entered;
  let release;
  const launchEntered = new Promise(resolve => { entered = resolve; });
  const launchGate = new Promise(resolve => { release = resolve; });
  const launch = platform.launch.bind(platform);
  platform.launch = async (...args) => {
    const result = await launch(...args);
    entered();
    await launchGate;
    return result;
  };
  const input = { runtime_id: runtime.id, name: 'Concurrent', request_id: 'same-request', url: 'https://example.com/' };
  const first = manager.open(input);
  await launchEntered;
  const second = manager.open({ ...input });
  const third = manager.open({ ...input });
  release();
  const results = await Promise.all([first, second, third]);
  assert.equal(calls.launch.length, 1);
  assert.equal(results[0].created, true);
  assert.equal(results[0].instance.status, 'running');
  for (const result of results.slice(1)) {
    assert.equal(result.created, false);
    assert.equal(result.replayed, true);
    assert.deepEqual(result.instance, results[0].instance);
  }
  const instance = results[0].instance;
  assert.match(instance.id, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
  assert.equal(instance.profilePath, repository.profilePath(instance.id));
  assert.equal(calls.launch[0].url, input.url);
  await assertProfile(instance.profilePath);
  const state = await persisted(root);
  assert.equal(state.instances.length, 1);
  assert.equal(Object.keys(state.requests).length, 1);
  assert.equal(Object.values(state.requests)[0].instanceId, instance.id);
});

test('reusing a request ID with changed creation parameters conflicts without launching', async t => {
  const { root, runtime, manager, calls } = await fixture(t);
  const input = { runtime_id: runtime.id, name: 'Original', mode: 'persistent', url: 'https://example.com/', request_id: 'conflict' };
  const opened = await manager.open(input);
  const before = await persisted(root);
  for (const change of [
    { runtime_id: 'different-runtime' },
    { name: 'Changed' },
    { mode: 'ephemeral' },
    { url: 'https://example.org/' },
  ]) {
    await assert.rejects(manager.open({ ...input, ...change }), { code: 'REQUEST_CONFLICT' });
  }
  assert.equal(calls.launch.length, 1);
  assert.deepEqual(await persisted(root), before);
  assert.deepEqual(manager.get(opened.instance.id), opened.instance);
});

test('a failed launch remains unknown, retains its profile, and replays without relaunch', async t => {
  const { root, platform, runtime, manager, calls } = await fixture(t);
  platform.launch = async (runtime, profilePath, url) => {
    calls.launch.push({ runtime, profilePath, url });
    await fs.writeFile(path.join(profilePath, 'browser-data'), 'partial launch');
    throw Object.assign(new Error('Fake launch failed after writing data'), { code: 'START_FAILED' });
  };
  const input = { runtime_id: runtime.id, mode: 'ephemeral', request_id: 'failed-launch' };
  await assert.rejects(manager.open(input), { code: 'START_FAILED' });
  const [instance] = manager.list();
  assert.equal(instance.status, 'unknown');
  assert.deepEqual(instance.lastError, { code: 'START_FAILED', stage: 'launch' });
  await assertProfile(instance.profilePath);
  assert.equal(await fs.readFile(path.join(instance.profilePath, 'browser-data'), 'utf8'), 'partial launch');
  assert.equal((await persisted(root)).instances[0].status, 'unknown');
  const replay = await manager.open(input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.created, false);
  assert.deepEqual(replay.instance, instance);
  assert.equal(calls.launch.length, 1);
});

test('ephemeral close removes the profile, stores a tombstone, and supports idempotent replay', async t => {
  const { root, runtime, manager, calls } = await fixture(t);
  const input = { runtime_id: runtime.id, mode: 'ephemeral', request_id: 'temporary' };
  const { instance } = await manager.open(input);
  await fs.mkdir(path.join(instance.profilePath, 'Default'));
  await fs.writeFile(path.join(instance.profilePath, 'Default', 'Cookies'), 'fake cookies');
  const closed = await manager.close(instance.id);
  assert.equal(closed.instance.status, 'deleted');
  assert.equal(closed.instance.cleanup, 'complete');
  assert.equal(closed.data_retained, false);
  await assert.rejects(fs.stat(instance.profilePath), { code: 'ENOENT' });
  assert.deepEqual(manager.list(), []);
  const state = await persisted(root);
  assert.deepEqual(state.instances, []);
  assert.deepEqual(state.tombstones, [closed.instance]);
  assert.ok(closed.instance.expiresAt > Date.now());
  assert.deepEqual(manager.get(instance.id), closed.instance);
  assert.deepEqual((await manager.close(instance.id)).instance, closed.instance);
  assert.deepEqual(await manager.delete(instance.id), closed.instance);
  const replay = await manager.open(input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.created, false);
  assert.deepEqual(replay.instance, closed.instance);
  assert.equal(calls.launch.length, 1);
  assert.equal(calls.close.length, 1);
  assert.equal(calls.inspect.length, 0);
  assert.deepEqual(await persisted(root), state);
});

test('persistent close and reopen retain the UUID, profile ownership, and browser data', async t => {
  const { root, runtime, manager, calls } = await fixture(t);
  const { instance } = await manager.open({ runtime_id: runtime.id, mode: 'persistent' });
  const marker = await assertProfile(instance.profilePath);
  const dataPath = path.join(instance.profilePath, 'browser-data');
  await fs.writeFile(dataPath, 'saved login');
  const closed = await manager.close(instance.id);
  assert.equal(closed.instance.status, 'stopped');
  assert.equal(closed.data_retained, true);
  assert.equal(await fs.readFile(dataPath, 'utf8'), 'saved login');
  const reopened = await manager.open({ instance_id: instance.id, url: 'https://example.com/restored' });
  assert.equal(reopened.created, false);
  assert.equal(reopened.instance.id, instance.id);
  assert.equal(reopened.instance.profilePath, instance.profilePath);
  assert.equal(reopened.instance.status, 'running');
  assert.deepEqual(await assertProfile(instance.profilePath), marker);
  assert.equal(await fs.readFile(dataPath, 'utf8'), 'saved login');
  assert.equal(calls.launch.length, 2);
  assert.equal(calls.launch[1].profilePath, instance.profilePath);
  assert.equal(calls.launch[1].url, 'https://example.com/restored');
  const state = await persisted(root);
  assert.equal(state.instances.length, 1);
  assert.equal(state.instances[0].id, instance.id);
  assert.deepEqual(state.tombstones, []);
});

for (const damage of ['missing directory', 'missing marker', 'foreign marker']) {
  test(`persistent reopen refuses ${damage} without launching`, async t => {
    const { root, repository, runtime, manager, calls } = await fixture(t);
    const { instance } = await manager.open({ runtime_id: runtime.id, mode: 'persistent' });
    await manager.close(instance.id);
    const profilePath = repository.profilePath(instance.id);
    assert.equal(path.resolve(profilePath), path.join(root, 'profiles', instance.id));
    const markerPath = path.join(profilePath, ownerMarker);
    const marker = await fs.readFile(markerPath, 'utf8');
    if (damage === 'missing directory') await fs.rm(profilePath, { recursive: true });
    else if (damage === 'missing marker') await fs.unlink(markerPath);
    else await fs.writeFile(markerPath, JSON.stringify({ ...JSON.parse(marker), repositoryId: 'foreign-repository' }));
    await assert.rejects(manager.open({ instance_id: instance.id }), {
      code: damage === 'foreign marker' ? 'OWNERSHIP_UNVERIFIED' : 'ENOENT',
    });
    assert.equal(calls.launch.length, 1);
    assert.equal(manager.get(instance.id).status, 'stopped');
    assert.equal((await persisted(root)).instances[0].status, 'stopped');
    if (damage === 'missing directory') await assert.rejects(fs.stat(profilePath), { code: 'ENOENT' });
    else if (damage === 'missing marker') await assert.rejects(fs.stat(markerPath), { code: 'ENOENT' });
    else assert.equal(JSON.parse(await fs.readFile(markerPath, 'utf8')).repositoryId, 'foreign-repository');
  });
}

test('unknown process ownership prevents deletion and retains profile and state', async t => {
  const { root, runtime, manager, statuses } = await fixture(t);
  const { instance } = await manager.open({ runtime_id: runtime.id, mode: 'ephemeral' });
  statuses.set(instance.profilePath, 'unknown');
  const unknown = await manager.reconcile(instance.id);
  assert.equal(unknown.status, 'unknown');
  const before = await persisted(root);
  await assert.rejects(manager.delete(instance.id), { code: 'OWNERSHIP_UNVERIFIED' });
  await assertProfile(instance.profilePath);
  assert.deepEqual(manager.get(instance.id), unknown);
  assert.deepEqual(await persisted(root), before);
});

test('cleanup failure retains the profile and cleanup_pending state for retry', async t => {
  const { root, runtime, manager } = await fixture(t);
  const { instance } = await manager.open({ runtime_id: runtime.id, mode: 'ephemeral', request_id: 'cleanup-failure' });
  const markerPath = path.join(instance.profilePath, ownerMarker);
  const originalMarker = await fs.readFile(markerPath, 'utf8');
  const marker = JSON.parse(originalMarker);
  // A mismatched marker causes a real Repository preflight failure on every OS.
  await fs.writeFile(markerPath, JSON.stringify({ ...marker, token: 'invalid-owner' }));
  const dataPath = path.join(instance.profilePath, 'browser-data');
  await fs.writeFile(dataPath, 'must survive cleanup failure');
  const closed = await manager.close(instance.id);
  assert.equal(closed.instance.status, 'cleanup_pending');
  assert.equal(closed.cleanup, 'cleanup_pending');
  assert.deepEqual(closed.instance.lastError, { code: 'OWNERSHIP_UNVERIFIED', stage: 'cleanup' });
  assert.equal(await fs.readFile(dataPath, 'utf8'), 'must survive cleanup failure');
  assert.equal((await fs.stat(instance.profilePath)).isDirectory(), true);
  const state = await persisted(root);
  assert.equal(state.instances[0].status, 'cleanup_pending');
  assert.deepEqual(state.tombstones, []);
  // Restore the fixture's original marker and verify cleanup remains retryable.
  await fs.writeFile(markerPath, originalMarker);
  assert.equal((await manager.reconcile(instance.id)).status, 'deleted');
  await assert.rejects(fs.stat(instance.profilePath), { code: 'ENOENT' });
  // Regression: close must truthfully report that failed cleanup retained data.
  assert.equal(closed.data_retained, true);
});
