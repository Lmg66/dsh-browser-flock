import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WindowsPlatform } from '../src/host/platform/windows.js';

const publisher='CN="Brave Software, Inc.", O="Brave Software, Inc.", L=San Francisco, S=California, C=US';
test('Brave identity accepts exact quoted certificate CN while preserving signature and product checks', {skip:process.platform!=='win32'}, async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'flock-identity-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const executable=path.join(root,'brave.exe');
  await fs.writeFile(executable,'fixture; metadata is injected, not executed');
  const platform=new WindowsPlatform();
  let metadata={product:'Brave Browser',version:'156.1.98.60',signature:'Valid',publisher};
  platform.powershell=async()=>metadata;
  const inspect=()=>platform.inspectExecutable({browser:'brave',path:executable});
  const verified=await inspect();
  assert.equal(verified.browser,'brave');
  assert.equal(verified.version,'156.1.98.60');
  assert.equal(verified.capabilities.cdp,true);
  for(const legacy of ['CN=Brave Software, Inc., O=Brave Software','CN=Brave Software Inc., O=Brave Software']){
    metadata={...metadata,publisher:legacy};
    assert.equal((await inspect()).browser,'brave');
  }
  const valid={product:'Brave Browser',version:'156.1.98.60',signature:'Valid',publisher};
  for(const invalid of [
    {signature:'NotSigned'}, {signature:'HashMismatch'}, {signature:'UnknownError'},
    {product:'Unrelated Browser'},
    {publisher:'CN="Brave Software, Inc. Evil", O=Other'},
    {publisher:'CN=Brave Software Inc. Evil, O=Other'},
    {publisher:'CN="Brave Software, Inc., O=Other'},
    {publisher:'OU=CN="Brave Software, Inc.", O=Other'},
    {publisher:'CN=Other, O="Brave Software, Inc."'},
  ]){
    metadata={...valid,...invalid};
    await assert.rejects(inspect,{code:'UNSUPPORTED_RUNTIME'},JSON.stringify(invalid));
  }
});
