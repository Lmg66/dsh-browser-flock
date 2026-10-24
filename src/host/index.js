import path from 'node:path';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { Repository } from './repository.js';
import { RecordingManager } from './recordings.js';
import { RuntimeRegistry } from './runtime-registry.js';
import { ExtensionLibrary } from './extensions.js';
import { InstanceManager } from './instance-manager.js';
import { WindowsPlatform } from './platform/windows.js';
import { Operations } from './operations.js';
import { contribution, parseJson } from '../shared/rpc.js';
import { apply as registerTools } from './tools.js';

export const name='browser-flock';
export const inject=['typert','tools','sandboxPolicy','profileContext'];
class BrowserFlockService extends TypertRemoteService {
  constructor(ctx,operations) {super(ctx,'browserFlock');this.operations=operations;}
  async dispatch(input) {return parseJson(await this.operations.dispatch(input));}
}
export function startBackgroundUpdates(runtimes,instances,status,{intervalMs=2000,schedule=setTimeout,cancel=clearTimeout,onError=error=>console.error('[browser-flock] background update failed:',error.message)}={}) {
  let stopped=false, timer, active=Promise.resolve(), first=true;
  const tick=()=>{
    status.state='updating';
    active=Promise.all([
      runtimes.scan().catch(error=>{onError(error);}),
      (async()=>{
        if(first) { first=false; await instances.recover(); }
        else for(const instance of instances.list()) {
          if(stopped) break;
          if(['running','starting','unknown','cleanup_pending'].includes(instance.status)) await instances.reconcile(instance.id);
        }
        status.state='current';status.last_checked_at=new Date().toISOString();
      })().catch(error=>{status.state='error';onError(error);})
    ]).finally(()=>{if(!stopped) timer=schedule(tick,intervalMs);});
  };
  // Mount saved data first. The next task starts expensive OS discovery/recovery.
  timer=schedule(tick,0);
  return async()=>{stopped=true;cancel(timer);await active;};
}
export async function apply(ctx,config={}) {
  if(process.platform!=='win32') throw new Error('Browser Flock currently requires Windows; other platform adapters are not yet validated.');
  const root=config.dataRoot??(ctx.profileContext.dir?path.join(ctx.profileContext.dir,'data','browser-flock'):null);
  if(!root||!path.isAbsolute(root)) throw new Error('Browser Flock requires an absolute dataRoot or profileContext.dir.');
  const repository=new Repository(root);
  await repository.open();
  try {
  const platform=new WindowsPlatform();
  const runtimes=new RuntimeRegistry(repository,platform);
  const instances=new InstanceManager(repository,runtimes,platform);
   instances.extensionLibrary=new ExtensionLibrary(repository,runtimes,instances);
   await instances.extensionLibrary.repairNames();
  const backgroundStatus={state:'pending',last_checked_at:null};
  const recordings=new RecordingManager(repository,instances);
   await recordings.open();
   new BrowserFlockService(ctx,new Operations(repository,runtimes,instances,{backgroundStatus,recordings}));
  ctx.typert.register(contribution);
  registerTools(ctx);
  ctx.effect(()=>{
    const stop=startBackgroundUpdates(runtimes,instances,backgroundStatus);
    return async()=>{try {await stop();await recordings.close();await platform.dispose();} finally {await repository.close();}};
  });
  } catch(error) {
    await repository.close();
    throw error;
  }
}
