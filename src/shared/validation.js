import { isIP } from 'node:net';
import { invariant } from './errors.js';

export function strictObject(value, keys) {
  invariant(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_ARGUMENT', 'Expected an object.');
  for (const key of Object.keys(value)) invariant(keys.includes(key), 'INVALID_ARGUMENT', `Unknown parameter: ${key}`);
  return value;
}
export function text(value, label, max = 80) {
  invariant(typeof value === 'string' && value.trim().length > 0 && value.length <= max, 'INVALID_ARGUMENT', `${label} must contain 1–${max} characters.`);
  return value.trim();
}
export function url(value) {
  if (value === undefined) return undefined;
  text(value, 'url', 8192);
  let parsed;
  try { parsed = new URL(value); } catch { invariant(false, 'INVALID_ARGUMENT', 'Invalid URL.'); }
  invariant(['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password, 'INVALID_ARGUMENT', 'Only HTTP(S) URLs without embedded credentials are allowed.');
  return parsed.href;
}
export function openInput(input) {
  strictObject(input, ['runtime_id', 'instance_id', 'name', 'mode', 'url', 'request_id', 'cdp', 'proxy', 'proxy_preset_id', 'extension_library_ids']);
  const result = { ...input };
  invariant(input.cdp === undefined || typeof input.cdp === 'boolean', 'INVALID_ARGUMENT', 'cdp must be a boolean.');
  invariant((input.runtime_id !== undefined) !== (input.instance_id !== undefined), 'INVALID_ARGUMENT', 'Provide exactly one of runtime_id and instance_id.');
  if (input.instance_id !== undefined) {
    result.instance_id = text(input.instance_id, 'instance_id', 128);
    for (const key of ['name', 'mode', 'request_id', 'proxy', 'proxy_preset_id', 'extension_library_ids']) invariant(input[key] === undefined, 'INVALID_ARGUMENT', `${key} is not allowed when reopening an instance.`);
  } else {
    result.runtime_id = text(input.runtime_id, 'runtime_id', 128);
    result.mode = input.mode ?? 'persistent';
    invariant(['persistent', 'ephemeral'].includes(result.mode), 'INVALID_ARGUMENT', 'Invalid instance mode.');
    if (input.name !== undefined) result.name = text(input.name, 'name');
    if (input.request_id !== undefined) result.request_id = text(input.request_id, 'request_id', 128);
    if (input.extension_library_ids !== undefined) {
      invariant(Array.isArray(input.extension_library_ids) && input.extension_library_ids.length <= 32, 'INVALID_ARGUMENT', 'extension_library_ids must be an array of at most 32 library IDs.');
      result.extension_library_ids = Array.from(input.extension_library_ids, id => {
        invariant(typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id), 'INVALID_ARGUMENT', 'Extension library ID must be a UUID.');
        return id;
      });
      invariant(new Set(result.extension_library_ids).size === result.extension_library_ids.length, 'INVALID_ARGUMENT', 'extension_library_ids must not contain duplicates.');
    }
  }
  invariant(input.proxy===undefined||input.proxy_preset_id===undefined,'INVALID_ARGUMENT','Choose proxy or proxy_preset_id, not both.');
  if(input.proxy!==undefined) result.proxy=proxyConfig(input.proxy);
  if(input.proxy_preset_id!==undefined) result.proxy_preset_id=text(input.proxy_preset_id,'proxy_preset_id',128);
  result.url = url(input.url);
  return result;
}
export function proxyConfig(value={mode:'system'}) {
  strictObject(value,['mode','host','port']);
  invariant(['system','direct','http','socks5'].includes(value.mode),'INVALID_ARGUMENT','Invalid proxy mode.');
  if(['system','direct'].includes(value.mode)) {
    invariant(value.host===undefined&&value.port===undefined,'INVALID_ARGUMENT','System and direct proxies do not accept host or port.');
    return {mode:value.mode};
  }
  invariant(typeof value.host==='string'&&value.host.length>0&&value.host.length<=253&&!/[\s/@?#\\\\]/.test(value.host),'INVALID_ARGUMENT','Proxy host must be a hostname or IP without credentials.');
  const host=value.host.startsWith('[')&&value.host.endsWith(']')?value.host.slice(1,-1):value.host;
  invariant(!value.host.startsWith('[')||isIP(host)===6,'INVALID_ARGUMENT','Brackets require an IPv6 address.');
  invariant(isIP(host)!==0||host.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)),'INVALID_ARGUMENT','Invalid proxy hostname or IP.');
  integer(value.port,1,65535,'proxy port');
  return {mode:value.mode,host:host.toLowerCase(),port:value.port};
}
export function integer(value, min, max, label) {
  invariant(Number.isSafeInteger(value) && value >= min && value <= max, 'INVALID_ARGUMENT', `${label} must be an integer between ${min} and ${max}.`);
  return value;
}
