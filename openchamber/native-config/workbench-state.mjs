import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { NativeStore } from './transaction.mjs';
import { NativeError } from './generator.mjs';

export const recommendations = JSON.parse(fs.readFileSync(new URL('./recommended-models.json', import.meta.url), 'utf8'));
export const roleIds = Object.keys(recommendations.roles);
const acp = ['claude', 'antigravity'];
const envKeys = ['CLAUDE_CODE_DISABLE_CLAUDE_MDS', 'CLAUDE_CODE_DISABLE_BUNDLED_SKILLS', 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS'];
const fail = code => { throw new NativeError(code); };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export const exact = (v, keys, required = keys) => object(v) && Object.keys(v).every(k => keys.includes(k)) && required.every(k => Object.hasOwn(v, k));
const text = v => typeof v === 'string' && v.length <= 2048 && !/[\u0000-\u001f\u007f]/u.test(v);
const clone = v => structuredClone(v);
export const digest = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function initialDraft() {
  return { recommendationsEnabled: true, recommendationVersion: recommendations.version,
    roles: Object.fromEntries(roleIds.map(id => [id, { enabled: id !== 'observer', ...recommendations.roles[id],
      ...(acp.includes(id) ? { command: id === 'claude' ? 'claude-agent-acp' : 'agy',
        args: id === 'claude' ? [] : ['acp'], permissionMode: 'ask', timeoutMs: 0 } : {}) }])),
    settings: { allowGlobalWrites: false, claudeGuardEnabled: false } };
}
export function validateDraft(draft) {
  if (!exact(draft, ['recommendationsEnabled', 'recommendationVersion', 'roles', 'settings']) ||
      typeof draft.recommendationsEnabled !== 'boolean' || !text(draft.recommendationVersion) ||
      !exact(draft.roles, roleIds) || !exact(draft.settings, ['allowGlobalWrites', 'claudeGuardEnabled']) ||
      Object.values(draft.settings).some(v => typeof v !== 'boolean')) fail('INVALID_VALUE');
  for (const id of roleIds) {
    const r = draft.roles[id], fields = acp.includes(id) ?
      ['enabled', 'wrapperModel', 'requestedVariant', 'command', 'args', 'cwd', 'permissionMode', 'timeoutMs', 'behaviorEnv'] :
      ['enabled', 'model', 'variant'];
    if (!exact(r, fields, ['enabled']) || typeof r.enabled !== 'boolean' ||
      ['orchestrator', 'councillor'].includes(id) && !r.enabled) fail('INVALID_VALUE');
    for (const key of ['model', 'variant', 'wrapperModel', 'requestedVariant', 'command', 'cwd'])
      if (Object.hasOwn(r, key) && !text(r[key])) fail('INVALID_VALUE');
    if (r.args !== undefined && (!Array.isArray(r.args) || r.args.length > 128 || !r.args.every(text))) fail('INVALID_VALUE');
    if (r.permissionMode !== undefined && !['ask', 'allow', 'reject'].includes(r.permissionMode)) fail('INVALID_VALUE');
    if (r.timeoutMs !== undefined && (!Number.isSafeInteger(r.timeoutMs) || r.timeoutMs < 0 || r.timeoutMs > 2147483647)) fail('INVALID_VALUE');
    if (r.behaviorEnv !== undefined && (id !== 'claude' || !exact(r.behaviorEnv, envKeys, []) ||
      Object.values(r.behaviorEnv).some(v => !['0', '1'].includes(v)))) fail('INVALID_VALUE');
  }
  if (Buffer.byteLength(JSON.stringify(draft)) > 50000) fail('TOO_LARGE');
  return clone(draft);
}
export function validateState(state) {
  try {
    if (!exact(state, ['version', 'revision', 'draft', 'mutations', 'published', 'recommendationBase', 'writeConsent'],
      ['version', 'revision', 'draft', 'mutations', 'published']) ||
      state.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 ||
      !Array.isArray(state.mutations) || state.mutations.length > 4096) fail('RECOVERY_REQUIRED');
    validateDraft(state.draft);
    const seen = new Set();
    for (const m of state.mutations) {
      if (!exact(m, ['id', 'hash', 'revision']) || typeof m.id !== 'string' ||
        !/^[A-Za-z0-9_-]{8,128}$/.test(m.id) || !/^[a-f0-9]{64}$/.test(m.hash) ||
        !Number.isSafeInteger(m.revision) || m.revision < 1 || m.revision > state.revision ||
        seen.has(m.id)) fail('RECOVERY_REQUIRED');
      seen.add(m.id);
    }
    const p = state.published;
    if (p !== null) {
      if (!exact(p, ['revision', 'operationId', 'appliedDraft', 'nativeHash', 'createdAt']) ||
        !Number.isSafeInteger(p.revision) || p.revision < 0 || p.revision > state.revision ||
        typeof p.operationId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(p.operationId) ||
        !/^[a-f0-9]{64}$/.test(p.nativeHash) || !Number.isSafeInteger(p.createdAt) || p.createdAt < 0) fail('RECOVERY_REQUIRED');
      validateDraft(p.appliedDraft);
    }
    const base = state.recommendationBase;
    if (base != null) {
      if (!exact(base, ['version', 'roles']) || !text(base.version) || !exact(base.roles, roleIds)) fail('RECOVERY_REQUIRED');
      for (const id of roleIds) {
        const fields = acp.includes(id) ? ['wrapperModel', 'requestedVariant'] : ['model', 'variant'];
        if (!exact(base.roles[id], fields, []) || Object.values(base.roles[id]).some(v => !text(v))) fail('RECOVERY_REQUIRED');
      }
    }
    if (state.writeConsent != null && (!exact(state.writeConsent, ['targetId', 'fileIdentity']) ||
      !/^[a-f0-9]{64}$/.test(state.writeConsent.targetId) ||
      !/^[a-f0-9]{64}$/.test(state.writeConsent.fileIdentity))) fail('RECOVERY_REQUIRED');
    return state;
  } catch { fail('RECOVERY_REQUIRED'); }
}

// Private draft state never lives alongside native output. Atomic replacement
// includes mutation receipts, so a crash cannot acknowledge only half a save.
export class WorkbenchState {
  constructor(directory, initialize = initialDraft) {
    if (!directory || !path.isAbsolute(directory)) fail('UNSAFE_PATH');
    this.directory = directory;
    this.paths = new NativeStore(directory);
    this.paths.safe('', { directory: true });
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.paths.safe('', { directory: true, missing: false });
    this.file = path.join(directory, 'workbench-state.json');
    if (this.paths.safe('workbench-state.json')) {
      if (fs.statSync(this.file).size > 1024 * 1024) fail('RECOVERY_REQUIRED');
      try { this.state = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { fail('RECOVERY_REQUIRED'); }
      validateState(this.state);
    } else {
      this.state = { version: 1, revision: 0, draft: validateDraft(initialize()), mutations: [], published: null,
        recommendationBase: clone(recommendations) };
      this.persist(this.state);
    }
  }
  persist(state) {
    validateState(state);
    this.paths.safe('workbench-state.json');
    const tmp = `workbench-${crypto.randomUUID()}.tmp`, target = path.join(this.directory, tmp);
    const fd = fs.openSync(target, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(state));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    try {
      this.paths.safe('workbench-state.json');
      fs.renameSync(target, this.file);
      const dir = fs.openSync(this.directory, 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    } finally { if (fs.existsSync(target)) fs.unlinkSync(target); }
  }
  snapshot() {
    const stat = this.paths.safe('workbench-state.json', { missing: false });
    if (stat.size > 1024 * 1024) fail('RECOVERY_REQUIRED');
    try { this.state = validateState(JSON.parse(fs.readFileSync(this.file, 'utf8'))); }
    catch { fail('RECOVERY_REQUIRED'); }
    return { revision: this.state.revision, draft: clone(this.state.draft), published: clone(this.state.published),
      recommendations: clone(recommendations), recommendationBase: clone(this.state.recommendationBase ?? null) };
  }
  setPublished(receipt) {
    return this.paths.withLock(() => {
      this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.state.published = clone(receipt);
      this.persist(this.state);
    }, true);
  }
  save(body) {
    return this.paths.withLock(() => {
      // Re-read under the private lock; multiple service instances cannot
      // independently accept the same expected revision.
      try { this.state = validateState(JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch { fail('RECOVERY_REQUIRED'); }
      return this.saveLocked(body);
    }, true);
  }
  saveLocked(body, requestHash = digest(body)) {
    if (!exact(body, ['expectedRevision', 'mutationId', 'draft']) ||
      !Number.isSafeInteger(body.expectedRevision) || !/^[A-Za-z0-9_-]{8,128}$/.test(body.mutationId)) fail('INVALID_REQUEST');
    const draft = validateDraft(body.draft), hash = requestHash;
    const previous = this.state.mutations.find(m => m.id === body.mutationId);
    if (previous) {
      if (previous.hash !== hash) fail('MUTATION_MISMATCH');
      // Original receipt does not carry an old full draft back over newer edits.
      return { ok: true, revision: previous.revision, replayed: true };
    }
    if (body.expectedRevision !== this.state.revision) fail('STALE_REVISION');
    if (this.state.mutations.length >= 4096) fail('CAPACITY');
    const next = { ...this.state, revision: this.state.revision + 1, draft,
      mutations: [...this.state.mutations, { id: body.mutationId, hash, revision: this.state.revision + 1 }],
      recommendationBase: draft.recommendationVersion === recommendations.version ?
        clone(recommendations) : this.state.recommendationBase ?? null };
    this.persist(next); this.state = next;
    return { ok: true, revision: next.revision, draft: clone(draft) };
  }
}
