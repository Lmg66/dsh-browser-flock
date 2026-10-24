import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { prepareFirefoxProxy } from '../proxy.js';
import { launchArguments } from '../browser-adapters.js';
import { beginWindowIdentity } from './window-identity.js';
import { FlockError, invariant } from '../../shared/errors.js';
const execute = promisify(execFile);
const brands = {
  chrome:{name:'Google Chrome',file:'chrome.exe',product:/Google Chrome/i,publisher:/CN=Google (?:LLC|Inc\.)[, ]/i},
  edge:{name:'Microsoft Edge',file:'msedge.exe',product:/Microsoft Edge/i,publisher:/CN=Microsoft Corporation[, ]/i},
  brave:{name:'Brave',file:'brave.exe',product:/Brave/i,publisher:/(?:^|,\s*)CN=(?:"Brave Software, Inc\."|Brave Software,? Inc\.?)(?:,|$)/i},
  firefox:{name:'Firefox',file:'firefox.exe',product:/Firefox/i,publisher:/CN=Mozilla Corporation[, ]/i},
};
const normalize = value => path.win32.normalize(value).toLowerCase();
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
function encoded(value) { return Buffer.from(JSON.stringify(value),'utf8').toString('base64'); }
export function profileInCommand(command, profile) {
  if(typeof command!=='string') return false;
  const tokens=command.match(/(?:[^\s"]+|"[^"]*")+/g)?.map(t=>t.replaceAll('"','')) ?? [];
  return tokens.some((token,index)=>normalize(token)===normalize(`--user-data-dir=${profile}`)||(['-profile','--profile'].includes(token)&&tokens[index+1]&&normalize(tokens[index+1])===normalize(profile)));
}
export class WindowsPlatform {
  constructor({env=process.env,executeCommand=execute,spawnProcess=spawn}={}) { this.platform='win32';this.env=env;this.executeCommand=executeCommand;this.spawnProcess=spawnProcess; }
  ensureWindowIdentity(instance,runtime) {
    if(this.windowIdentityDisposed||instance.status!=='running')return;
    this.windowIdentities??=new Map();
    const key=`${instance.processIdentity?.pid}:${instance.processIdentity?.startTime}`;
    const previous=this.windowIdentities.get(instance.id);
    if(previous?.key===key)return;
    const entry={key,result:{status:'pending'}};this.windowIdentities.set(instance.id,entry);
    entry.task=(async()=>{
      if(previous){await previous.task;await previous.controller?.stop();}
      if(this.windowIdentityDisposed)return;
      const controller=await beginWindowIdentity(instance,runtime,{env:this.env,spawnProcess:this.spawnProcess});entry.controller=controller;
      if(this.windowIdentityDisposed){await controller.stop();return;}
      entry.result=await controller.ready;
    })().catch(error=>{entry.result={status:'error',message:error.message};});
  }
  getWindowIdentityStatus(instanceId){return this.windowIdentities?.get(instanceId)?.result??null;}
  async dispose() {
    this.windowIdentityDisposed=true;
    const entries=[...(this.windowIdentities?.values()??[])];
    await Promise.all(entries.map(async entry=>{await entry.controller?.stop();await entry.task;await entry.controller?.stop();}));
    this.windowIdentities?.clear();
  }
  async powershell(body,input={}, {timeoutMs=20000}={}) {
    const script=`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded(input)}'))|ConvertFrom-Json; ${body}`;
    const exe=path.win32.join(this.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    const result=await this.executeCommand(exe,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',timeout:Math.max(1,Math.ceil(timeoutMs)),maxBuffer:8*1024*1024,windowsHide:true,env:{...this.env,PSModulePath:path.win32.join(this.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','Modules')}});
    const data=result.stdout.replace(/^\uFEFF/,'').trim();
    return data?JSON.parse(data):null;
  }
  async inspectExecutable(candidate) {
    const brand=brands[candidate.browser];
    invariant(brand && path.win32.isAbsolute(candidate.path),'UNSUPPORTED_RUNTIME','Expected an absolute browser executable path.');
    const target=await fs.realpath(candidate.path);
    invariant((await fs.stat(target)).isFile()&&path.win32.basename(target).toLowerCase()===brand.file,'UNSUPPORTED_RUNTIME','Executable filename does not match the selected browser.');
    const meta=await this.powershell('$f=Get-Item -LiteralPath $v.path; $s=Get-AuthenticodeSignature -LiteralPath $v.path; @{product=$f.VersionInfo.ProductName;version=$f.VersionInfo.ProductVersion;signature=[string]$s.Status;publisher=$s.SignerCertificate.Subject}|ConvertTo-Json -Compress',{path:target});
    invariant(brand.product.test(meta?.product??'')&&meta.signature==='Valid'&&brand.publisher.test(meta.publisher??''),'UNSUPPORTED_RUNTIME','Executable product or publisher signature could not be verified.');
    return {browser:candidate.browser,name:brand.name,engine:candidate.browser==='firefox'?'gecko':'chromium',executablePath:target,version:meta.version??null,available:true,platform:'win32',capabilities:{isolatedProfile:true,normalClose:true,forceClose:true,windowReadiness:false,cdp:candidate.browser!=='firefox'}};
  }
  async processes(runtime,previous,options) {
    // Include remembered PIDs even if their executable becomes unreadable or changes.
    // Filtering at CIM avoids serializing every system process and a second exit query.
    const name=runtime?path.win32.basename(runtime.executablePath):null;
    const pids=[previous,...(previous?.children??[])].filter(p=>Number.isSafeInteger(p?.pid)&&p.pid>0).map(p=>p.pid);
    const filter=name?`Name = '${name.replaceAll("'","''")}'${pids.map(pid=>` OR ProcessId = ${pid}`).join('')}`:null;
    const data=await this.powershell('$rows=if($v.filter){Get-CimInstance Win32_Process -Filter $v.filter}else{Get-CimInstance Win32_Process}; ConvertTo-Json -Compress -InputObject @($rows | Select-Object @{n="name";e={$_.Name}},@{n="pid";e={[int]$_.ProcessId}},@{n="parentPid";e={[int]$_.ParentProcessId}},@{n="startTime";e={$_.CreationDate.ToUniversalTime().ToString("o")}},@{n="executablePath";e={$_.ExecutablePath}},@{n="commandLine";e={$_.CommandLine}})',{filter},options);
    return Array.isArray(data)?data:data?[data]:[];
  }
  async launch(runtime,profilePath,initialUrl,options={}) {
    await this.inspectExecutable({browser:runtime.browser,path:runtime.executablePath});
    const interactive=await this.powershell('[Environment]::UserInteractive|ConvertTo-Json -Compress');
    invariant(interactive,'DESKTOP_SESSION_UNAVAILABLE','No interactive Windows desktop is available.');
    if(runtime.browser==='firefox') await prepareFirefoxProxy(profilePath,options.proxy);
    const child=this.spawnProcess(runtime.executablePath,launchArguments(runtime,profilePath,initialUrl,options),{shell:false,detached:true,stdio:'ignore',windowsHide:false});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
    child.unref();
    for(let attempt=0;attempt<10;attempt++) {
      const all=await this.processes(runtime);
      const root=all.find(p=>p.executablePath&&normalize(p.executablePath)===normalize(runtime.executablePath)&&profileInCommand(p.commandLine,profilePath));
      if(root) return {processIdentity:{...root,profilePath},readiness:'process_started'};
      await pause(250);
    }
    throw new FlockError('OWNERSHIP_UNVERIFIED','A process was started, but its isolated profile ownership was not confirmed.');
  }
  async inspectInstance(instance,runtime,options) {
    let all;
    try { all=await this.processes(runtime,instance.processIdentity,options); } catch { return {status:'unknown',processes:[]}; }
    const previous=instance.processIdentity;
    const remembered=[previous,...(previous?.children??[])].filter(Boolean);
    const browserName=path.win32.basename(runtime.executablePath).toLowerCase();
    // The query also returns remembered PIDs, which Windows reuses after exit/reboot.
    // A different creation time proves the old process ended. Dismiss its replacement
    // only when it is positively a different executable, not an inaccessible browser
    // that could still hold this profile. Missing identity evidence remains unknown.
    all=all.filter(process=>{
      const old=remembered.find(p=>p.pid===process.pid);
      if(!old) return true;
      const oldStart=Date.parse(old.startTime),newStart=Date.parse(process.startTime);
      if(!Number.isFinite(oldStart)||!Number.isFinite(newStart)||oldStart===newStart) return true;
      if(process.executablePath) return normalize(process.executablePath)===normalize(runtime.executablePath);
      return !process.name || process.name.toLowerCase()===browserName;
    });
    // Access-denied rows with this browser name cannot safely be dismissed as exited.
    const matching=all.filter(p=>p.executablePath&&normalize(p.executablePath)===normalize(runtime.executablePath));
    const roots=matching.filter(p=>profileInCommand(p.commandLine,instance.profilePath));
    if(previous) {
      const samePid=all.find(p=>p.pid===previous.pid);
      if(samePid&&samePid.startTime===previous.startTime&&!roots.some(p=>p.pid===samePid.pid)) return {status:'unknown',processes:[]};
    }
    if(!roots.length) {
      // An incomplete snapshot or children from a previously observed tree cannot prove exit.
      if(all.some(p=>!p.executablePath||!p.commandLine||!p.startTime)) return {status:'unknown',processes:[]};
      const remembered=previous?.children??[];
      if(remembered.some(old=>all.some(p=>p.pid===old.pid&&p.startTime===old.startTime))) return {status:'unknown',processes:[]};
      // Exclude children whose ancestry is still provably rooted in another browser instance.
      const otherTrees=matching.filter(p=>p.commandLine&&!p.commandLine.includes('--type=')&&!p.commandLine.includes('-contentproc'));
      for(let changed=true;changed;) {
        changed=false;
        for(const process of matching) if(!otherTrees.some(p=>p.pid===process.pid)&&otherTrees.some(parent=>parent.pid===process.parentPid&&parent.startTime<=process.startTime)) {otherTrees.push(process);changed=true;}
      }
      if(matching.some(p=>!otherTrees.some(other=>other.pid===p.pid))) return {status:'unknown',processes:[]};
      return {status:'stopped',processes:[]};
    }
    const owned=[...roots];
    for(let changed=true;changed;) {
      changed=false;
      for(const process of matching) if(!owned.some(p=>p.pid===process.pid)&&owned.some(parent=>parent.pid===process.parentPid&&parent.startTime<=process.startTime)) { owned.push(process);changed=true; }
    }
    return {status:'running',processes:owned,processIdentity:{...roots[0],profilePath:instance.profilePath,children:owned.filter(p=>p.pid!==roots[0].pid)}};
  }
  async closeInstance(instance,runtime,{force=false,timeoutMs=10000}={}) {
    const deadline=Date.now()+timeoutMs;
    const remaining=()=>Math.max(1,deadline-Date.now());
    let status=await this.inspectInstance(instance,runtime,{timeoutMs:remaining()});
    if(status.status!=='running'||Date.now()>=deadline) return status;
    // Chromium children also repeat --user-data-dir. Normal close addresses only
    // top-level owned processes; force remains explicit and includes owned children.
    const identities=force?[...status.processes].reverse():status.processes.filter(p=>profileInCommand(p.commandLine,instance.profilePath)&&!status.processes.some(parent=>parent.pid===p.parentPid&&parent.startTime<=p.startTime));
    // One shell, but fresh per-PID identity checks immediately before each signal.
    // Exact command line preserves the profile/tree evidence from this snapshot.
    await this.powershell('foreach($target in $v.targets){$c=Get-CimInstance Win32_Process -Filter ("ProcessId = "+[int]$target.pid); if($c -and $c.CreationDate.ToUniversalTime().ToString("o") -eq $target.startTime -and $c.ExecutablePath -eq $target.executablePath -and $c.CommandLine -ceq $target.commandLine){$p=Get-Process -Id ([int]$target.pid) -ErrorAction SilentlyContinue; if($p){try{if($v.force){$p.Kill()}else{[void]$p.CloseMainWindow()}}catch{if(Get-Process -Id ([int]$target.pid) -ErrorAction SilentlyContinue){throw}}}}}; $true|ConvertTo-Json -Compress',{targets:identities,force},{timeoutMs:remaining()});
    let lastIdentity=status.processIdentity??instance.processIdentity;
    while(Date.now()<deadline) {
      status=await this.inspectInstance({...instance,processIdentity:lastIdentity},runtime,{timeoutMs:remaining()});
      lastIdentity=status.processIdentity??lastIdentity;
      // The root may exit before its children. Unknown cannot prove exit, but
      // after a verified close signal it can settle within the same deadline.
      if(status.status==='stopped') return status;
      if(Date.now()<deadline) await pause(Math.min(300,remaining()));
    }
    return status;
  }
  async openExecutableDirectory(runtime) {
    const target=await fs.realpath(runtime.executablePath);
    invariant((await fs.stat(target)).isFile(),'RUNTIME_UNAVAILABLE','Browser executable is missing.');
    const directory=path.dirname(target);
    const child=this.spawnProcess(path.win32.join(this.env.SystemRoot??'C:\\Windows','explorer.exe'),[directory],{shell:false,stdio:'ignore',detached:true});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
    return {directory,requested:true,location:'host'};
  }
}
