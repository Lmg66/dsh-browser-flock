import { createHash } from 'node:crypto';
import { defaultCandidates, brands } from './browser-adapters.js';
import { invariant } from '../shared/errors.js';
import { text } from '../shared/validation.js';

/** OS adapter validates identity before probing/launching any candidate. */
export class RuntimeRegistry {
  constructor(repository, platform, { cacheTtlMs = 60000 } = {}) {
    this.repository = repository;
    this.platform = platform;
    this.cacheTtlMs = cacheTtlMs;
    this.lastScan = 0;
    this.scanning = null;
    this.scanFailed = false;
  }
  freshness() {
    const checks=this.list().map(r=>r.lastCheckedAt).filter(Boolean).sort();
    return {state:this.scanning?'updating':this.scanFailed?'error':!this.lastScan?'pending':Date.now()-this.lastScan>=this.cacheTtlMs?'stale':'current',last_checked_at:this.lastScan?new Date(this.lastScan).toISOString():checks[0]??null};
  }
  list() { return this.repository.snapshot().runtimes; }
  get(id) {
    const runtime = this.list().find(r => r.id === id);
    invariant(runtime, 'RUNTIME_NOT_FOUND', 'Browser registration does not exist.');
    return runtime;
  }
  async inspect(candidate) {
    const result = await this.platform.inspectExecutable(candidate);
    invariant(result && typeof result.executablePath === 'string', 'UNSUPPORTED_RUNTIME', 'Cannot identify this browser installation.');
    const identity = this.platform.platform === 'win32' ? result.executablePath.toLowerCase() : result.executablePath;
    return { ...result, id: `rt_${createHash('sha256').update(identity).digest('hex').slice(0,24)}`,
      sources: [candidate.source], lastCheckedAt: new Date().toISOString() };
  }
  async scan({ refresh = false } = {}) {
    if (!refresh && this.lastScan && Date.now() - this.lastScan < this.cacheTtlMs) return this.list();
    if (this.scanning) return this.scanning;
    this.scanFailed = false;
    this.scanning = this.scanNow().catch(error => { this.scanFailed=true; throw error; }).finally(() => { this.scanning = null; });
    return this.scanning;
  }
  async scanNow() {
    const known = this.list();
    const candidates = [...defaultCandidates(this.platform.platform, this.platform.env), ...known.map(r => ({browser:r.browser,path:r.executablePath,source:r.sources.includes('manual')?'manual':'registered'}))];
    if (this.platform.additionalCandidates) candidates.push(...await this.platform.additionalCandidates());
    const unique = new Map();
    for(const candidate of candidates) {
      const key=`${candidate.browser}:${this.platform.platform==='win32'?candidate.path.toLowerCase():candidate.path}`;
      const previous=unique.get(key);
      if(previous) previous.sources.add(candidate.source);
      else unique.set(key,{candidate,sources:new Set([candidate.source])});
    }
    const found = new Map();
    for (const {candidate,sources} of unique.values()) {
      try {
        const runtime = await this.inspect(candidate);
        runtime.sources=[...sources];
        const previous = found.get(runtime.id);
        found.set(runtime.id, { ...runtime, sources: [...new Set([...(previous?.sources ?? []), ...runtime.sources])] });
      } catch { /* Missing or rejected candidates are not executable registrations. */ }
    }
    await this.repository.transaction(state => {
      state.runtimes = state.runtimes.map(old => {
        const current = found.get(old.id);
        found.delete(old.id);
        return current ? { ...old, ...current, name:old.name ?? current.name, sources:[...new Set([...old.sources,...current.sources])] }
          : { ...old, available:false, unavailableReason:'Installation could not be verified during the latest scan.', lastCheckedAt:new Date().toISOString() };
      });
      state.runtimes.push(...found.values());
    });
    this.lastScan = Date.now();
    return this.list();
  }
  async register({ browser, path, name }) {
    invariant(brands.includes(browser), 'INVALID_ARGUMENT', 'Unsupported browser brand.');
    text(path,'path',32768);
    if (name !== undefined) name = text(name,'name');
    const runtime = await this.inspect({ browser, path, source:'manual' });
    invariant(runtime.browser === browser, 'UNSUPPORTED_RUNTIME', 'Executable identity differs from the selected browser.');
    await this.repository.transaction(state => {
      const old = state.runtimes.find(r => r.id === runtime.id);
      if (old) Object.assign(old, runtime, {name:name ?? old.name ?? runtime.name,sources:[...new Set([...old.sources,'manual'])]});
      else state.runtimes.push({...runtime,...(name ? {name} : {})});
    });
    return this.get(runtime.id);
  }
  async setDefault(id) {
    await this.repository.transaction(state => {
      invariant(state.runtimes.some(r=>r.id===id && r.available), 'RUNTIME_UNAVAILABLE', 'Only verified available browsers can be selected.');
      state.defaultRuntimeId = id;
    });
    return { runtime_id:id };
  }
  async remove(id) {
    await this.repository.transaction(state => {
      const runtime=state.runtimes.find(r=>r.id===id);
      invariant(runtime,'RUNTIME_NOT_FOUND','Browser registration does not exist.');
      invariant(runtime.sources.includes('manual'),'INVALID_ARGUMENT','Only manual registrations can be removed.');
      invariant(state.defaultRuntimeId!==id && !state.instances.some(i=>i.runtimeId===id),'RUNTIME_IN_USE','Default or referenced browsers cannot be removed.');
      if (runtime.sources.some(s=>!['manual','registered'].includes(s))) runtime.sources=runtime.sources.filter(s=>s!=='manual');
      else state.runtimes=state.runtimes.filter(r=>r.id!==id);
    });
    return { runtime_id:id, registration_removed:true, browser_uninstalled:false };
  }
  async openDirectory(id) {
    const runtime=this.get(id);
    return this.platform.openExecutableDirectory(runtime);
  }
}
