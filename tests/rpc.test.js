import test from 'node:test';
import assert from 'node:assert/strict';
import { packageName, parseJson, jsonCodec, dispatchDescriptor, contribution, remoteContribution } from '../src/shared/rpc.js';

test('JSON codec preserves request and both business response envelopes', () => {
  const parser = jsonCodec.create();
  for (const value of [null, true, false, '', 0, 1.5, [], {},
    { action: 'browser_list', args: {} },
    { ok: true, data: [{ id: '中文', active: false }] },
    { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Invalid input', retryable: false }, data: null },
    Object.assign(Object.create(null), { nested: ['x', null] })]) {
    assert.equal(parser.parse(value), value);
  }
});

test('JSON codec rejects lossy values at every nesting level', () => {
  const values = [undefined, NaN, Infinity, -Infinity, -0, 1n, Symbol('x'), () => {}, new Date(), new Map(), new Number(1), new Uint8Array(1), new Array(1)];
  for (const value of values) {
    assert.throws(() => parseJson(value), TypeError);
    assert.throws(() => parseJson({ value }), TypeError);
    assert.throws(() => parseJson([value]), TypeError);
  }
});

test('JSON codec rejects cycles but permits shared noncyclic references', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => parseJson(cyclic), TypeError);
  const shared = { nested: [1, 2] };
  const value = { first: shared, second: shared };
  assert.equal(parseJson(value), value);
});

test('JSON codec rejects hidden, symbolic, accessor and decorated array fields', () => {
  let getterCalls = 0;
  const getter = Object.defineProperty({}, 'value', { enumerable: true, get() { getterCalls++; return 1; } });
  const hidden = Object.defineProperty({}, 'value', { value: 1 });
  const symbol = { [Symbol('value')]: 1 };
  const decorated = Object.assign([1], { extra: 2 });
  const replacedHole = Object.assign(new Array(1), { extra: 2 });
  for (const value of [getter, hidden, symbol, decorated, replacedHole]) assert.throws(() => parseJson(value), TypeError);
  assert.equal(getterCalls, 0);
});

test('Host and Client share the exact global unary invocation contract', () => {
  assert.equal(packageName, '@local/dsh-browser-flock');
  assert.equal(contribution.package, packageName);
  assert.equal(contribution.face, 'host');
  assert.deepEqual(contribution.schemas, []);
  assert.deepEqual(contribution.model, { services: [], events: [], objects: [] });
  assert.equal(remoteContribution.package, packageName);
  assert.equal(contribution.invocations[0], dispatchDescriptor);
  assert.equal(remoteContribution.descriptors[0], dispatchDescriptor);
  assert.equal(dispatchDescriptor.id, `${packageName}#browserFlock/dispatch`);
  assert.equal(dispatchDescriptor.service, 'browserFlock');
  assert.equal(dispatchDescriptor.namespace, 'browserFlock');
  assert.equal(dispatchDescriptor.method, 'dispatch');
  assert.deepEqual(dispatchDescriptor.invocation, { kind: 'direct' });
  assert.equal(dispatchDescriptor.mode, undefined);
  assert.equal(dispatchDescriptor.scope, undefined);
  assert.deepEqual(dispatchDescriptor.parameters, [{ name: 'input', wire: 'input', source: 'json', codec: jsonCodec }]);
  assert.equal(dispatchDescriptor.result, jsonCodec);
  assert.equal(jsonCodec.mode, 'strict');
  assert.equal(jsonCodec.typeSymbol, `${packageName}#JsonValue`);
});
