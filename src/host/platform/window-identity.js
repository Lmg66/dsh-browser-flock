import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,lstat,realpath} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
const helper=fileURLToPath(new URL('./window-identity.ps1',import.meta.url));
const palette=['#3478f6','#8b5cf6','#0891b2','#db2777','#d97706','#059669','#dc2626','#4f46e5'];
export function getInstanceAppearance(id){const hash=createHash('sha256').update(id).digest();return {color:palette[hash[0]%palette.length],label:String.fromCharCode(65+hash[1]%26)};}
export function windowIdentityPayload(instance,runtime,{readOnly=false}={}) {
 if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(instance.id))throw new TypeError('Instance UUID is required.');
 const p=instance.processIdentity;
 if(!p||!Number.isSafeInteger(p.pid)||p.pid<=0||!p.startTime||!p.commandLine||!p.executablePath)throw new TypeError('Confirmed process identity is required.');
 const norm=s=>path.win32.normalize(s).toLowerCase();
 if(norm(p.executablePath)!==norm(runtime.executablePath))throw new TypeError('Runtime executable does not match process identity.');
 if(!path.win32.isAbsolute(instance.profilePath))throw new TypeError('Absolute owned profile directory is required.');
 const tokens=p.commandLine.match(/(?:[^\s"]+|"[^"]*")+/g)?.map(t=>t.replaceAll('"',''))??[];
 if(!tokens.some((s,i)=>norm(s)===norm(`--user-data-dir=${instance.profilePath}`)||(['-profile','--profile'].includes(s)&&tokens[i+1]&&norm(tokens[i+1])===norm(instance.profilePath))))throw new TypeError('Process command line does not own this profile.');
 const requestId=randomUUID(),directory=path.join(instance.profilePath,`.browser-flock-window-${requestId}`);
 return {requestId,directory,hostPid:process.pid,pid:p.pid,startTime:p.startTime,commandLine:p.commandLine,executablePath:p.executablePath,appId:`BrowserFlock.Instance.${instance.id}`,iconPath:path.join(directory,'instance.ico'),statusPath:path.join(directory,'status.json'),stopPath:path.join(directory,'stop'),...getInstanceAppearance(instance.id),readOnly};
}
async function safeDirectory(directory){const stat=await lstat(directory);if(stat.isSymbolicLink()||!stat.isDirectory()||path.resolve(await realpath(directory)).toLowerCase()!==path.resolve(directory).toLowerCase())throw new Error('Window identity directory ownership changed.');}
/** Caller first asserts Repository profile ownership. Returns promptly; ready resolves independently.
 * stop restores original HWND icons/properties, then ends only this helper.
 */
export async function beginWindowIdentity(instance,runtime,{env=process.env,spawnProcess=spawn,readOnly=false,waitMs=10000}={}) {
 const payload=windowIdentityPayload(instance,runtime,{readOnly});
 await safeDirectory(instance.profilePath);await mkdir(payload.directory);await safeDirectory(payload.directory);
 const child=spawnProcess(path.win32.join(env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper,'-Payload',Buffer.from(JSON.stringify(payload),'utf8').toString('base64')],{stdio:'ignore',windowsHide:true,detached:false,env:{...env,PSModulePath:path.win32.join(env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','Modules')}});
 const exited=new Promise(resolve=>child.once('exit',code=>resolve(code)));
 await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
 const info={helperPid:child.pid,statusPath:payload.statusPath,appId:payload.appId,iconPath:payload.iconPath};
 const ready=(async()=>{const deadline=Date.now()+waitMs;while(Date.now()<deadline){
  try{const status=JSON.parse((await readFile(payload.statusPath,'utf8')).replace(/^\uFEFF/,''));if(status.requestId===payload.requestId&&['applied','read','error'].includes(status.status))return {...info,...status};}catch{}
  if(child.exitCode!==null)return {...info,status:'error',message:`Window identity helper exited before applying (code ${child.exitCode}).`};
  await new Promise(resolve=>setTimeout(resolve,100));
 }return {...info,status:'pending'};})();
 return {...info,ready,exited,async stop(){
  if(child.exitCode!==null)return;
  try{await safeDirectory(payload.directory);await writeFile(payload.stopPath,'stop',{flag:'wx'});}catch(error){if(error.code!=='ENOENT'&&error.code!=='EEXIST')throw error;}
  let timer;const outcome=await Promise.race([exited.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),5000);})]);clearTimeout(timer);
  if(!outcome)throw new Error('Window identity helper did not stop gracefully; no browser was terminated.');
 }};
}
export async function startWindowIdentity(instance,runtime,options){const controller=await beginWindowIdentity(instance,runtime,options);return controller.ready;}
