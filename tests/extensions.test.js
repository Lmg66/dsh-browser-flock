import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Repository} from '../src/host/repository.js';
import {ExtensionLibrary} from '../src/host/extensions.js';
import {InstanceManager} from '../src/host/instance-manager.js';
const extension='a'.repeat(32);
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'flock-extension-test-'));const repo=await new Repository(root).open();t.after(async()=>{await repo.close();assert.equal(await fs.realpath(root),root);await fs.rm(root,{recursive:true,force:true});});const a=randomUUID(),b=randomUUID();for(const id of [a,b]){await repo.createProfile(id);await repo.transaction(s=>s.instances.push({id,runtimeId:'chrome',status:'stopped'}));}const library=new ExtensionLibrary(repo,{get:id=>({browser:id})});const src=path.join(repo.profilePath(a),'Default','Extensions',extension,'1.0_0');await fs.mkdir(path.join(src,'_metadata'),{recursive:true});await fs.writeFile(path.join(src,'manifest.json'),JSON.stringify({name:'Test',version:'1.0',manifest_version:3,key:'test-key',permissions:['storage'],host_permissions:['https://example.com/*']}));await fs.writeFile(path.join(src,'script.js'),'original code');await fs.writeFile(path.join(src,'_metadata','verified_contents.json'),'signed');await fs.writeFile(path.join(repo.profilePath(a),'Cookies'),'private');return {root,repo,a,b,src,library};}
test('extension discovery capture and private copy remain independent after shared deletion',async t=>{const {repo,a,b,src,library}=await fixture(t);const installed=await library.listInstalled(a);assert.equal(installed.items.length,1);assert.equal(installed.items[0].source_profile,'Default');const entry=await library.capture({instance_id:a,extension_id:extension});assert.equal(entry.id_preserved,true);assert.deepEqual(entry.permissions,['storage']);const p=await library.packagePath(entry.id);assert.equal((await fs.readdir(p)).includes('_metadata'),false);assert.equal((await fs.readdir(p)).includes('Cookies'),false);await fs.writeFile(path.join(src,'script.js'),'changed source');const copy=await library.copyForInstance(entry.id,b);assert.equal(await fs.readFile(path.join(copy.path,'script.js'),'utf8'),'original code');assert.deepEqual(await library.copyForInstance(entry.id,b),copy);await repo.transaction(s=>s.instances.find(i=>i.id===b).extensionLibraryIds=[entry.id]);assert.equal((await library.remove(entry.id)).deleted,true);assert.equal(library.list().length,0);assert.equal((await library.listInstalled(b)).items[0].collected,false);assert.deepEqual(await library.copyForInstance(entry.id,b),copy);});
test('known Payments component is hidden by ID across profiles, while same-name user extensions transfer',async t=>{
 const {repo,a,b,src,library}=await fixture(t),component='nmmhkkegccagdldgiimedpiccmgmieda';
 await fs.writeFile(path.join(src,'manifest.json'),JSON.stringify({name:'Chrome Web Store Payments',version:'1.0',manifest_version:3}));
 for(const profile of ['Default','Profile 1']){
  const target=path.join(repo.profilePath(a),profile,'Extensions',component,'1.0_0');await fs.mkdir(target,{recursive:true});
  await fs.writeFile(path.join(target,'manifest.json'),JSON.stringify({name:'Localized component name',version:'1.0',manifest_version:3}));
 }
 const scan=await library.listInstalled(a);assert.equal(scan.excluded_component_count,2);assert.deepEqual(scan.items.map(e=>e.extension_id),[extension]);assert.equal(scan.items[0].name,'Chrome Web Store Payments');
 for(const source_profile of ['Default','Profile 1'])await assert.rejects(library.capture({instance_id:a,extension_id:component,source_profile}),{code:'EXTENSION_NOT_FOUND'});
 const entry=await library.capture({instance_id:a,extension_id:extension});await library.copyForInstance(entry.id,b);
 await repo.transaction(s=>s.instances.find(i=>i.id===b).extensionLibraryIds=[entry.id]);
 const transferred=await library.listInstalled(b);assert.equal(transferred.excluded_component_count,0);assert.equal(transferred.items.length,1);assert.equal(transferred.items[0].extension_id,extension);assert.equal(transferred.items[0].source_kind,'library');
 assert.equal((await library.capture({instance_id:b,extension_id:extension,source_profile:`Library ${entry.id}`})).id,entry.id);
});

test('legacy selected Payments component is hidden without deleting its library record or package',async t=>{
 const {repo,a,b,library}=await fixture(t),component='nmmhkkegccagdldgiimedpiccmgmieda';
 const entry=await library.capture({instance_id:a,extension_id:extension});
 // Model a component collected before filtering was introduced.
 await repo.transaction(s=>{s.extensionLibrary.find(e=>e.id===entry.id).extension_id=component;});
 const copy=await library.copyForInstance(entry.id,b);
 await repo.transaction(s=>s.instances.find(i=>i.id===b).extensionLibraryIds=[entry.id,entry.id]);
 const scan=await library.listInstalled(b);assert.deepEqual(scan.items,[]);assert.equal(scan.excluded_component_count,1);
 await assert.rejects(library.capture({instance_id:b,extension_id:component,source_profile:`Library ${entry.id}`}),{code:'EXTENSION_NOT_FOUND'});
 assert.equal(library.list().length,1);assert.equal(library.list()[0].extension_id,component);await library.packagePath(entry.id);assert.equal(await fs.readFile(path.join(copy.path,'script.js'),'utf8'),'original code');
});

test('extension discovery refuses external paths links invalid manifests and Firefox',async t=>{const {repo,a,src,library}=await fixture(t);await assert.rejects(library.capture({instance_id:a,extension_id:'../outside'}),{code:'INVALID_ARGUMENT'});await assert.rejects(library.packagePath('../outside'),{code:'INVALID_ARGUMENT'});await fs.symlink(repo.profilePath(a),path.join(src,'leak.txt'),'junction');await assert.rejects(library.capture({instance_id:a,extension_id:extension}),{code:'OWNERSHIP_UNVERIFIED'});await fs.unlink(path.join(src,'leak.txt'));await fs.writeFile(path.join(src,'manifest.json'),'{}');await assert.rejects(library.listInstalled(a),{code:'INVALID_EXTENSION'});await repo.transaction(s=>s.instances.find(i=>i.id===a).runtimeId='firefox');await assert.rejects(library.listInstalled(a),{code:'EXTENSION_UNSUPPORTED'});});
test('manifest size limit and nested metadata links are refused; localized names resolve',async t=>{const {repo,a,src,library}=await fixture(t);await fs.mkdir(path.join(src,'_locales','en'),{recursive:true});await fs.writeFile(path.join(src,'_locales','en','messages.json'),JSON.stringify({extName:{message:'Localized Test'}}));await fs.writeFile(path.join(src,'manifest.json'),JSON.stringify({name:'__MSG_extName__',default_locale:'en',version:'1.0',manifest_version:3}));assert.equal((await library.listInstalled(a)).items[0].name,'Localized Test');await fs.symlink(repo.profilePath(a),path.join(src,'_metadata','escape'),'junction');await assert.rejects(library.capture({instance_id:a,extension_id:extension}),{code:'OWNERSHIP_UNVERIFIED'});await fs.unlink(path.join(src,'_metadata','escape'));await fs.writeFile(path.join(src,'manifest.json'),' '.repeat(2*1024*1024+1));await assert.rejects(library.listInstalled(a),{code:'EXTENSION_LIMIT'});});
test('localized selected packages scan and recapture with their original library identity',async t=>{
 const {repo,a,b,src,library}=await fixture(t);
 await fs.mkdir(path.join(src,'_locales','zh_CN'),{recursive:true});
 await fs.writeFile(path.join(src,'_locales','zh_CN','messages.json'),'\uFEFF'+JSON.stringify({EXTname:{message:'本地化扩展'}}));
 await fs.writeFile(path.join(src,'manifest.json'),JSON.stringify({name:'__MSG_extName__',default_locale:'zh_CN',version:'1.0',manifest_version:3}));
 assert.equal((await library.listInstalled(a)).items[0].collected,false);
 const entry=await library.capture({instance_id:a,extension_id:extension});
 assert.equal(entry.name,'本地化扩展');
 await library.copyForInstance(entry.id,b);
 assert.deepEqual((await library.listInstalled(b)).items,[],'unselected private folders are not installed');
 await repo.transaction(s=>{s.instances.find(i=>i.id===b).extensionLibraryIds=[entry.id];s.extensionLibrary[0].name='__MSG_extName__';});
 const [row]=(await library.listInstalled(b)).items;
 assert.equal(row.name,'本地化扩展');assert.equal(row.extension_id,extension);assert.equal(row.source_kind,'library');assert.equal(row.source_profile,`Library ${entry.id}`);assert.equal(row.library_id,entry.id);assert.equal(row.collected,true);
 const again=await library.capture({instance_id:b,extension_id:row.extension_id,source_profile:row.source_profile});
 assert.equal(again.id,entry.id);assert.equal(again.name,'本地化扩展');assert.equal(library.list()[0].name,'本地化扩展');assert.equal(library.list().length,1);
 const [original]=(await library.listInstalled(a)).items;assert.equal(original.collected,true);assert.equal(original.library_id,entry.id);
 await repo.close();await repo.open();assert.equal((await library.listInstalled(b)).items[0].library_id,entry.id);
 await repo.transaction(s=>s.instances.find(i=>i.id===b).extensionLibraryIds=[]);
 await assert.rejects(library.capture({instance_id:b,extension_id:extension,source_profile:row.source_profile}),{code:'EXTENSION_NOT_FOUND'});
});

test('capture is idempotent by identity version and payload, including legacy records',async t=>{
 const {repo,a,src,library}=await fixture(t);
 const entries=await Promise.all([library.capture({instance_id:a,extension_id:extension}),library.capture({instance_id:a,extension_id:extension})]);
 assert.equal(entries[0].id,entries[1].id);assert.equal(library.list().length,1);
 await fs.writeFile(path.join(src,'_metadata','verified_contents.json'),'new generated metadata');
 assert.equal((await library.capture({instance_id:a,extension_id:extension})).id,entries[0].id);
 await fs.writeFile(path.join(src,'script.js'),'updated code, unchanged version');
 assert.equal((await library.listInstalled(a)).items[0].collected,false);
 const changed=await library.capture({instance_id:a,extension_id:extension});assert.notEqual(changed.id,entries[0].id);
 const other=path.join(repo.profilePath(a),'Profile 1','Extensions',extension,'1.0_0');await fs.mkdir(path.dirname(other),{recursive:true});await fs.cp(src,other,{recursive:true});
 assert.equal((await library.capture({instance_id:a,extension_id:extension,source_profile:'Profile 1'})).id,changed.id);
 const otherId='b'.repeat(32),otherIdentity=path.join(repo.profilePath(a),'Default','Extensions',otherId,'1.0_0');await fs.mkdir(path.dirname(otherIdentity),{recursive:true});await fs.cp(src,otherIdentity,{recursive:true});
 assert.notEqual((await library.capture({instance_id:a,extension_id:otherId})).id,changed.id);
 assert.equal(library.list().length,3);
 await fs.writeFile(path.join(src,'manifest.json'),JSON.stringify({name:'Test',version:'2.0',manifest_version:3}));
 const upgraded=await library.capture({instance_id:a,extension_id:extension});assert.notEqual(upgraded.id,changed.id);assert.equal(upgraded.version,'2.0');assert.equal(library.list().length,4);
});

test('selected discovery refuses traversal links and modified package copies',async t=>{
 const {repo,a,b,library}=await fixture(t),entry=await library.capture({instance_id:a,extension_id:extension}),copy=await library.copyForInstance(entry.id,b);
 await repo.transaction(s=>s.instances.find(i=>i.id===b).extensionLibraryIds=[entry.id]);
 for(const source_profile of ['Library ../../escape',`Library ${entry.id}/..`])await assert.rejects(library.capture({instance_id:b,extension_id:extension,source_profile}),{code:'INVALID_ARGUMENT'});
 await fs.writeFile(path.join(copy.path,'script.js'),'tampered');
 await assert.rejects(library.listInstalled(b),{code:'EXTENSION_COPY_CONFLICT'});
 await assert.rejects(library.capture({instance_id:b,extension_id:extension,source_profile:`Library ${entry.id}`}),{code:'EXTENSION_COPY_CONFLICT'});
 await fs.writeFile(path.join(copy.path,'script.js'),'original code');
 await fs.symlink(repo.profilePath(a),path.join(copy.path,'outside'),'junction');
 await assert.rejects(library.listInstalled(b),{code:'OWNERSHIP_UNVERIFIED'});
 await fs.unlink(path.join(copy.path,'outside'));
 await repo.transaction(s=>s.instances.find(i=>i.id===b).extensionLibraryIds=['../../outside']);
 await assert.rejects(library.listInstalled(b),{code:'INVALID_ARGUMENT'});
 assert.equal(library.list().length,1);
});

test('localization fallback accepts malformed messages but rejects unsafe locale directories',async t=>{
 const {repo,a,src,library}=await fixture(t);
 await fs.writeFile(path.join(src,'manifest.json'),JSON.stringify({name:'__MSG_NAME__',default_locale:'en',version:'1.0',manifest_version:3}));
 await fs.mkdir(path.join(src,'_locales','en'),{recursive:true});
 for(const value of ['null','[]','{"name":{"message":""}}','{']){await fs.writeFile(path.join(src,'_locales','en','messages.json'),value);assert.equal((await library.listInstalled(a)).items[0].name,'__MSG_NAME__');}
 await fs.unlink(path.join(src,'_locales','en','messages.json'));await fs.rmdir(path.join(src,'_locales','en'));await fs.symlink(repo.profilePath(a),path.join(src,'_locales','en'),'junction');
 await assert.rejects(library.listInstalled(a),{code:'OWNERSHIP_UNVERIFIED'});
});

test('startup name repair updates legacy tokens and isolates invalid package errors',async t=>{
 const {repo,a,src,library}=await fixture(t);
 await fs.mkdir(path.join(src,'_locales','en'),{recursive:true});await fs.writeFile(path.join(src,'_locales','en','messages.json'),JSON.stringify({name:{message:'Repaired name'}}));
 await fs.writeFile(path.join(src,'manifest.json'),JSON.stringify({name:'__MSG_NAME__',default_locale:'en',version:'1.0',manifest_version:3}));
 const entry=await library.capture({instance_id:a,extension_id:extension}),missing=randomUUID();
 await repo.transaction(s=>{s.extensionLibrary[0].name='__MSG_NAME__';s.extensionLibrary.unshift({...entry,id:missing,name:'__MSG_NAME__'});});
 const result=await library.repairNames();assert.deepEqual(result.updated,[entry.id]);assert.equal(result.errors.length,1);assert.equal(result.errors[0].library_id,missing);assert.equal(result.errors[0].code,'ENOENT');
 assert.equal(library.list().find(e=>e.id===entry.id).name,'Repaired name');assert.equal(library.list().find(e=>e.id===missing).name,'__MSG_NAME__');
 await repo.transaction(s=>s.extensionLibrary=s.extensionLibrary.filter(e=>e.id!==missing));assert.deepEqual(await library.repairNames(),{updated:[],errors:[]});
 await repo.close();await repo.open();assert.equal(library.list()[0].name,'Repaired name');
});

test('library survives repository reopen and legacy missing state; rejects library junction',async t=>{const {root,repo,a,library}=await fixture(t);const entry=await library.capture({instance_id:a,extension_id:extension});await repo.close();await repo.open();assert.equal(library.list()[0].id,entry.id);await library.packagePath(entry.id);await library.remove(entry.id);await repo.transaction(s=>delete s.extensionLibrary);assert.deepEqual(library.list(),[]);const libraryRoot=await repo.extensionLibraryRoot();await fs.rmdir(libraryRoot);await fs.symlink(repo.profilePath(a),libraryRoot,'junction');await assert.rejects(repo.extensionLibraryRoot(),{code:'OWNERSHIP_UNVERIFIED'});await fs.unlink(libraryRoot);});

test('library deletion preserves queued and running instance packages across repository restart, reapply, scan and uninstall',async t=>{
 const {repo,a,b,library}=await fixture(t),entry=await library.capture({instance_id:a,extension_id:extension});
 const runtimes={get:()=>({browser:'chrome'})},loaded=[],removed=[];
 const manager=new InstanceManager(repo,runtimes,{inspectInstance:async i=>({status:i.status})},{discoverExtensionCdp:async()=>({status:'ready'}),loadExtension:async(endpoint,p)=>{loaded.push(p);return {id:extension};},unloadExtension:async(endpoint,id)=>removed.push(id)});manager.extensionLibrary=library;
 await repo.transaction(s=>{for(const i of s.instances){i.mode='persistent';i.cdpEnabled=true;}s.instances.find(i=>i.id===a).status='running';});
 await manager.installExtension({instance_id:a,library_id:entry.id});await manager.installExtension({instance_id:b,library_id:entry.id});
 const before=repo.snapshot().instances.map(i=>({id:i.id,selected:i.extensionLibraryIds,results:i.extensionLoadResults}));
 await library.remove(entry.id);assert.equal(library.list().length,0);
 assert.deepEqual(repo.snapshot().instances.map(i=>({id:i.id,selected:i.extensionLibraryIds,results:i.extensionLoadResults})),before);
 await assert.rejects(library.packagePath(entry.id),{code:'EXTENSION_NOT_FOUND'});
 await repo.close();await repo.open();
 for(const id of [a,b]){await repo.transaction(s=>s.instances.find(i=>i.id===id).status='running');const results=await manager.reapplyExtensions(manager.get(id),runtimes.get());assert.equal(results[0].status,'installed');}
 const scan=await library.listInstalled(b);assert.equal(scan.items.length,1);assert.equal(scan.items[0].name,'Test');assert.equal(scan.items[0].collected,false);assert.equal(scan.items[0].library_id,undefined);
 const again=await library.capture({instance_id:b,extension_id:extension,source_profile:scan.items[0].source_profile});assert.notEqual(again.id,entry.id);assert.equal((await library.listInstalled(b)).items[0].library_id,again.id);
 assert.equal((await manager.removeExtension({instance_id:b,library_id:entry.id})).status,'uninstalled');assert.deepEqual(removed,[extension]);assert.deepEqual(manager.get(b).extensionPackages,{});assert.deepEqual((await library.listInstalled(b)).items,[]);assert.equal(manager.get(a).extensionLibraryIds[0],entry.id);
});

test('legacy selected copies gain durable metadata before shared deletion, including absent queued copies',async t=>{
 const {repo,a,b,library}=await fixture(t),entry=await library.capture({instance_id:a,extension_id:extension});
 await library.copyForInstance(entry.id,a);
 await repo.transaction(s=>{for(const i of s.instances){i.extensionLibraryIds=[entry.id];delete i.extensionPackages;}});
 await library.remove(entry.id);await repo.close();await repo.open();
 for(const id of [a,b]){const i=repo.snapshot().instances.find(i=>i.id===id);assert.equal(i.extensionPackages[entry.id].entry.name,'Test');assert.match(i.extensionPackages[entry.id].sha256,/^[0-9a-f]{64}$/);assert.equal((await library.copyForInstance(entry.id,id)).entry.id,entry.id);}
});

test('unsafe legacy or independently saved copy blocks deletion without losing shared package',async t=>{
 const {repo,a,b,library}=await fixture(t),entry=await library.capture({instance_id:a,extension_id:extension}),copy=await library.copyForInstance(entry.id,b);
 await repo.transaction(s=>{const i=s.instances.find(i=>i.id===b);i.extensionLibraryIds=[entry.id];delete i.extensionPackages;});
 await fs.writeFile(path.join(copy.path,'script.js'),'tampered');await assert.rejects(library.remove(entry.id),{code:'EXTENSION_COPY_CONFLICT'});assert.equal(library.list().length,1);await library.packagePath(entry.id);
 await fs.writeFile(path.join(copy.path,'script.js'),'original code');await library.copyForInstance(entry.id,b);await library.remove(entry.id);
 await fs.writeFile(path.join(copy.path,'script.js'),'tampered');await assert.rejects(library.copyForInstance(entry.id,b),{code:'EXTENSION_COPY_CONFLICT'});await assert.rejects(library.listInstalled(b),{code:'EXTENSION_COPY_CONFLICT'});
});
