import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { generate, parse, edit, payload, hash, NativeError } from './generator.mjs';
const error = code => { throw new NativeError(code); };
const CONFIGS = ['oh-my-opencode-slim.json', 'oh-my-opencode-slim.jsonc'];
const STATE = '.omo-coworkers';
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
const bounded = text => { if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) error('BLOCKED'); return text; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const read = file => fs.readFileSync(file, 'utf8');
const valueAt = (object, keys) => keys.reduce((v, k) => v?.[k], object);
const keysExactly = (object, keys) => object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).every(k => keys.includes(k));
const inverseEntries = entries => entries.map(e => ({ ...e, before: e.after, after: e.before, beforeExists: e.afterExists, afterExists: e.beforeExists }));
const recordFor = (id, configPath, entries, version, payloadHash, operation, phase = 'prepared') => ({ format: 1, id, configPath, entries, version, payloadHash, phase, operation });
export class NativeStore {
  constructor(root, { inject = () => {}, now = () => Date.now() } = {}) {
    this.root = path.resolve(root); this.inject = inject; this.now = now; this.previews = new Map();
    this.data = payload();
    this.promptPaths = this.data.prompts.map(p => p.path);
    this.leafPaths = this.data.leaves.map(l => l.path);
    this.allowed = new Set([...CONFIGS, ...this.promptPaths]);
  }
  safe(relative, { missing = true, directory = false } = {}) {
    const target = relative ? path.join(this.root, relative) : this.root;
    if (relative && (path.isAbsolute(relative) || relative.split('/').some(p => p === '..' || p === '.'))) error('UNSAFE_PATH');
    const parts = target.split(path.sep).filter(Boolean);
    let current = path.parse(target).root;
    let privateAncestor = false;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      let stat;
      try { stat = fs.lstatSync(current); } catch (e) {
        if (e.code === 'ENOENT' && missing) return null;
        throw e;
      }
      const insideRoot = current === this.root || current.startsWith(this.root + path.sep);
      if (stat.isSymbolicLink() || ((stat.mode & 0o022) && (insideRoot || !privateAncestor)) || (stat.uid !== process.getuid() && stat.uid !== 0)) error('UNSAFE_PATH');
      // A private owned ancestor prevents other UIDs reaching otherwise writable
      // intermediate ancestors. The candidate root and every descendant stay strict.
      if (stat.isDirectory() && stat.uid === process.getuid() && !(stat.mode & 0o077)) privateAncestor = true;
      const last = i === parts.length - 1;
      if (!last || directory) { if (!stat.isDirectory()) error('UNSAFE_PATH'); }
      else if (!stat.isFile() || stat.nlink !== 1) error('UNSAFE_PATH');
    }
    return fs.lstatSync(target);
  }
  snapshot(relative) {
    const stat = this.safe(relative);
    if (!stat) return null;
    if (stat.size > MAX_FILE_BYTES) error('BLOCKED');
    const text = read(path.join(this.root, relative));
    const after = this.safe(relative, { missing: false });
    if (stat.ino !== after.ino || stat.dev !== after.dev || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) error('DRIFT');
    return { hash: hash(text), dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o777, size: stat.size, mtimeMs: stat.mtimeMs };
  }
  statePath(name) { return `${STATE}/${name}`; }
  load(name) {
    const relative = this.statePath(name);
    const stat = this.safe(relative);
    if (!stat) return null;
    if (stat.size > MAX_FILE_BYTES) error('RECOVERY_REQUIRED');
    const expected = this.snapshot(relative);
    const text = read(path.join(this.root, relative));
    if (hash(text) !== expected.hash || !same(expected, this.snapshot(relative))) error('DRIFT');
    return parse(text);
  }
  checkRecord(record) {
    if (!keysExactly(record, ['format', 'id', 'configPath', 'entries', 'version', 'payloadHash', 'phase', 'operation']) ||
      record.format !== 1 || !/^[a-f0-9]{32}$/.test(record.id) || !CONFIGS.includes(record.configPath) ||
      typeof record.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(record.version) || !/^[a-f0-9]{64}$/.test(record.payloadHash) ||
      !['prepared', 'committed'].includes(record.phase) || !['apply', 'rollback'].includes(record.operation) || !Array.isArray(record.entries) || record.entries.length > 20) error('RECOVERY_REQUIRED');
    const seen = new Set();
    for (const entry of record.entries) {
      if (!keysExactly(entry, ['path', 'kind', 'leafPath', 'before', 'after', 'beforeExists', 'afterExists']) ||
        !this.allowed.has(entry.path) || !['leaf', 'prompt'].includes(entry.kind) ||
        typeof entry.beforeExists !== 'boolean' || typeof entry.afterExists !== 'boolean' ||
        (entry.beforeExists && typeof entry.before !== 'string') || (entry.afterExists && typeof entry.after !== 'string') ||
        (!entry.beforeExists && entry.before !== null) || (!entry.afterExists && entry.after !== null)) error('RECOVERY_REQUIRED');
      if (Buffer.byteLength(entry.before ?? '', 'utf8') > MAX_FILE_BYTES || Buffer.byteLength(entry.after ?? '', 'utf8') > MAX_FILE_BYTES) error('RECOVERY_REQUIRED');
      if (entry.kind === 'leaf') {
        if (entry.path !== record.configPath || !this.leafPaths.some(p => same(p, entry.leafPath))) error('RECOVERY_REQUIRED');
      } else if (!this.promptPaths.includes(entry.path) || entry.leafPath !== null) error('RECOVERY_REQUIRED');
      const id = entry.path + ':' + JSON.stringify(entry.leafPath);
      if (seen.has(id)) error('RECOVERY_REQUIRED'); seen.add(id);
    }
    return record;
  }
  inspect() {
    this.safe('', { missing: false, directory: true });
    const found = CONFIGS.filter(p => this.safe(p));
    if (found.length > 1) error('SHADOWED');
    const configPath = found[0] ?? CONFIGS[1];
    const config = found.length ? read(path.join(this.root, configPath)) : '{}\n';
    const object = parse(config);
    const prompts = {}, snapshots = {};
    for (const p of [...CONFIGS, ...this.promptPaths, this.statePath('overrides.jsonc'), this.statePath('state.json'), this.statePath('journal.json')]) {
      snapshots[p] = this.snapshot(p);
      if (this.promptPaths.includes(p) && snapshots[p]) prompts[p] = read(path.join(this.root, p));
    }
    const preset = object.preset;
    if (typeof preset === 'string') for (const p of this.promptPaths) {
      if (!/^[a-zA-Z0-9_-]+$/.test(preset)) error('SHADOWED');
      const alt = `oh-my-opencode-slim/${preset}/${path.basename(p)}`;
      if (this.safe(alt)) error('SHADOWED');
      const opposite = alt.includes('_append.md') ? alt.replace('_append.md', '.md') : alt.replace('.md', '_append.md');
      if (this.safe(opposite)) error('SHADOWED');
    }
    // Block opposite full/append prompt variants that would alter native composition.
    for (const p of this.promptPaths) {
      const alt = p.includes('_append.md') ? p.replace('_append.md', '.md') : p.replace('.md', '_append.md');
      if (!this.promptPaths.includes(alt) && this.safe(alt)) error('SHADOWED');
    }
    const rootStat = this.safe('', { missing: false, directory: true });
    const overrides = snapshots[this.statePath('overrides.jsonc')] ? read(path.join(this.root, this.statePath('overrides.jsonc'))) : '{}';
    const state = this.load('state.json');
    if (state) this.checkRecord(state);
    const journal = this.load('journal.json');
    if (journal) { this.checkRecord(journal); error('RECOVERY_REQUIRED'); }
    if (snapshots[configPath]?.hash !== (found.length ? hash(config) : undefined)) error('DRIFT');
    for (const [p, text] of Object.entries(prompts)) if (hash(text) !== snapshots[p].hash) error('DRIFT');
    if (this.deadLock()) error('RECOVERY_REQUIRED');
    for (const [p, snapshot] of Object.entries(snapshots)) if (!same(snapshot, this.snapshot(p))) error('DRIFT');
    if (snapshots[this.statePath('overrides.jsonc')] && hash(overrides) !== snapshots[this.statePath('overrides.jsonc')].hash) error('DRIFT');
    return { configPath, config, prompts, snapshots, overrides, state, root: { dev: rootStat.dev, ino: rootStat.ino, mode: rootStat.mode } };
  }
  baseline(state) {
    if (!state || state.operation === 'rollback') return null;
    return Object.fromEntries(state.entries.filter(e => e.afterExists).map(e => [e.kind === 'leaf' ? e.leafPath.join('.') : e.path, e.after]));
  }
  preview(kind = 'apply') {
    const input = this.inspect();
    let entries, changes;
    if (kind === 'apply') {
      const generated = generate({ config: input.config, prompts: input.prompts, overrides: input.overrides, baseline: this.baseline(input.state) });
      entries = generated.changes.map(c => ({
        path: c.kind === 'leaf' ? input.configPath : c.path, kind: c.kind, leafPath: c.leafPath ?? null,
        before: c.before ?? null, after: c.after, beforeExists: c.before !== undefined, afterExists: true,
      }));
      for (const [key, after] of Object.entries(generated.managed)) {
        const leafPath = this.leafPaths.find(p => p.join('.') === key);
        const relative = leafPath ? input.configPath : key;
        if (entries.some(e => e.path === relative && same(e.leafPath, leafPath ?? null))) continue;
        entries.push({ path: relative, kind: leafPath ? 'leaf' : 'prompt', leafPath: leafPath ?? null, before: after, after, beforeExists: true, afterExists: true });
      }
      changes = generated.changes.map(({ before, after, leafPath, ...safe }) => safe);
    } else {
      if (!input.state || input.state.operation === 'rollback') error('BLOCKED');
      this.checkCurrent(input.state.entries, 'after');
      entries = inverseEntries(input.state.entries);
      changes = entries.map(e => ({ path: e.kind === 'leaf' ? e.leafPath.join('.') : e.path, kind: e.kind, action: !e.afterExists ? 'delete' : 'update', beforeHash: e.beforeExists ? hash(e.before) : null, afterHash: e.afterExists ? hash(e.after) : null }));
    }
    const id = crypto.randomBytes(16).toString('hex');
    for (const [key, value] of this.previews) if (value.expires <= this.now()) this.previews.delete(key);
    if (this.previews.size >= 16) this.previews.delete(this.previews.keys().next().value);
    const preview = { id, kind, expires: this.now() + 300000, input, entries, payloadHash: this.data.hash };
    this.previews.set(id, preview);
    return { ok: true, previewId: id, kind, expiresAt: new Date(preview.expires).toISOString(), changes, warnings: ['User attestations are not observed process evidence.', 'Hash-only diffs; existing personal text is not exposed.', 'Project configuration and environment shadowing require host-environment attestation.', 'Cross-file writes are not atomic; pause work.'], runtimeVerified: false };
  }
  checkCurrent(entries, side) {
    const configs = new Map();
    for (const e of entries) {
      let current;
      if (e.kind === 'leaf') {
        if (!configs.has(e.path)) configs.set(e.path, this.safe(e.path) ? parse(read(path.join(this.root, e.path))) : {});
        current = valueAt(configs.get(e.path), e.leafPath);
      } else current = this.safe(e.path) ? read(path.join(this.root, e.path)) : undefined;
      if (!same(current, e[side + 'Exists'] ? e[side] : undefined)) error('DRIFT');
    }
  }
  ensureDir(relative) {
    const segments = relative.split('/');
    let accumulated = '';
    for (const segment of segments) {
      accumulated = accumulated ? accumulated + '/' + segment : segment;
      if (!this.safe(accumulated, { directory: true })) {
        fs.mkdirSync(path.join(this.root, accumulated), { mode: 0o700 });
        this.safe(accumulated, { missing: false, directory: true });
      }
    }
  }
  syncDir(relative) {
    const fd = fs.openSync(path.join(this.root, relative || '.'), fs.constants.O_RDONLY);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  atomic(relative, text, mode = 0o600, expected = this.snapshot(relative)) {
    bounded(text);
    const parent = path.dirname(relative);
    if (parent !== '.') this.ensureDir(parent);
    this.safe(relative);
    if (!same(expected, this.snapshot(relative))) error('DRIFT');
    const parentBefore = this.safe(parent === '.' ? '' : parent, { missing: false, directory: true });
    const temporary = `${relative}.omo-${crypto.randomBytes(12).toString('hex')}`;
    let fd;
    try {
      fd = fs.openSync(path.join(this.root, temporary), fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, mode);
      this.inject('write', relative);
      fs.writeFileSync(fd, text); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      this.inject('rename', relative);
      this.safe(relative); this.safe(parent === '.' ? '' : parent, { missing: false, directory: true });
      const parentAfter = this.safe(parent === '.' ? '' : parent, { missing: false, directory: true });
      if (!same(expected, this.snapshot(relative)) || parentBefore.ino !== parentAfter.ino || parentBefore.dev !== parentAfter.dev) error('DRIFT');
      fs.renameSync(path.join(this.root, temporary), path.join(this.root, relative));
      this.inject('after-rename', relative);
      this.syncDir(parent);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(path.join(this.root, temporary)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
  remove(relative, expected = this.snapshot(relative)) {
    if (!same(expected, this.snapshot(relative))) error('DRIFT');
    if (!this.safe(relative)) return;
    fs.unlinkSync(path.join(this.root, relative)); this.syncDir(path.dirname(relative));
  }
  deadLock() {
    if (!this.safe(this.statePath('lock'))) return false;
    try {
      const owner = this.load('lock');
      if (!keysExactly(owner, ['pid']) || !Number.isSafeInteger(owner.pid) || owner.pid < 1) return false;
      process.kill(owner.pid, 0);
    } catch (e) { return e.code === 'ESRCH'; }
    return false;
  }
  withLock(fn, recoverDeadLock = false) {
    this.safe('', { missing: false, directory: true }); this.ensureDir(STATE);
    const lock = this.statePath('lock');
    this.safe(lock);
    if (recoverDeadLock && this.safe(lock)) {
      const snapshot = this.snapshot(lock);
      let owner;
      try { owner = parse(read(path.join(this.root, lock))); } catch { error('LOCKED'); }
      if (!keysExactly(owner, ['pid']) || !Number.isSafeInteger(owner.pid) || owner.pid < 1) error('LOCKED');
      try { process.kill(owner.pid, 0); error('LOCKED'); }
      catch (e) { if (e.code !== 'ESRCH') throw e; }
      if (!same(snapshot, this.snapshot(lock))) error('LOCKED');
      this.remove(lock, snapshot);
    }
    let fd;
    try { fd = fs.openSync(path.join(this.root, lock), fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600); }
    catch (e) { if (e.code === 'EEXIST') error('LOCKED'); throw e; }
    const stat = fs.fstatSync(fd);
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); fs.fsyncSync(fd);
      return fn();
    } finally {
      fs.closeSync(fd);
      const current = this.safe(lock);
      if (current?.ino === stat.ino && current?.dev === stat.dev) this.remove(lock);
    }
  }
  prepareEntries(entries, side) {
    const groups = new Map();
    for (const e of entries) {
      if (!groups.has(e.path)) groups.set(e.path, []);
      groups.get(e.path).push(e);
    }
    const writes = [];
    for (const [relative, group] of groups) {
      const expected = this.snapshot(relative);
      const mode = this.safe(relative)?.mode & 0o777 || 0o600;
      const source = expected ? read(path.join(this.root, relative)) : undefined;
      if ((source === undefined ? null : hash(source)) !== (expected?.hash ?? null) || !same(expected, this.snapshot(relative))) error('DRIFT');
      const sourceSide = side === 'after' ? 'before' : 'after';
      for (const e of group) {
        const current = e.kind === 'leaf' ? valueAt(parse(source ?? '{}'), e.leafPath) : source;
        if (!same(current, e[sourceSide + 'Exists'] ? e[sourceSide] : undefined)) error('DRIFT');
      }
      if (group[0].kind === 'leaf') {
        let text = source ?? '{}\n';
        const before = text;
        for (const e of group) text = edit(text, e.leafPath, e[side + 'Exists'] ? e[side] : undefined);
        bounded(text);
        writes.push({ relative, text, mode, expected, changed: text !== before });
      } else {
        const e = group[0];
        const text = e[side + 'Exists'] ? bounded(e[side]) : undefined;
        writes.push({ relative, text, mode, expected, changed: source !== text });
      }
    }
    return writes;
  }
  writeEntries(entries, side, writes = this.prepareEntries(entries, side)) {
    for (const { relative, text, mode, expected, changed } of writes) {
      if (!same(expected, this.snapshot(relative))) error('DRIFT');
      if (changed) {
        if (text === undefined) this.remove(relative, expected);
        else this.atomic(relative, text, mode, expected);
      }
      this.inject('after-file', relative);
    }
  }
  recoverRecord(record) {
    // Refuse any managed value not exactly before or after; never restore whole JSON.
    const restore = [];
    for (const e of record.entries) {
      try { this.checkCurrent([e], 'before'); continue; } catch (err) { if (err.code !== 'DRIFT') throw err; }
      this.checkCurrent([e], 'after'); restore.push(e);
    }
    this.writeEntries(restore.reverse(), 'before');
    this.checkCurrent(record.entries, 'before');
  }
  cleanupStaging() {
    for (const relative of [...this.allowed, this.statePath('journal.json'), this.statePath('state.json')]) {
      const parent = path.dirname(relative), directory = parent === '.' ? '' : parent;
      if (!this.safe(directory, { directory: true })) continue;
      const prefix = path.basename(relative) + '.omo-';
      for (const name of fs.readdirSync(path.join(this.root, directory))) {
        if (name.startsWith(prefix) && /^[a-f0-9]{24}$/.test(name.slice(prefix.length)))
          this.remove(directory ? `${directory}/${name}` : name);
      }
    }
  }
  recover() {
    return this.withLock(() => {
      const journalSnapshot = this.snapshot(this.statePath('journal.json'));
      const record = this.load('journal.json');
      if (!record) { this.cleanupStaging(); return { ok: true, recovered: false }; }
      this.checkRecord(record);
      const state = this.load('state.json');
      if (state) this.checkRecord(state);
      if (state?.id === record.id && state.phase === 'committed') {
        this.checkCurrent(record.entries, 'after');
      } else this.recoverRecord(record);
      this.remove(this.statePath('journal.json'), journalSnapshot);
      this.cleanupStaging();
      return { ok: true, recovered: true };
    }, true);
  }
  apply(id, kind = 'apply') {
    const preview = this.previews.get(id);
    this.previews.delete(id);
    if (!preview || preview.kind !== kind || preview.expires <= this.now()) error('STALE_PREVIEW');
    const record = recordFor(preview.id, preview.input.configPath, preview.entries, this.data.manifest.version, preview.payloadHash, kind);
    const committed = { ...record, phase: 'committed', entries: record.entries.map(e => {
      const original = kind === 'apply' && preview.input.state?.operation === 'apply' && preview.input.state.entries.find(old => old.path === e.path && same(old.leafPath, e.leafPath));
      return original ? { ...e, before: original.before, beforeExists: original.beforeExists } : e;
    }) };
    this.checkRecord(record); this.checkRecord(committed);
    const journalText = bounded(JSON.stringify(record)), stateText = bounded(JSON.stringify(committed));
    if (kind === 'apply') {
      const inverse = recordFor(preview.id, committed.configPath, inverseEntries(committed.entries), this.data.manifest.version, preview.payloadHash, 'rollback');
      this.checkRecord(inverse);
      bounded(JSON.stringify(inverse));
      bounded(JSON.stringify({ ...inverse, phase: 'committed' }));
      // Verify the restored config too: baseline restoration may enlarge it.
      let restored = preview.input.config;
      for (const e of committed.entries.filter(e => e.kind === 'leaf')) restored = edit(restored, e.leafPath, e.afterExists ? e.after : undefined);
      for (const e of inverse.entries) {
        if (e.kind === 'leaf') restored = edit(restored, e.leafPath, e.afterExists ? e.after : undefined);
        else if (e.afterExists) bounded(e.after);
      }
      bounded(restored);
    }
    this.prepareEntries(record.entries, 'after');
    return this.withLock(() => {
      const current = this.inspect();
      if (!same(current.snapshots, preview.input.snapshots) || !same(current.root, preview.input.root) || payload().hash !== preview.payloadHash) error('STALE_PREVIEW');
      this.inject('validated', '');
      const recheck = this.inspect();
      if (!same(recheck.snapshots, current.snapshots) || !same(recheck.root, current.root)) error('STALE_PREVIEW');
      const writes = this.prepareEntries(record.entries, 'after');
      this.atomic(this.statePath('journal.json'), journalText);
      const journalSnapshot = this.snapshot(this.statePath('journal.json'));
      if (journalSnapshot?.hash !== hash(journalText)) error('RECOVERY_REQUIRED');
      try {
        this.checkCurrent(record.entries, 'before');
        this.writeEntries(record.entries, 'after', writes);
        this.checkCurrent(record.entries, 'after');
        this.inject('state-commit', '');
        this.atomic(this.statePath('state.json'), stateText, 0o600, current.snapshots[this.statePath('state.json')]);
        this.remove(this.statePath('journal.json'), journalSnapshot);
      } catch (cause) {
        const committed = this.load('state.json');
        if (committed?.id === record.id) error('RECOVERY_REQUIRED');
        try { this.recoverRecord(record); this.remove(this.statePath('journal.json'), journalSnapshot); }
        catch { error('RECOVERY_REQUIRED'); }
        throw cause;
      }
      return { ok: true, state: kind === 'apply' ? 'applied-pending-restart' : 'rolled-back-pending-restart', runtimeVerified: false };
    });
  }
  status() {
    const base = { installedVersion: '6.0.0', contentVersion: this.data.manifest.version, manifestHash: this.data.hash, appliedContentVersion: null, appliedContentHash: null, diskDrift: null, pendingRestart: false, runtimeVerified: false };
    try {
      const input = this.inspect();
      if (!input.state) return { ...base, state: 'not-applied' };
      if (input.state.operation === 'rollback') return { ...base, state: 'rolled-back-pending-restart', pendingRestart: true };
      let drift = false;
      try { this.checkCurrent(input.state.entries, 'after'); } catch { drift = true; }
      return { ...base, state: 'applied-pending-restart', appliedContentVersion: input.state.version, appliedContentHash: input.state.payloadHash, diskDrift: drift, appliedVersion: input.state.version, appliedHash: input.state.payloadHash, drift, pendingRestart: true };
    } catch (e) { return { ...base, state: e.code === 'RECOVERY_REQUIRED' ? 'recovery-required' : 'blocked' }; }
  }
}
