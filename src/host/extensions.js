import * as fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {invariant} from '../shared/errors.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXT=/^[a-p]{32}$/;
// Chrome Web Store Payments is a browser component, not a portable user extension.
// Match its canonical ID only: names are spoofable/localized; unknown IDs remain discoverable.
const COMPONENT_IDS=new Set(['nmmhkkegccagdldgiimedpiccmgmieda']);
const PROFILE=/^(Default|Profile [1-9][0-9]*)$/;
const MAX_JSON=2*1024*1024, MAX_BYTES=128*1024*1024, MAX_FILES=10000;
const norm=p=>process.platform==='win32'?path.resolve(p).toLowerCase():path.resolve(p);
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs;
async function directory(p) {
 const s=await fs.lstat(p);invariant(s.isDirectory()&&!s.isSymbolicLink()&&norm(await fs.realpath(p))===norm(p),'OWNERSHIP_UNVERIFIED','Unsafe extension directory.');return s;
}
async function file(p,max=MAX_JSON) {
 const s=await fs.lstat(p);invariant(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1,'OWNERSHIP_UNVERIFIED','Unsafe extension file.');
 invariant(s.size<=max,'EXTENSION_LIMIT','Extension file exceeds size limit.');
 const h=await fs.open(p,'r');try {invariant(same(s,await h.stat()),'OWNERSHIP_UNVERIFIED','Extension changed during read.');const data=await h.readFile();invariant(data.length<=max&&same(s,await h.stat()),'OWNERSHIP_UNVERIFIED','Extension changed during read.');return data;}finally{await h.close();}
}
async function manifest(p) {
 let m;try{m=JSON.parse((await file(path.join(p,'manifest.json'))).toString('utf8'));}catch(e){if(e instanceof SyntaxError)invariant(false,'INVALID_EXTENSION','Invalid extension manifest JSON.');throw e;}
 invariant(m&&typeof m==='object'&&!Array.isArray(m)&&typeof m.name==='string'&&m.name.length<=4096&&typeof m.version==='string'&&/^\d+(?:\.\d+){0,3}$/.test(m.version)&&[2,3].includes(m.manifest_version),'INVALID_EXTENSION','Invalid extension manifest.');
 for(const field of ['permissions','host_permissions']) invariant(m[field]===undefined||(Array.isArray(m[field])&&m[field].length<=1000&&m[field].every(x=>typeof x==='string'&&x.length<=8192)),'INVALID_EXTENSION','Invalid extension permissions.');
 return m;
}
async function displayName(root,m){
 if(!/^__MSG_[a-z0-9_@]+__$/i.test(m.name)||typeof m.default_locale!=='string'||! /^[a-z0-9_-]+$/i.test(m.default_locale))return m.name;
 const locales=path.join(root,'_locales'),locale=path.join(locales,m.default_locale);try{await directory(locales);await directory(locale);const messages=JSON.parse((await file(path.join(locale,'messages.json'))).toString('utf8').replace(/^\uFEFF/,''));if(!messages||typeof messages!=='object'||Array.isArray(messages))return m.name;const key=m.name.slice(6,-2).toLowerCase();const found=Object.entries(messages).find(([k])=>k.toLowerCase()===key)?.[1]?.message;return typeof found==='string'&&found.trim()&&found.length<=4096?found:m.name;}catch(e){if(e.code==='ENOENT'||e instanceof SyntaxError)return m.name;throw e;}
}
// Hash the portable payload, excluding Chrome's generated _metadata just as capture does.
function fingerprint(files){const hash=createHash('sha256');for(const f of [...files].sort((a,b)=>a.relative<b.relative?-1:a.relative>b.relative?1:0)){hash.update(JSON.stringify([f.relative.split(path.sep).join('/'),f.data.length]));hash.update(f.data);}return hash.digest('hex');}
function selectedId(profile){if(typeof profile!=='string'||!profile.startsWith('Library '))return null;const id=profile.slice(8);return UUID.test(id)?id:null;}
function summary(m){return {name:m.name,version:m.version,manifest_version:m.manifest_version,permissions:m.permissions??[],host_permissions:m.host_permissions??[],id_preserved:typeof m.key==='string'&&m.key.length>0};}
async function tree(root) {
 const files=[];let bytes=0,count=0;
 async function visit(dir,rel='',depth=0,excluded=false){invariant(depth<=40,'EXTENSION_LIMIT','Extension nesting too deep.');await directory(dir);
 for(const name of await fs.readdir(dir)) {invariant(++count<=MAX_FILES,'EXTENSION_LIMIT','Too many extension entries.');const p=path.join(dir,name),r=path.join(rel,name),s=await fs.lstat(p);
 invariant(!s.isSymbolicLink()&&(s.isFile()||s.isDirectory()),'OWNERSHIP_UNVERIFIED','Extension contains links or special entries.');
 // Chrome generates this signed-store metadata; unpacked loading rejects it.
 const skip=excluded||(rel===''&&name==='_metadata');
 if(s.isDirectory())await visit(p,r,depth+1,skip);else{bytes+=s.size;invariant(bytes<=MAX_BYTES,'EXTENSION_LIMIT','Extension exceeds package limit.');const data=await file(p,MAX_BYTES);if(!skip)files.push({relative:r,data});}
 }}await visit(root);return files;
}
async function writeTree(target,files){await fs.mkdir(target,{mode:0o700});for(const f of files){await fs.mkdir(path.dirname(path.join(target,f.relative)),{recursive:true});await fs.writeFile(path.join(target,f.relative),f.data,{flag:'wx',mode:0o600});}}
async function removeTree(target){await directory(target);const entries=await fs.readdir(target);for(const name of entries){const p=path.join(target,name),s=await fs.lstat(p);invariant(!s.isSymbolicLink(),'OWNERSHIP_UNVERIFIED','Unsafe extension cleanup.');if(s.isDirectory())await removeTree(p);else{invariant(s.isFile()&&s.nlink===1,'OWNERSHIP_UNVERIFIED','Unsafe extension cleanup.');await fs.unlink(p);}}await fs.rmdir(target);}

export class ExtensionLibrary {
 #tail=Promise.resolve();
 constructor(repository,runtimes,instances){this.repository=repository;this.runtimes=runtimes;this.instances=instances;}
 #exclusive(fn){const p=this.#tail.then(fn);this.#tail=p.catch(()=>{});return p;}
 list(){return this.repository.snapshot().extensionLibrary??[];}
 repairNames(){return this.#exclusive(async()=>{const updated=[],errors=[];for(const entry of this.list()){if(typeof entry.name!=='string'||!/^__MSG_[a-z0-9_@]+__$/i.test(entry.name))continue;try{const source=await this.packagePath(entry.id),m=await manifest(source),name=await displayName(source,m);if(name===entry.name||/^__MSG_[a-z0-9_@]+__$/i.test(name))continue;await this.repository.transaction(s=>{const current=s.extensionLibrary?.find(e=>e.id===entry.id);if(current&&current.name===entry.name)current.name=name;});updated.push(entry.id);}catch(e){errors.push({library_id:entry.id,code:e.code??'INVALID_EXTENSION',message:e.message});}}return {updated,errors};});}
 #entry(id){invariant(typeof id==='string'&&UUID.test(id),'INVALID_ARGUMENT','Extension library ID must be a UUID.');const e=this.list().find(x=>x.id===id);invariant(e,'EXTENSION_NOT_FOUND','Library extension does not exist.');return e;}
 async #instance(id){const instance=this.repository.snapshot().instances.find(i=>i.id===id&&i.status!=='deleted');invariant(instance,'INSTANCE_NOT_FOUND','Instance does not exist.');const runtime=this.runtimes.get(instance.runtimeId);invariant(['chrome','edge','brave'].includes(runtime.browser),'EXTENSION_UNSUPPORTED','Extension import supports Chromium browsers only.');return {instance,browser:runtime.browser,root:await this.repository.assertProfile(id)};}
 async #matching(extension_id,version,files){const digest=fingerprint(files);for(const entry of this.list()){if(entry.extension_id!==extension_id||entry.version!==version)continue;const p=await this.packagePath(entry.id);if(fingerprint(await tree(p))===digest)return entry;}return null;}
 async #remember(instance_id,id,entry,files){const record={entry:{...entry},sha256:fingerprint(files)};await this.repository.transaction(s=>{const instance=s.instances.find(i=>i.id===instance_id&&i.status!=='deleted');invariant(instance,'INSTANCE_NOT_FOUND','Instance does not exist.');(instance.extensionPackages??={})[id]=record;});return record;}
 async #selected(root,id,instance){invariant(UUID.test(id),'INVALID_ARGUMENT','Invalid private extension ID.');let record=instance.extensionPackages?.[id];const entry=record?.entry??this.#entry(id);invariant(EXT.test(entry.extension_id),'INVALID_EXTENSION','Invalid private extension identity.');const base=path.join(root,'.browser-flock-extensions');await directory(base);const source=path.join(base,id);await directory(source);const m=await manifest(source),files=await tree(source);
 if(!record){const original=await this.packagePath(id);invariant(fingerprint(files)===fingerprint(await tree(original)),'EXTENSION_COPY_CONFLICT','Selected instance extension code differs from the library.');record=await this.#remember(instance.id,id,entry,files);}
 invariant(record.entry.id===id&&m.version===entry.version&&fingerprint(files)===record.sha256,'EXTENSION_COPY_CONFLICT','Private instance extension code differs from its saved fingerprint.');return {entry,source,m,files};}
 async listInstalled(instance_id){const {root,instance}=await this.#instance(instance_id),items=[];let scanned=0,excluded_component_count=0;
 for(const profile of await fs.readdir(root)){if(!PROFILE.test(profile))continue;const profileRoot=path.join(root,profile);await directory(profileRoot);const extensions=path.join(profileRoot,'Extensions');try{await directory(extensions);}catch(e){if(e.code==='ENOENT')continue;throw e;}
 for(const id of await fs.readdir(extensions)){invariant(++scanned<=MAX_FILES,'EXTENSION_LIMIT','Too many installed extensions.');if(!EXT.test(id))continue;if(COMPONENT_IDS.has(id)){excluded_component_count++;continue;}const base=path.join(extensions,id);await directory(base);const versions=[];
 for(const name of await fs.readdir(base)){invariant(++scanned<=MAX_FILES,'EXTENSION_LIMIT','Too many extension versions.');if(!/^\d+(?:\.\d+){0,3}(?:_\d+)?$/.test(name))continue;const p=path.join(base,name);await directory(p);const m=await manifest(p);versions.push({extension_id:id,...summary(m),name:await displayName(p,m),source_profile:profile,source_key:name});}
 versions.sort((a,b)=>b.version.localeCompare(a.version,undefined,{numeric:true})||b.source_key.localeCompare(a.source_key,undefined,{numeric:true}));if(versions[0]){const found=versions[0],entry=await this.#matching(id,found.version,await tree(path.join(base,found.source_key)));items.push({...found,source_kind:'profile',collected:!!entry,...(entry?{library_id:entry.id}:{})});}
 }}
 // Only repository selections are installed packages; stale/unselected private folders are ignored.
 for(const id of new Set(instance.extensionLibraryIds??[])){invariant(++scanned<=MAX_FILES,'EXTENSION_LIMIT','Too many selected extensions.');if(COMPONENT_IDS.has((instance.extensionPackages?.[id]?.entry??this.#entry(id)).extension_id)){excluded_component_count++;continue;}let selected;try{selected=await this.#selected(root,id,instance);}catch(e){if(e.code==='ENOENT')continue;throw e;}const {entry,source,m,files}=selected,linked=await this.#matching(entry.extension_id,m.version,files);items.push({extension_id:entry.extension_id,...summary(m),name:await displayName(source,m),source_profile:`Library ${id}`,source_key:id,source_kind:'library',collected:!!linked,...(linked?{library_id:linked.id}:{})});}
 return {instance_id,items,excluded_component_count};}
 capture({instance_id,extension_id,source_profile='Default'}){return this.#exclusive(async()=>{
 const selected=selectedId(source_profile);invariant(EXT.test(extension_id??'')&&(PROFILE.test(source_profile)||selected),'INVALID_ARGUMENT','Invalid extension ID or source profile.');
 const found=(await this.listInstalled(instance_id)).items.find(e=>e.extension_id===extension_id&&e.source_profile===source_profile);invariant(found,'EXTENSION_NOT_FOUND','Extension is not installed in that owned profile.');
 const {root,browser,instance}=await this.#instance(instance_id);let source,files,existing;
 if(selected){invariant(instance.extensionLibraryIds?.includes(selected),'EXTENSION_NOT_FOUND','Extension selection no longer exists.');const checked=await this.#selected(root,selected,instance);({source,files}=checked);}else{source=path.join(root,source_profile,'Extensions',extension_id,found.source_key);files=await tree(source);}
 const m=JSON.parse(files.find(f=>f.relative==='manifest.json').data.toString('utf8')),name=await displayName(source,m);existing??=await this.#matching(extension_id,m.version,files);
 // Older library records may still contain the manifest's __MSG_ token. Repair metadata only.
 if(existing){if(existing.name!==name){await this.repository.transaction(s=>{s.extensionLibrary.find(e=>e.id===existing.id).name=name;});}return {...existing,name};}
 const id=randomUUID(),library=await this.repository.extensionLibraryRoot(),temporary=path.join(library,`.capture-${randomUUID()}`),target=path.join(library,id);
 const entry={id,extension_id,...summary(m),name,browser,createdAt:new Date().toISOString(),sourceInstanceId:instance_id,source_profile};let renamed=false;
 try{await writeTree(temporary,files);await manifest(temporary);await this.repository.extensionLibraryRoot();await fs.rename(temporary,target);renamed=true;await this.repository.transaction(s=>{(s.extensionLibrary??=[]).push(entry);});return entry;}
 catch(e){const cleanup=renamed?target:temporary;try{await removeTree(cleanup);}catch(c){if(c.code!=='ENOENT')e.cleanupFailed=true;}throw e;}
 });}
 async packagePath(id){this.#entry(id);const root=await this.repository.extensionLibraryRoot(),p=path.join(root,id);await directory(p);await tree(p);await manifest(p);return p;}
 copyForInstance(id,instance_id){return this.#exclusive(()=>this.#copyForInstance(id,instance_id));}
 async #copyForInstance(id,instance_id){const {root,instance}=await this.#instance(instance_id);
 if(instance.extensionPackages?.[id]){const selected=await this.#selected(root,id,instance);return {path:selected.source,entry:selected.entry};}
 const entry=this.#entry(id),source=await this.packagePath(id),files=await tree(source),base=path.join(root,'.browser-flock-extensions');
 try{await fs.mkdir(base,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}await directory(base);const target=path.join(base,id);
 let exists=false;try{await directory(target);exists=true;}catch(e){if(e.code!=='ENOENT')throw e;}
 if(exists){invariant(fingerprint(await tree(target))===fingerprint(files),'EXTENSION_COPY_CONFLICT','Existing instance extension code differs from the library.');}
 else{const temp=path.join(base,`.copy-${randomUUID()}`);try{await writeTree(temp,files);await this.repository.assertProfile(instance_id);await directory(base);await fs.rename(temp,target);}catch(e){try{await removeTree(temp);}catch(c){if(c.code!=='ENOENT')e.cleanupFailed=true;}throw e;}}
 await this.#remember(instance_id,id,entry,files);return {path:target,entry};}
 remove(id){return this.#exclusive(async()=>{this.#entry(id);
 // Preserve and verify all selected legacy packages before removing shared code. This
 // also covers a copy staged by installation before its selection has been committed.
 for(const instance of this.repository.snapshot().instances){if(instance.status==='deleted'||(!(instance.extensionLibraryIds??[]).includes(id)&&!instance.extensionPackages?.[id]))continue;await this.#copyForInstance(id,instance.id);}
 const p=await this.packagePath(id);await removeTree(p);await this.repository.transaction(s=>{s.extensionLibrary=(s.extensionLibrary??[]).filter(e=>e.id!==id);});return {id,deleted:true};});}
}
