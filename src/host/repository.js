import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MARKER = '.browser-flock-owner.json';
const initialState = () => ({ schemaVersion: 1, extensionLibrary: [], proxyPresets: [], runtimes: [], instances: [], defaultRuntimeId: null, requests: {}, tombstones: [] });
const fail = (message, code = 'OWNERSHIP_UNVERIFIED') => Object.assign(new Error(message), { code });
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const normalized = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function validateState(state) {
  if (!plain(state) || state.schemaVersion !== 1 || !Array.isArray(state.runtimes) || !Array.isArray(state.instances)
      || (state.proxyPresets!==undefined&&!Array.isArray(state.proxyPresets))
      || (state.extensionLibrary!==undefined&&!Array.isArray(state.extensionLibrary))
      || !Array.isArray(state.tombstones) || !plain(state.requests)
      || !(state.defaultRuntimeId === null || typeof state.defaultRuntimeId === 'string')) {
    throw fail('Invalid repository state or unsupported schema version', 'INVALID_STATE');
  }
}

/**
 * Standalone, single-writer repository. Only confirmed dead owners are reclaimed.
 * State and ownership ledgers use separate atomic snapshots; filesystem operations
 * are not transactions with state. Persist lifecycle intent before creating/deleting.
 * removeProfile cannot establish process liveness: callers MUST first establish that
 * all associated browser processes exited and prevent further profile writers.
 * Checks fail closed on links and changed identities. Node's portable path APIs do
 * not provide race-free unlinkat: this is not a sandbox against a hostile OS user.
 * Do not call queued repository methods from inside a transaction mutator.
 */
export class Repository {
  #root; #rootStat; #profilesStat; #lock; #lockStat; #lockToken;
  #state; #ownership; #tail = Promise.resolve(); #opened = false;

  constructor(root) {
    if (typeof root !== 'string' || !root.trim()) throw new TypeError('root must be a nonempty path');
    this.#root = path.resolve(root);
  }

  #enqueue(operation) {
    const result = this.#tail.then(operation);
    this.#tail = result.catch(() => {});
    return result;
  }

  profilePath(id) {
    if (typeof id !== 'string' || !UUID.test(id)) throw fail('Profile id must be a UUID', 'INVALID_ARGUMENT');
    return path.join(this.#root, 'profiles', id.toLowerCase());
  }

  async #directory(target, expected) {
    const stat = await fs.lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (expected && !sameFile(stat, expected))
        || normalized(await fs.realpath(target)) !== normalized(target)) {
      throw fail(`Unsafe or replaced directory: ${target}`);
    }
    return stat;
  }

  async #readJSON(target) {
    const before = await fs.lstat(target);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw fail(`Unsafe file: ${target}`);
    const handle = await fs.open(target, 'r');
    try {
      if (!sameFile(before, await handle.stat())) throw fail(`Replaced file: ${target}`);
      return JSON.parse(await handle.readFile('utf8'));
    } finally { await handle.close(); }
  }

  async #assertOwned() {
    if (!this.#opened) throw fail('Repository is not open', 'REPOSITORY_CLOSED');
    await this.#directory(this.#root, this.#rootStat);
    await this.#directory(path.join(this.#root, 'profiles'), this.#profilesStat);
    const lockPath = path.join(this.#root, 'repository.lock');
    if (!sameFile(await fs.lstat(lockPath), this.#lockStat)
        || (await this.#readJSON(lockPath)).token !== this.#lockToken) throw fail('Repository lock ownership lost', 'LOCK_LOST');
  }

  async #atomicJSON(name, value) {
    const target = path.join(this.#root, name);
    const temporary = path.join(this.#root, `.${name}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close(); handle = undefined;
      await this.#assertOwned();
      await fs.rename(temporary, target);
    } finally {
      if (handle) await handle.close();
      // Only this operation's exclusive temporary file is eligible for cleanup.
      await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  async #acquireLock(lockPath) {
    // All acquisitions share the recovery gate: no new owner can appear between
    // a reclaimer's final identity check and unlink. An abandoned gate fails closed;
    // never steal a gate based on age (nor recursively race to recover the gate).
    const gatePath = path.join(this.#root, 'repository.recovery.lock');
    let gate, gateStat;
    for (let attempt = 0; !gate; attempt++) {
      try { gate = await fs.open(gatePath, 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (attempt >= 20) throw fail('Repository acquisition/recovery is already in progress; inspect an abandoned recovery gate manually', 'REPOSITORY_LOCKED');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    try {
      gateStat = await gate.stat();
      await gate.writeFile(JSON.stringify({ token: randomUUID(), pid: process.pid }));
      let existing;
      try { existing = await fs.lstat(lockPath); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (existing) {
        const locked = () => fail('Repository owner is live or cannot be safely verified', 'REPOSITORY_LOCKED');
        let owner;
        try { owner = await this.#readJSON(lockPath); } catch { throw locked(); }
        if (!plain(owner) || !UUID.test(owner.token) || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || owner.pid > 2147483647) throw locked();
        let dead = false;
        try { process.kill(owner.pid, 0); }
        catch (error) { if (error.code === 'ESRCH') dead = true; }
        // EPERM, PID reuse, and every unknown result fail closed.
        if (!dead) throw locked();
        await this.#directory(this.#root, this.#rootStat);
        const current = await fs.lstat(lockPath);
        let reread;
        try { reread = await this.#readJSON(lockPath); } catch { throw locked(); }
        if (!sameFile(existing, current) || reread.token !== owner.token || reread.pid !== owner.pid) throw locked();
        await fs.unlink(lockPath);
      }
      this.#lock = await fs.open(lockPath, 'wx', 0o600);
      this.#lockToken = randomUUID();
      this.#lockStat = await this.#lock.stat();
      await this.#lock.writeFile(JSON.stringify({ token: this.#lockToken, pid: process.pid }));
      await this.#lock.sync();
    } catch (error) {
      if (this.#lock) await this.#releaseLock();
      if (error.code === 'EEXIST') throw fail('Repository lock already exists', 'REPOSITORY_LOCKED');
      throw error;
    } finally {
      try {
        await this.#directory(this.#root, this.#rootStat);
        const current = await fs.lstat(gatePath);
        if (gateStat && sameFile(current, gateStat) && !current.isSymbolicLink()) await fs.unlink(gatePath);
      } finally { await gate.close(); }
    }
  }

  open() {
    return this.#enqueue(async () => {
      if (this.#opened) return this;
      // Validate the nearest existing ancestor before creating a missing root.
      let ancestor = this.#root;
      for (;;) {
        try { await this.#directory(ancestor); break; }
        catch (error) {
          if (error.code !== 'ENOENT' || path.dirname(ancestor) === ancestor) throw error;
          ancestor = path.dirname(ancestor);
        }
      }
      await fs.mkdir(this.#root, { recursive: true, mode: 0o700 });
      this.#rootStat = await this.#directory(this.#root);
      const lockPath = path.join(this.#root, 'repository.lock');
      await this.#acquireLock(lockPath);
      try {
        await fs.mkdir(path.join(this.#root, 'profiles'), { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
        this.#profilesStat = await this.#directory(path.join(this.#root, 'profiles'));
        this.#opened = true;
        try { this.#ownership = await this.#readJSON(path.join(this.#root, 'ownership.json')); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          this.#ownership = { schemaVersion: 1, repositoryId: randomUUID(), profiles: {} };
          await this.#atomicJSON('ownership.json', this.#ownership);
        }
        if (this.#ownership.schemaVersion !== 1 || !UUID.test(this.#ownership.repositoryId) || !plain(this.#ownership.profiles)) throw fail('Invalid ownership ledger');
        try { this.#state = await this.#readJSON(path.join(this.#root, 'state.json')); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          this.#state = initialState();
          await this.#atomicJSON('state.json', this.#state);
        }
        validateState(this.#state);
        return this;
      } catch (error) {
        await this.#releaseLock();
        throw error;
      }
    });
  }

  async #releaseLock() {
    const handle = this.#lock;
    if (!handle) return;
    try {
      await this.#directory(this.#root, this.#rootStat);
      const target = path.join(this.#root, 'repository.lock');
      const stat = await fs.lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (stat && sameFile(stat, this.#lockStat) && !stat.isSymbolicLink()) {
        // An incomplete initial lock is also ours by its still-open file identity.
        const text = await fs.readFile(target, 'utf8');
        if (!text || JSON.parse(text).token === this.#lockToken) await fs.unlink(target);
      }
    } finally {
      await handle.close(); this.#lock = undefined; this.#opened = false; this.#state = undefined;
    }
  }

  close() { return this.#enqueue(() => this.#releaseLock()); }

  snapshot() {
    if (!this.#opened || !this.#state) throw fail('Repository is not open', 'REPOSITORY_CLOSED');
    return structuredClone(this.#state);
  }

  transaction(mutator) {
    return this.#enqueue(async () => {
      await this.#assertOwned();
      if (typeof mutator !== 'function') throw new TypeError('mutator must be a function');
      const draft = structuredClone(this.#state);
      const result = await mutator(draft);
      validateState(draft);
      // Canonical JSON cloning rejects cycles/BigInt before writing and detaches all
      // references retained by the mutator. Memory exactly matches persisted JSON.
      const committed = JSON.parse(JSON.stringify(draft));
      validateState(committed);
      await this.#atomicJSON('state.json', committed);
      this.#state = committed;
      return result;
    });
  }

  createProfile(id) {
    return this.#enqueue(async () => {
      const target = this.profilePath(id); id = id.toLowerCase();
      await this.#assertOwned();
      if (Object.hasOwn(this.#ownership.profiles, id)) throw fail('Profile ownership already exists', 'PROFILE_EXISTS');
      await fs.mkdir(target, { mode: 0o700 }); // Never adopt an existing directory.
      await this.#directory(target);
      const token = randomUUID();
      const marker = { schemaVersion: 1, repositoryId: this.#ownership.repositoryId, profileId: id, token };
      const handle = await fs.open(path.join(target, MARKER), 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(marker)); await handle.sync(); } finally { await handle.close(); }
      const ownership = structuredClone(this.#ownership);
      ownership.profiles[id] = token;
      await this.#atomicJSON('ownership.json', ownership);
      this.#ownership = ownership;
      return target;
    });
  }

  /** Only library code may create children; revalidates repository ownership on every access. */
  extensionLibraryRoot() {
    return this.#enqueue(async () => {
      await this.#assertOwned();
      const target = path.join(this.#root, 'extension-library');
      try { await fs.mkdir(target, {mode:0o700}); } catch(error) { if(error.code!=='EEXIST') throw error; }
      await this.#directory(target);
      return target;
    });
  }

  /** Persistent recording storage independent of browser profile lifetimes. */
  recordingsRoot() {
    return this.#enqueue(async () => {
      await this.#assertOwned();
      const target = path.join(this.#root, 'recordings');
      try { await fs.mkdir(target, {mode:0o700}); } catch(error) { if(error.code!=='EEXIST') throw error; }
      await this.#directory(target);
      return target;
    });
  }

  /** Verify the owned profile before allowing a browser to use it. */
  assertProfile(id) {
    return this.#enqueue(async () => {
      const target = this.profilePath(id);
      await this.#assertOwned();
      await this.#assertProfileOwned(id.toLowerCase(), target);
      return target;
    });
  }

  async #assertProfileOwned(id, target) {
    const token = this.#ownership.profiles[id];
    if (typeof token !== 'string' || !UUID.test(token)) throw fail('Profile is not owned by this repository');
    const profileStat = await this.#directory(target);
    const marker = await this.#readJSON(path.join(target, MARKER));
    if (!plain(marker) || marker.schemaVersion !== 1 || marker.repositoryId !== this.#ownership.repositoryId || marker.profileId !== id || marker.token !== token) throw fail('Profile ownership marker does not match');
    return profileStat;
  }

  /** Caller must confirm all browser processes exited before invoking this. */
  removeProfile(id) {
    return this.#enqueue(async () => {
      const target = this.profilePath(id); id = id.toLowerCase();
      await this.#assertOwned();
      const profileStat = await this.#assertProfileOwned(id, target);
      const entries = [];
      const walk = async directory => {
        for (const name of await fs.readdir(directory)) {
          const entry = path.join(directory, name);
          const stat = await fs.lstat(entry);
          if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw fail(`Unsafe profile entry: ${entry}`);
          if (stat.isDirectory()) { await this.#directory(entry); await walk(entry); }
          entries.push({ entry, stat });
        }
      };
      await walk(target); // Preflight the entire tree before deleting anything.
      // Keep the ownership marker until last so interrupted cleanup can be retried.
      entries.sort((a, b) => Number(a.entry === path.join(target, MARKER)) - Number(b.entry === path.join(target, MARKER)));
      for (const { entry, stat } of entries) {
        await this.#assertOwned();
        await this.#directory(target, profileStat);
        let parent = path.dirname(entry);
        while (parent !== target) { await this.#directory(parent); parent = path.dirname(parent); }
        const current = await fs.lstat(entry);
        if (current.isSymbolicLink() || !sameFile(current, stat)) throw fail(`Profile entry changed during cleanup: ${entry}`);
        if (stat.isDirectory()) await fs.rmdir(entry); else await fs.unlink(entry);
      }
      await this.#assertOwned();
      await this.#directory(target, profileStat);
      await fs.rmdir(target);
      const ownership = structuredClone(this.#ownership);
      delete ownership.profiles[id];
      await this.#atomicJSON('ownership.json', ownership);
      this.#ownership = ownership;
    });
  }
}
