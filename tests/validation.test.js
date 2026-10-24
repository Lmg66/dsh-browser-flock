import test from 'node:test';
import assert from 'node:assert/strict';
import { openInput, url } from '../src/shared/validation.js';
import { launchArguments, defaultCandidates } from '../src/host/browser-adapters.js';
import path from 'node:path';

test('create and reopen inputs are mutually exclusive', () => {
  assert.equal(openInput({ runtime_id: 'runtime' }).mode, 'persistent');
  for (const input of [{}, {runtime_id:'a',instance_id:'b'}, {instance_id:'a',mode:'persistent'}, {runtime_id:'a',args:['--unsafe']}, {runtime_id:'a',name:' '}]) {
    assert.throws(() => openInput(input), { code: 'INVALID_ARGUMENT' });
  }
});
test('new extension selection accepts empty and 32 IDs and rejects explicit reopen selection', () => {
  assert.deepEqual(openInput({runtime_id:'r',extension_library_ids:[]}).extension_library_ids,[]);
  const ids=Array.from({length:32},(_,i)=>`${i.toString(16).padStart(8,'0')}-aaaa-aaaa-aaaa-aaaaaaaaaaaa`);
  assert.deepEqual(openInput({runtime_id:'r',extension_library_ids:ids}).extension_library_ids,ids);
  assert.throws(()=>openInput({instance_id:'i',extension_library_ids:[]}),{code:'INVALID_ARGUMENT'});
});
test('URLs reject credentials and non-web schemes', () => {
  for (const value of ['file:///etc/passwd', 'javascript:alert(1)', 'https://user:pass@example.com', '--no-sandbox']) assert.throws(() => url(value), {code:'INVALID_ARGUMENT'});
  assert.equal(url('https://example.com/a?q=x'), 'https://example.com/a?q=x');
});
test('browser adapters isolate profiles and omit CDP unless requested by manager', () => {
  const profile = path.resolve('test profiles/中文');
  for (const browser of ['chrome','edge','brave','firefox']) {
    const args=launchArguments({browser},profile,'https://example.com/?a=1&b=2');
    assert.ok(args.some(arg=>arg===profile||arg===`--user-data-dir=${profile}`));
    assert.equal(args.at(-1),'https://example.com/?a=1&b=2');
    assert.ok(!args.some(arg=>arg.includes('remote-debugging')||arg==='--no-sandbox'));
  }
});
test('candidate generation never includes relative PATH directories', () => {
  assert.ok(defaultCandidates('linux',{PATH:'.:/usr/bin:relative:/usr/local/bin'}).every(c=>c.path.startsWith('/')));
  assert.ok(defaultCandidates('win32',{PROGRAMFILES:'C:\\Program Files'}).some(c=>c.path==='C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'));
  assert.deepEqual(defaultCandidates('other',{}),[]);
});
