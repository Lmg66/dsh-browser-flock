import { randomUUID } from 'node:crypto';
import { strictObject, text, integer, proxyConfig } from '../shared/validation.js';
import { invariant, failure } from '../shared/errors.js';

const fields = {
  get_browser_flock_snapshot:[],list_browser_extensions:['offset','limit'],
  start_browser_recording:['instance_id','name'],stop_browser_recording:['recording_id'],delete_browser_recording:['recording_id'],list_browser_recordings:['offset','limit'],get_browser_recording:['recording_id'],list_browser_recording_events:['recording_id','offset','limit'],get_browser_recording_request:['recording_id','request_id'],
  list_instance_extensions:['instance_id'],capture_browser_extension:['instance_id','extension_id','source_profile'],install_browser_extension:['instance_id','library_id'],remove_browser_extension:['library_id'],remove_instance_extension:['instance_id','library_id'],
  list_browser_proxy_presets:['offset','limit'],save_browser_proxy_preset:['preset_id','name','proxy'],delete_browser_proxy_preset:['preset_id'],
  list_browser_runtimes:['refresh','offset','limit'], get_browser_runtime:['runtime_id'],
  register_browser_runtime:['browser','path','name'], remove_browser_runtime:['runtime_id'],
  set_default_browser_runtime:['runtime_id'], open_browser_runtime_directory:['runtime_id'],
  open_browser_instance:['runtime_id','instance_id','name','mode','url','request_id','cdp','proxy','proxy_preset_id','extension_library_ids'],
  get_browser_instance_cdp:['instance_id'],
  list_browser_instances:['offset','limit','status','runtime_id','mode'],
  get_browser_instance:['instance_id'],rename_browser_instance:['instance_id','name'],
  close_browser_instance:['instance_id','force','timeout_ms'],delete_browser_instance:['instance_id'],
};
export const operationNames=Object.freeze(Object.keys(fields));
function pageOptions(args) {
  const offset=args.offset===undefined?0:args.offset,limit=args.limit===undefined?20:args.limit;
  integer(offset,0,Number.MAX_SAFE_INTEGER,'offset');integer(limit,1,100,'limit');
  return {offset,limit};
}
function page(items,args) {
  const {offset,limit}=pageOptions(args);
  return {items:items.slice(offset,offset+limit),total:items.length,offset,limit,next_offset:offset+limit<items.length?offset+limit:null};
}
/** Shared boundary for global UI and agent Tools; operation-specific validation is mandatory here. */
export class Operations {
  constructor(repository,runtimes,instances,{backgroundStatus={state:'pending',last_checked_at:null},recordings=null}={}) {this.repository=repository;this.runtimes=runtimes;this.instances=instances;this.backgroundStatus=backgroundStatus;this.recordings=recordings;}
  snapshot() {
    // UI reads never start OS work or join the instance mutation queue.
    const saved=this.repository.snapshot();
    const recordingRows=this.recordings?.list({limit:100}).items??[];
    for(const recording_id of this.recordings?.active?.keys()??[])if(!recordingRows.some(r=>r.id===recording_id))recordingRows.push(this.recordings.get({recording_id}));
    return {recordings:recordingRows,extension_library:this.instances.extensionLibrary?.list()??[],proxy_presets:saved.proxyPresets??[],runtimes:saved.runtimes,instances:saved.instances,default_runtime_id:saved.defaultRuntimeId??null,captured_at:new Date().toISOString(),freshness:{runtimes:this.runtimes.freshness(),instances:{...this.backgroundStatus}}};
  }
  async dispatch(input) {
    try {
      strictObject(input,['action','args']);
      invariant(typeof input.action==='string'&&Object.hasOwn(fields,input.action),'INVALID_ARGUMENT','Unknown browser operation.');
      const args=input.args===undefined?{}:input.args;strictObject(args,fields[input.action]);
      if(input.action==='list_browser_runtimes'||input.action==='list_browser_instances') pageOptions(args);
      if(fields[input.action].includes('runtime_id')&&input.action!=='open_browser_instance'&&input.action!=='list_browser_instances') text(args.runtime_id,'runtime_id',128);
      if(fields[input.action].includes('instance_id')&&input.action!=='open_browser_instance') text(args.instance_id,'instance_id',128);
      if(fields[input.action].includes('recording_id'))text(args.recording_id,'recording_id',128);
      let data;
      switch(input.action) {
        case 'start_browser_recording':if(args.name!==undefined)text(args.name,'name',120);data=await this.recordings.start(args);break;
        case 'stop_browser_recording':data=await this.recordings.stop(args);break;
        case 'delete_browser_recording':data=await this.recordings.delete(args);break;
        case 'list_browser_recordings':pageOptions(args);data=this.recordings.list(args);break;
        case 'get_browser_recording':data=this.recordings.get(args);break;
        case 'list_browser_recording_events':pageOptions(args);data=await this.recordings.listEvents(args);break;
        case 'get_browser_recording_request':text(args.request_id,'request_id',128);data=await this.recordings.getRequest(args);break;
        case 'list_browser_extensions':data=page(this.instances.extensionLibrary.list(),args);break;
        case 'list_instance_extensions':data=await this.instances.exclusive(()=>this.instances.extensionLibrary.listInstalled(args.instance_id));break;
        case 'capture_browser_extension':
          text(args.extension_id,'extension_id',128);if(args.source_profile!==undefined)text(args.source_profile,'source_profile',128);
          data=await this.instances.exclusive(()=>this.instances.extensionLibrary.capture(args));break;
        case 'install_browser_extension':data=await this.instances.installExtension(args);break;
        case 'remove_instance_extension':data=await this.instances.removeExtension(args);break;
        case 'remove_browser_extension':text(args.library_id,'library_id',128);data=await this.instances.exclusive(()=>this.instances.extensionLibrary.remove(args.library_id));break;
        case 'list_browser_proxy_presets': data=page(this.repository.snapshot().proxyPresets??[],args);break;
        case 'save_browser_proxy_preset': {
          const name=text(args.name,'name'),proxy=proxyConfig(args.proxy);
          invariant(['http','socks5'].includes(proxy.mode),'INVALID_ARGUMENT','Presets require HTTP or SOCKS5.');
          invariant(args.proxy!==undefined,'INVALID_ARGUMENT','proxy is required.');
          const id=args.preset_id===undefined?randomUUID():text(args.preset_id,'preset_id',128),stamp=new Date().toISOString();
          await this.instances.exclusive(()=>this.repository.transaction(state=>{
            state.proxyPresets??=[];
            const old=state.proxyPresets.find(p=>p.id===id);
            invariant(args.preset_id===undefined||old,'PROXY_PRESET_NOT_FOUND','Proxy preset does not exist.');
            data={id,name,proxy,createdAt:old?.createdAt??stamp,updatedAt:stamp};
            if(old) Object.assign(old,data);else state.proxyPresets.push(data);
          }));break;
        }
        case 'delete_browser_proxy_preset': {
          const id=text(args.preset_id,'preset_id',128);
          await this.instances.exclusive(()=>this.repository.transaction(state=>{
            invariant(state.proxyPresets?.some(p=>p.id===id),'PROXY_PRESET_NOT_FOUND','Proxy preset does not exist.');
            state.proxyPresets=state.proxyPresets.filter(p=>p.id!==id);
          }));data={id,deleted:true};break;
        }
        case 'get_browser_flock_snapshot':data=this.snapshot();break;
        case 'list_browser_runtimes':
          invariant(args.refresh===undefined||typeof args.refresh==='boolean','INVALID_ARGUMENT','refresh must be boolean.');
          data={...page(await this.runtimes.scan({refresh:args.refresh??false}),args),default_runtime_id:this.repository.snapshot().defaultRuntimeId};break;
        case 'get_browser_runtime': data=this.runtimes.get(args.runtime_id);break;
        case 'register_browser_runtime': data=await this.instances.exclusive(()=>this.runtimes.register(args));break;
        case 'remove_browser_runtime': data=await this.instances.exclusive(()=>this.runtimes.remove(args.runtime_id));break;
        case 'set_default_browser_runtime': data=await this.runtimes.setDefault(args.runtime_id);break;
        case 'open_browser_runtime_directory': data=await this.runtimes.openDirectory(args.runtime_id);break;
        case 'open_browser_instance': data=await this.instances.open(args);break;
        case 'list_browser_instances': {
          for(const key of ['status','runtime_id','mode']) if(args[key]!==undefined) text(args[key],key,128);
          for(const instance of this.instances.list()) await this.instances.reconcile(instance.id);
          data=page(this.instances.list().filter(i=>(args.status===undefined||i.status===args.status)&&(args.runtime_id===undefined||i.runtimeId===args.runtime_id)&&(args.mode===undefined||i.mode===args.mode)),args);break;
        }
        case 'get_browser_instance_cdp':data=await this.instances.getCdp(args.instance_id);break;
        case 'get_browser_instance':data=await this.instances.reconcile(args.instance_id);break;
        case 'rename_browser_instance':data=await this.instances.rename(args.instance_id,args.name);break;
        case 'close_browser_instance': {
          const force=args.force===undefined?false:args.force,timeout_ms=args.timeout_ms===undefined?10000:args.timeout_ms;
          invariant(typeof force==='boolean','INVALID_ARGUMENT','force must be a boolean.');
          integer(timeout_ms,1000,60000,'timeout_ms');
          data=await this.instances.close(args.instance_id,{force,timeout_ms});break;
        }
        case 'delete_browser_instance':data=await this.instances.delete(args.instance_id);break;
      }
      return {ok:true,data};
    } catch(error) {return failure(error);}
  }
}
