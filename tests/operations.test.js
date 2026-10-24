import test from 'node:test';
import assert from 'node:assert/strict';
import { Operations, operationNames } from '../src/host/operations.js';
import { InstanceManager } from '../src/host/instance-manager.js';
import { FlockError } from '../src/shared/errors.js';

function fixture() {
  const calls = [];
  const rows = Array.from({ length: 25 }, (_, i) => ({ id: `rt_${i}` }));
  const instancesRows = Array.from({ length: 25 }, (_, i) => ({ id: `instance_${i}`, runtimeId: `rt_${i % 2}`, status: i % 2 ? 'running' : 'stopped', mode: i % 2 ? 'ephemeral' : 'persistent' }));
  const record = (method, result) => (...args) => { calls.push({ method, args }); return result; };
  const repository = { snapshot: () => ({ defaultRuntimeId: 'rt_0' }) };
  const runtimes = {
    scan: record('scan', rows), get: id => { calls.push({ method: 'get', args: [id] }); return { id }; },
    remove: record('remove', { registration_removed: true }), register: record('register', { id: 'rt_new' }),
  };
  const instances = {
    list: () => instancesRows,
    reconcile: record('reconcile', { id: 'instance_0', status: 'stopped' }),
    close: record('close', { status: 'stopped' }),
    exclusive: operation => operation(),
  };
  return { operations: new Operations(repository, runtimes, instances), calls, rows, instancesRows, runtimes, instances };
}

function invalid(result) {
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_ARGUMENT');
  assert.equal(result.error.retryable, false);
}

for (const action of ['list_browser_runtimes', 'list_browser_instances']) {
  test(`${action} defaults to 20 items and handles pagination boundaries`, async () => {
    const { operations, rows, instancesRows } = fixture();
    const all = action === 'list_browser_runtimes' ? rows : instancesRows;
    const first = await operations.dispatch({ action });
    assert.equal(first.ok, true);
    assert.deepEqual(first.data.items, all.slice(0, 20));
    assert.equal(first.data.total, 25);
    assert.equal(first.data.offset, 0);
    assert.equal(first.data.limit, 20);
    assert.equal(first.data.next_offset, 20);
    if (action === 'list_browser_runtimes') assert.equal(first.data.default_runtime_id, 'rt_0');
    const last = await operations.dispatch({ action, args: { offset: 20, limit: 5 } });
    assert.deepEqual(last.data.items, all.slice(20));
    assert.equal(last.data.next_offset, null);
    const beyond = await operations.dispatch({ action, args: { offset: Number.MAX_SAFE_INTEGER, limit: 100 } });
    assert.deepEqual(beyond.data.items, []);
    assert.equal(beyond.data.total, 25);
    assert.equal(beyond.data.next_offset, null);
  });

  test(`${action} rejects invalid page values before scanning or reconciling`, async () => {
    const { operations, calls } = fixture();
    for (const offset of [-1, 0.5, '0', null, Number.MAX_SAFE_INTEGER + 1]) {
      invalid(await operations.dispatch({ action, args: { offset } }));
    }
    for (const limit of [0, -1, 101, 1.5, '20', null]) {
      invalid(await operations.dispatch({ action, args: { limit } }));
    }
    assert.deepEqual(calls, []);
  });
}

test('dispatcher rejects unknown fields, unknown actions, and non-object arguments', async () => {
  const { operations, calls } = fixture();
  for (const input of [null, [], {}, { action: 'unknown' }, { action: 'toString' },
    { action: ['get_browser_runtime'], args: { runtime_id: 'rt_0' } },
    { action: 'list_browser_runtimes', extra: true },
    ...[null, [], 'bad', 42].map(args => ({ action: 'list_browser_runtimes', args })),
  ]) invalid(await operations.dispatch(input));
  for (const action of operationNames) invalid(await operations.dispatch({ action, args: { surprise: true } }));
  assert.deepEqual(calls, []);
});

test('runtime lookup validates identifiers and returns the requested runtime', async () => {
  const { operations, calls } = fixture();
  for (const runtime_id of [undefined, null, '', '   ', 12, [], 'x'.repeat(129)]) {
    invalid(await operations.dispatch({ action: 'get_browser_runtime', args: { runtime_id } }));
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(await operations.dispatch({ action: 'get_browser_runtime', args: { runtime_id: 'rt_17' } }), { ok: true, data: { id: 'rt_17' } });
  assert.deepEqual(calls, [{ method: 'get', args: ['rt_17'] }]);
});

test('runtime refresh must be boolean and is forwarded with its default', async () => {
  const { operations, calls } = fixture();
  for (const refresh of [null, 0, 'true', []]) invalid(await operations.dispatch({ action: 'list_browser_runtimes', args: { refresh } }));
  assert.deepEqual(calls, []);
  await operations.dispatch({ action: 'list_browser_runtimes' });
  await operations.dispatch({ action: 'list_browser_runtimes', args: { refresh: true } });
  assert.deepEqual(calls.map(call => call.args), [[{ refresh: false }], [{ refresh: true }]]);
});

test('instance filters apply before pagination and reconcile every instance', async () => {
  const { operations, calls, instancesRows } = fixture();
  const result = await operations.dispatch({ action: 'list_browser_instances', args: { runtime_id: 'rt_0', mode: 'persistent', status: 'stopped', offset: 2, limit: 3 } });
  const filtered = instancesRows.filter(row => row.runtimeId === 'rt_0');
  assert.deepEqual(result.data, { items: filtered.slice(2, 5), total: 13, offset: 2, limit: 3, next_offset: 5 });
  assert.deepEqual(calls.map(call => call.args[0]), instancesRows.map(row => row.id));
});

test('close validates option types and ranges before calling the manager', async () => {
  const { operations, calls } = fixture();
  const action = 'close_browser_instance';
  for (const force of [null, 0, 'false', []]) invalid(await operations.dispatch({ action, args: { instance_id: 'instance_0', force } }));
  for (const timeout_ms of [null, 999, 60001, 1000.5, '1000']) invalid(await operations.dispatch({ action, args: { instance_id: 'instance_0', timeout_ms } }));
  assert.deepEqual(calls, []);
  assert.equal((await operations.dispatch({ action, args: { instance_id: 'instance_0' } })).ok, true);
  assert.equal((await operations.dispatch({ action, args: { instance_id: 'instance_0', force: true, timeout_ms: 60000 } })).ok, true);
  assert.deepEqual(calls.map(call => call.args), [
    ['instance_0', { force: false, timeout_ms: 10000 }],
    ['instance_0', { force: true, timeout_ms: 60000 }],
  ]);
});

test('business failures preserve recovery details and unexpected failures are sanitized', async () => {
  const { operations, runtimes } = fixture();
  runtimes.get = () => { throw new FlockError('RUNTIME_UNAVAILABLE', 'Unavailable', { retryable: true, recoveryHint: 'Refresh registrations.', details: { runtime_id: 'rt_0' } }); };
  assert.deepEqual(await operations.dispatch({ action: 'get_browser_runtime', args: { runtime_id: 'rt_0' } }), {
    ok: false, error: { code: 'RUNTIME_UNAVAILABLE', message: 'Unavailable', retryable: true, recovery_hint: 'Refresh registrations.' }, data: { runtime_id: 'rt_0' },
  });
  runtimes.scan = async () => { throw new Error('private path or credentials'); };
  assert.deepEqual(await operations.dispatch({ action: 'list_browser_runtimes' }), {
    ok: false, error: { code: 'INTERNAL_ERROR', message: 'The operation failed unexpectedly.', retryable: false },
  });
});

test('runtime removal waits for the instance creation queue', async () => {
  const { operations, runtimes } = fixture();
  const events = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const manager = new InstanceManager({}, runtimes, {});
  operations.instances = manager;
  // Exercise the real queue without reaching any browser platform method.
  manager.open = () => manager.exclusive(async () => { events.push('creating'); await gate; events.push('created'); return { created: true }; });
  runtimes.remove = async id => { events.push(`remove:${id}`); return { registration_removed: true }; };
  const creation = operations.dispatch({ action: 'open_browser_instance', args: { runtime_id: 'rt_0' } });
  const removal = operations.dispatch({ action: 'remove_browser_runtime', args: { runtime_id: 'rt_0' } });
  await Promise.resolve();
  assert.deepEqual(events, ['creating']);
  release();
  assert.equal((await creation).ok, true);
  assert.equal((await removal).ok, true);
  assert.deepEqual(events, ['creating', 'created', 'remove:rt_0']);
});
