import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { proxyConfig } from '../shared/validation.js';
import { invariant } from '../shared/errors.js';

export function proxyArguments(value) {
  const proxy=proxyConfig(value);
  if(proxy.mode==='system') return [];
  if(proxy.mode==='direct') return ['--no-proxy-server'];
  const host=proxy.host.includes(':')?`[${proxy.host}]`:proxy.host;
  return [`--proxy-server=${proxy.mode}://${host}:${proxy.port}`];
}
export function firefoxProxyPreferences(value) {
  const p=proxyConfig(value), http=p.mode==='http', socks=p.mode==='socks5';
  return {'network.proxy.type':p.mode==='system'?5:p.mode==='direct'?0:1,
    'network.proxy.http':http?p.host:'','network.proxy.http_port':http?p.port:0,
    'network.proxy.ssl':http?p.host:'','network.proxy.ssl_port':http?p.port:0,
    'network.proxy.socks':socks?p.host:'','network.proxy.socks_port':socks?p.port:0,
    'network.proxy.socks_version':5,'network.proxy.socks_remote_dns':socks,
    'network.proxy.share_proxy_settings':false,
    'network.proxy.no_proxies_on':'localhost, 127.0.0.1, ::1'};
}
const begin='// BEGIN Browser Flock managed proxy';
const end='// END Browser Flock managed proxy';
export async function prepareFirefoxProxy(profilePath,value) {
  const stat=await fs.lstat(profilePath);
  invariant(stat.isDirectory()&&!stat.isSymbolicLink()&&path.resolve(await fs.realpath(profilePath)).toLowerCase()===path.resolve(profilePath).toLowerCase(),'OWNERSHIP_UNVERIFIED','Unsafe Firefox profile directory.');
  const target=path.join(profilePath,'user.js');let source='';let previous;
  try {
    previous=await fs.lstat(target);
    invariant(previous.isFile()&&!previous.isSymbolicLink()&&previous.nlink===1,'OWNERSHIP_UNVERIFIED','Unsafe Firefox preferences file.');
    source=await fs.readFile(target,'utf8');
  } catch(error) { if(error.code!=='ENOENT') throw error; }
  const start=source.indexOf(begin), finish=source.indexOf(end);
  invariant((start<0&&finish<0)||(start>=0&&finish>start&&source.indexOf(begin,start+begin.length)<0&&source.indexOf(end,finish+end.length)<0),'INVALID_STATE','Malformed managed Firefox proxy preferences.');
  if(start>=0) source=source.slice(0,start)+source.slice(finish+end.length);
  const block=Object.entries(firefoxProxyPreferences(value)).map(([key,val])=>`user_pref(${JSON.stringify(key)}, ${JSON.stringify(val)});`).join('\n');
  const temporary=path.join(profilePath,`.browser-flock-proxy-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary,`${source}\n${begin}\n${block}\n${end}\n`,{flag:'wx',mode:0o600});
    let current;try {current=await fs.lstat(target);}catch(error){if(error.code!=='ENOENT')throw error;}
    invariant(previous?current&&current.isFile()&&!current.isSymbolicLink()&&current.ino===previous.ino&&current.dev===previous.dev&&current.mtimeMs===previous.mtimeMs&&! (current.nlink>1):!current,'OWNERSHIP_UNVERIFIED','Firefox preferences changed during preparation.');
    await fs.rename(temporary,target);
  } finally {await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
