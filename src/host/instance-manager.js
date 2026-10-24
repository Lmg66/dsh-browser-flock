import { randomUUID, createHash } from 'node:crypto';
import { discoverCdp, loadUnpackedExtension, uninstallExtension } from './cdp.js';
import { getInstanceAppearance } from './platform/window-identity.js';
import { FlockError, invariant } from '../shared/errors.js';
import { openInput, text, integer, proxyConfig } from '../shared/validation.js';

const now = () => new Date().toISOString();
/** Serializes operations within this Host; Repository provides cross-Host exclusion. */
export class InstanceManager {
  constructor(repository, runtimes, platform, { maxRunningInstances = 10, discoverExtensionCdp=discoverCdp, loadExtension=loadUnpackedExtension, unloadExtension=uninstallExtension, extensionReadyTimeoutMs=8000 } = {}) {
    this.repository=repository; this.runtimes=runtimes; this.platform=platform;
    this.discoverExtensionCdp=discoverExtensionCdp;this.loadExtension=loadExtension;this.unloadExtension=unloadExtension;this.extensionReadyTimeoutMs=extensionReadyTimeoutMs;
    this.maxRunningInstances=maxRunningInstances; this.tail=Promise.resolve();
  }
  exclusive(operation) {
    const task=this.tail.then(operation); this.tail=task.catch(()=>{}); return task;
  }
  list() { return this.repository.snapshot().instances; }
  get(id) {
    const found=this.list().find(i=>i.id===id) ?? this.repository.snapshot().tombstones.find(i=>i.id===id);
    invariant(found,'INSTANCE_NOT_FOUND','Instance does not exist.'); return found;
  }
  async update(id, change) {
    await this.repository.transaction(state=>{
      const instance=state.instances.find(i=>i.id===id);
      invariant(instance,'INSTANCE_NOT_FOUND','Instance does not exist.');
      Object.assign(instance,change,{updatedAt:now()});
    });
    return this.get(id);
  }
  open(raw) { return this.exclusive(()=>this.openLocked(openInput(raw))); }
  async openLocked(input) {
    let instance;
    const fingerprint=createHash('sha256').update(JSON.stringify({runtime_id:input.runtime_id,name:input.name,mode:input.mode,url:input.url,...(input.proxy===undefined?{}:{proxy:input.proxy}),...(input.proxy_preset_id===undefined?{}:{proxy_preset_id:input.proxy_preset_id}),...(input.cdp===undefined?{}:{cdp:input.cdp}),...(input.extension_library_ids===undefined?{}:{extension_library_ids:input.extension_library_ids})})).digest('hex');
    const requestKey=input.request_id ? createHash('sha256').update(input.request_id).digest('hex') : null;
    if(requestKey) {
      const old=this.repository.snapshot().requests[requestKey];
      if(old && old.expiresAt>Date.now()) {
        invariant(old.fingerprint===fingerprint,'REQUEST_CONFLICT','Request ID was already used with different arguments.');
        return {instance:this.get(old.instanceId),created:false,replayed:true};
      }
    }
    if(input.instance_id) {
      instance=this.get(input.instance_id);
      invariant(instance.status!=='deleted','INSTANCE_NOT_FOUND','Deleted instances cannot be reopened.');
      instance=await this.reconcileLocked(instance.id);
      if(instance.status==='running') {
        invariant(input.cdp===undefined || input.cdp===instance.cdpEnabled,'INSTANCE_ALREADY_RUNNING','Close and reopen the instance to change CDP.');
        invariant(input.url===undefined,'INSTANCE_ALREADY_RUNNING','Cannot append a URL to an already running instance.');
        return {instance,created:false,already_running:true};
      }
      invariant(['stopped','error'].includes(instance.status),'INSTANCE_BUSY','Instance is not safely reopenable.');
      invariant(instance.mode==='persistent','INVALID_ARGUMENT','Temporary instances cannot be restored after exit.');
    }
    const runtime=this.runtimes.get(instance?.runtimeId ?? input.runtime_id);
    const cdpEnabled=input.cdp ?? instance?.cdpEnabled ?? runtime.browser!=='firefox';
    invariant(!cdpEnabled || runtime.browser!=='firefox','CDP_UNSUPPORTED','Firefox does not support Chromium CDP.');
    invariant(runtime.available,'RUNTIME_UNAVAILABLE','Browser installation is unavailable.');
    invariant(this.list().filter(i=>['creating','starting','running','stopping','unknown'].includes(i.status)).length<this.maxRunningInstances,'INSTANCE_LIMIT_REACHED','Too many potentially running instances.');
    if(!instance) {
      const extensionLibraryIds=input.extension_library_ids??[];
      if(extensionLibraryIds.length) {
        invariant(['chrome','edge','brave'].includes(runtime.browser),'EXTENSION_UNSUPPORTED','Extensions require a Chromium browser.');
        invariant(cdpEnabled,'CDP_DISABLED','New instances with extensions require CDP.');
        const library=this.extensionLibrary?.list()??[];
        for(const id of extensionLibraryIds) invariant(library.some(entry=>entry.id===id),'EXTENSION_NOT_FOUND','Library extension does not exist.');
      }
      const preset=input.proxy_preset_id===undefined?null:this.repository.snapshot().proxyPresets?.find(p=>p.id===input.proxy_preset_id);
      invariant(input.proxy_preset_id===undefined||preset,'PROXY_PRESET_NOT_FOUND','Proxy preset does not exist.');
      const proxy=proxyConfig(preset?.proxy??input.proxy);
      const id=randomUUID();
      instance={id,proxy,extensionLibraryIds,name:input.name??`${runtime.name ?? runtime.browser} ${new Date().toLocaleString('en-GB')}`,runtimeId:runtime.id,mode:input.mode,profilePath:this.repository.profilePath(id),status:'creating',readiness:'unknown',processIdentity:null,createdAt:now(),updatedAt:now(),lastError:null,schemaVersion:1};
      await this.repository.transaction(state=>{
        state.instances.push(instance);
        if(requestKey) state.requests[requestKey]={fingerprint,instanceId:id,expiresAt:Date.now()+86400000};
      });
      try { await this.repository.createProfile(id); }
      catch(error) { await this.update(id,{status:'error',lastError:{code:error.code??'PROFILE_CREATE_FAILED',stage:'profile'}}); throw new FlockError(error.code??'PROFILE_CREATE_FAILED','Could not create the owned profile.',{details:{instance_id:id}}); }
    }
    const profilePath=await this.repository.assertProfile(instance.id);
    invariant(instance.profilePath===profilePath,'OWNERSHIP_UNVERIFIED','Instance profile path does not match its owned profile.');
    await this.update(instance.id,{status:'starting',readiness:'unknown',lastError:null,cdpEnabled,appearance:getInstanceAppearance(instance.id)});
    try {
      const result=await this.platform.launch(runtime,instance.profilePath,input.url,{cdp:cdpEnabled,proxy:proxyConfig(instance.proxy)});
      invariant(result.processIdentity,'OWNERSHIP_UNVERIFIED','Started process identity could not be confirmed.');
      const updated=await this.update(instance.id,{status:'running',processIdentity:result.processIdentity,readiness:result.readiness??'unknown',lastOpenedAt:now()});
      try { this.platform.ensureWindowIdentity?.(updated,runtime); } catch { /* Browser launch remains valid if a cosmetic helper is unavailable. */ }
      const extensionLoadResults=await this.reapplyExtensions(updated,runtime);
      const warnings=extensionLoadResults.filter(r=>r.status==='error');
      return {instance:this.get(instance.id),created:!input.instance_id,...(warnings.length?{warnings}: {})};
    } catch(error) {
      // A failing launch may already have created processes. Preserve the directory.
      await this.update(instance.id,{status:'unknown',lastError:{code:error.code??'START_FAILED',stage:'launch'}});
      throw new FlockError(error.code??'START_FAILED','Browser launch could not be confirmed.',{details:{instance_id:instance.id,status:'unknown'},recoveryHint:'Query this instance before retrying.'});
    }
  }
  async extensionEndpoint(instance,runtime) {
    invariant(runtime.browser!=='firefox','EXTENSION_UNSUPPORTED','Firefox extension installation is not supported.');
    invariant(instance.cdpEnabled,'CDP_DISABLED','Enable CDP by closing and reopening this instance before installing extensions.');
    const deadline=Date.now()+this.extensionReadyTimeoutMs;
    do {
      const endpoint=await this.discoverExtensionCdp(instance,runtime);
      if(endpoint.status==='ready') return endpoint;
      if(Date.now()>=deadline) break;
      await new Promise(resolve=>setTimeout(resolve,Math.min(200,deadline-Date.now())));
    }while(Date.now()<deadline);
    throw new FlockError('CDP_NOT_READY','Browser extension connection is not ready; retry after startup.');
  }
  async reapplyExtensions(instance,runtime) {
    const ids=instance.extensionLibraryIds??[];if(!ids.length)return [];
    const results=[];let endpoint,connectionError;
    try {endpoint=await this.extensionEndpoint(instance,runtime);}catch(error){connectionError=error;}
    for(const library_id of ids) {
      try {
        if(connectionError)throw connectionError;
        const copy=await this.extensionLibrary.copyForInstance(library_id,instance.id);
        const loaded=await this.loadExtension(endpoint,copy.path);
        results.push({library_id,status:'installed',extension_id:loaded.id});
      }catch(error){results.push({library_id,status:'error',message:error.message??'Extension could not be loaded.'});}
    }
    // Extension failure must never turn a confirmed running browser into unknown.
    try {await this.update(instance.id,{extensionLoadResults:results});}catch(error){results.push({library_id:null,status:'error',message:`Could not save extension results: ${error.message}`});}
    return results;
  }
  installExtension({instance_id,library_id}) {return this.exclusive(async()=>{
    text(instance_id,'instance_id',128);text(library_id,'library_id',128);
    const before=this.get(instance_id);invariant(before.status!=='deleted','INSTANCE_NOT_FOUND','Instance has been deleted.');
    const runtime=this.runtimes.get(before.runtimeId);
    invariant(runtime.browser!=='firefox','EXTENSION_UNSUPPORTED','Firefox extension installation is not supported.');
    const instance=await this.reconcileLocked(instance_id);
    invariant(instance.status==='running'||(instance.status==='stopped'&&instance.mode==='persistent'),'INSTANCE_BUSY','Extension installation requires an owned running browser or stopped persistent instance.');
    await this.repository.assertProfile(instance_id);
    const endpoint=instance.status==='running'?await this.extensionEndpoint(instance,runtime):null;
    const copy=await this.extensionLibrary.copyForInstance(library_id,instance_id);
    const loaded=endpoint?await this.loadExtension(endpoint,copy.path):null;
    const status=loaded?'installed':'queued';
    const result={library_id,status,...(loaded?{extension_id:loaded.id}:{})};
    const updated=await this.update(instance_id,{extensionLibraryIds:[...new Set([...(instance.extensionLibraryIds??[]),library_id])],extensionLoadResults:[...(instance.extensionLoadResults??[]).filter(r=>r.library_id!==library_id),result]});
    return {instance:updated,extension:copy.entry,status,...(loaded?{extension_id:loaded.id}:{})};
  });}
  removeExtension({instance_id,library_id}) {return this.exclusive(async()=>{
    text(instance_id,'instance_id',128);text(library_id,'library_id',128);
    const instance=await this.reconcileLocked(instance_id);
    invariant(instance.status==='running'||(instance.status==='stopped'&&instance.mode==='persistent'),'INSTANCE_BUSY','Extension removal requires an owned running browser or stopped persistent instance.');
    invariant((instance.extensionLibraryIds??[]).includes(library_id),'EXTENSION_NOT_SELECTED','Only extensions selected from the extension center can be removed.');
    await this.repository.assertProfile(instance_id);
    let extensionId;
    if(instance.status==='running') {
      const loaded=(instance.extensionLoadResults??[]).find(r=>r.library_id===library_id&&r.status==='installed');
      invariant(typeof loaded?.extension_id==='string'&&/^[a-p]{32}$/.test(loaded.extension_id),'EXTENSION_ID_UNVERIFIED','No confirmed loaded extension ID is available. Close the persistent instance to remove its selection.');
      extensionId=loaded.extension_id;
      const endpoint=await this.extensionEndpoint(instance,this.runtimes.get(instance.runtimeId));
      try {await this.unloadExtension(endpoint,extensionId);}
      catch(error) {throw new FlockError('EXTENSION_UNINSTALL_FAILED',`Browser could not uninstall the extension: ${error.message??'command failed'}`,{recoveryHint:'The selection was retained. This browser may not support extension uninstall; close the persistent instance to remove its selection.'});}
    }
    const updated=await this.update(instance_id,{extensionLibraryIds:(instance.extensionLibraryIds??[]).filter(id=>id!==library_id),extensionLoadResults:(instance.extensionLoadResults??[]).filter(r=>r.library_id!==library_id),extensionPackages:Object.fromEntries(Object.entries(instance.extensionPackages??{}).filter(([id])=>id!==library_id))});
    return {instance:updated,library_id,removed:true,status:extensionId?'uninstalled':'selection_removed',...(extensionId?{extension_id:extensionId}:{})};
  });}
  getCdp(id) { return this.exclusive(async()=>{
    const before=this.get(id);
    invariant(before.status!=='deleted','INSTANCE_NOT_FOUND','Instance has been deleted.');
    const runtime=this.runtimes.get(before.runtimeId);
    const instance=await this.reconcileLocked(id);
    if(instance.status==='deleted') return {instance_id:id,supported:runtime.browser!=='firefox',enabled:false,status:'stopped'};
    await this.repository.assertProfile(id);
    if(instance.status==='unknown') throw new FlockError('OWNERSHIP_UNVERIFIED','Cannot return a CDP endpoint without confirmed process ownership.');
    return {instance_id:id,...await discoverCdp(instance,runtime)};
  }); }
  reconcile(id) { return this.exclusive(()=>this.reconcileLocked(id)); }
  async reconcileLocked(id) {
    const instance=this.get(id);
    if(instance.status==='deleted') return instance;
    const runtime=this.runtimes.get(instance.runtimeId);
    let result;
    try { result=await this.platform.inspectInstance(instance,runtime); }
    catch { return this.update(id,{status:'unknown',lastError:{code:'OWNERSHIP_UNVERIFIED',stage:'inspect'}}); }
    if(result.status==='running') {
      const updated=await this.update(id,{status:'running',appearance:getInstanceAppearance(id),...(result.processIdentity?{processIdentity:result.processIdentity}:{})});
      if(this.platform.ensureWindowIdentity) {
        try { await this.repository.assertProfile(id);this.platform.ensureWindowIdentity(updated,runtime); }
        catch { /* Cosmetic updates must not weaken profile ownership checks. */ }
      }
      return updated;
    }
    if(result.status!=='stopped') return this.update(id,{status:'unknown'});
    if(instance.mode==='ephemeral'||['deleting','cleanup_pending'].includes(instance.status)) return this.cleanupLocked(id);
    return this.update(id,{status:'stopped',lastExitAt:instance.lastExitAt??now(),readiness:'unknown'});
  }
  close(id,{force=false,timeout_ms=10000}={}) { return this.exclusive(async()=>{
    invariant(typeof force==='boolean','INVALID_ARGUMENT','force must be a boolean.');
    integer(timeout_ms,1000,60000,'timeout_ms');
    const instance=this.get(id);
    if(instance.status==='deleted') return {instance,data_retained:false};
    await this.update(id,{status:'stopping'});
    let result;
    try { result=await this.platform.closeInstance(instance,this.runtimes.get(instance.runtimeId),{force,timeoutMs:timeout_ms}); }
    catch(error) {
      await this.update(id,{status:'unknown',lastError:{code:error.code??'CLOSE_FAILED',stage:'close'}}); throw error;
    }
    if(result.status!=='stopped') {
      await this.update(id,{status:result.status==='running'?'running':'unknown'});
      throw new FlockError(result.status==='running'?'CLOSE_TIMEOUT':'OWNERSHIP_UNVERIFIED','Browser exit could not be confirmed.',{retryable:true,details:{instance_id:id}});
    }
    const updated=instance.mode==='ephemeral'?await this.cleanupLocked(id):await this.update(id,{status:'stopped',readiness:'unknown',lastExitAt:now()});
    return {instance:updated,data_retained:updated.status!=='deleted',forced:force,cleanup:updated.status};
  }); }
  rename(id,name) { return this.exclusive(()=>{
    const instance=this.get(id);
    invariant(instance.status!=='deleted','INSTANCE_NOT_FOUND','Deleted instances cannot be renamed.');
    return this.update(id,{name:text(name,'name')});
  }); }
  delete(id) { return this.exclusive(async()=>{
    const instance=this.get(id);
    if(instance.status==='deleted') return instance;
    const result=await this.platform.inspectInstance(instance,this.runtimes.get(instance.runtimeId));
    invariant(result.status==='stopped',result.status==='running'?'INSTANCE_RUNNING':'OWNERSHIP_UNVERIFIED','Deletion requires confirmed process exit.');
    await this.update(id,{status:'deleting'});
    return this.cleanupLocked(id);
  }); }
  async cleanupLocked(id) {
    await this.update(id,{status:'cleanup_pending'});
    try { await this.repository.removeProfile(id); }
    catch(error) { return this.update(id,{status:'cleanup_pending',lastError:{code:error.code??'CLEANUP_FAILED',stage:'cleanup'}}); }
    const tombstone={id,status:'deleted',deletedAt:now(),expiresAt:Date.now()+7*86400000,cleanup:'complete'};
    await this.repository.transaction(state=>{state.instances=state.instances.filter(i=>i.id!==id);state.tombstones.push(tombstone);});
    return tombstone;
  }
  async recover() {
    for(const instance of this.list()) await this.reconcile(instance.id);
    await this.repository.transaction(state=>{
      state.tombstones=state.tombstones.filter(t=>t.expiresAt>Date.now()||Object.values(state.requests).some(r=>r.instanceId===t.id&&r.expiresAt>Date.now()));
      for(const [key,request] of Object.entries(state.requests)) if(request.expiresAt<=Date.now()) delete state.requests[key];
    });
  }
}
