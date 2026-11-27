import { NativeError, hash } from './generator.mjs';
import crypto from 'node:crypto';

const fail = code => { throw new NativeError(code); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const keys = (v, allowed) => object(v) && Object.keys(v).length === allowed.length && Object.keys(v).every(k => allowed.includes(k));
const cell = v => keys(v, ['exists', 'value']) && typeof v.exists === 'boolean' && (v.exists || v.value === null);
const uid = () => crypto.randomBytes(16).toString('hex');
const bounded = text => { if (Buffer.byteLength(text) > 4194304) fail('CAPACITY'); return text; };
const statePath = '.omo-coworkers/manager-state.json';

// The only state machine: compile a Delta, register a preview, commit it.
export const recipeState = {
  delta(mutations, label, guards = mutations.map(m => ({ target: m.target, expected: m.before }))) {
    return { id: uid(), guards, mutations, label };
  },
  checkDelta(d) {
    if (!keys(d, ['id', 'guards', 'mutations', 'label']) || !/^[a-f0-9]{32}$/.test(d.id) || typeof d.label !== 'string' || d.label.length > 200 ||
        !Array.isArray(d.mutations) || !d.mutations.length || d.mutations.length > 32 || !Array.isArray(d.guards) || d.guards.length > 64) fail('RECOVERY_REQUIRED');
    const seen = new Set(), targets = [];
    const checkTarget = t => {
      if (t?.kind === 'user-template') {
        if (!keys(t, ['kind', 'templateId']) || !/^user-[a-z0-9-]{1,48}$/.test(t.templateId)) fail('RECOVERY_REQUIRED');
      } else this.checkNativeTarget(t);
    };
    for (const m of d.mutations) {
      if (!keys(m, ['target', 'before', 'after']) || !cell(m.before) || !cell(m.after)) fail('RECOVERY_REQUIRED');
      checkTarget(m.target);
      if (m.target.category === 'acp-entry' && m.before.exists === m.after.exists) fail('RECOVERY_REQUIRED');
      const key = JSON.stringify(m.target);
      if (seen.has(key) || same(m.before, m.after)) fail('RECOVERY_REQUIRED');
      if (targets.some(t => t.kind !== 'user-template' && m.target.kind !== 'user-template' && t.relative === m.target.relative &&
          (t.field.every((k, i) => m.target.field[i] === k) || m.target.field.every((k, i) => t.field[i] === k)))) fail('RECOVERY_REQUIRED');
      targets.push(m.target);
      seen.add(key);
      for (const c of [m.before, m.after]) if (c.exists) {
        if (m.target.kind === 'user-template') {
          this.checkUserTemplate(c.value);
          if (c.value.id !== m.target.templateId) fail('RECOVERY_REQUIRED');
        } else this.checkNativeValue(m.target, c.value);
      }
    }
    for (const g of d.guards) {
      if (!keys(g, ['target', 'expected']) || !cell(g.expected)) fail('RECOVERY_REQUIRED');
      checkTarget(g.target);
    }
    for (const m of d.mutations) if (!d.guards.some(g => same(g.target, m.target) && same(g.expected, m.before))) fail('RECOVERY_REQUIRED');
    bounded(JSON.stringify(d));
    return d;
  },
  state() {
    const s = this.load('manager-state.json');
    if (!s) return { format: 3, userTemplates: [], undo: [], pending: null };
    if (!keys(s, ['format', 'userTemplates', 'undo', 'pending']) || s.format !== 3 || !Array.isArray(s.userTemplates) || s.userTemplates.length > 20 || !Array.isArray(s.undo) || s.undo.length > 10) fail('RECOVERY_REQUIRED');
    const seen = new Set();
    for (const t of s.userTemplates) { this.checkUserTemplate(t); if (seen.has(t.id)) fail('RECOVERY_REQUIRED'); seen.add(t.id); }
    for (const d of s.undo) this.checkDelta(d);
    if (s.pending !== null) this.checkDelta(s.pending);
    return s;
  },
  history() { return this.state().undo; },
  userTemplates() { return this.state().userTemplates; },
  hasLegacy() { return ['state.json', 'manager-history.json', 'user-templates.json'].some(n => this.files.snapshot(`.omo-coworkers/${n}`) !== null); },
  assertWritable() {
    if (this.load('journal.json') || this.load('manager-journal.json') || this.state().pending) fail('RECOVERY_REQUIRED');
    if (!this.load('manager-state.json') && this.hasLegacy()) fail('MIGRATION_REQUIRED');
  },
  readCell(target, state = this.state()) {
    if (target.kind === 'user-template') {
      const value = state.userTemplates.find(t => t.id === target.templateId);
      return { exists: value !== undefined, value: value ?? null };
    }
    this.checkNativeTarget(target, true);
    return this.nativeCell(target);
  },
  checkGuards(d, state) {
    const conflicts = d.guards.filter(g => !same(this.readCell(g.target, state), g.expected));
    if (conflicts.length) {
      const e = new NativeError('CONFLICT');
      e.conflicts = conflicts.map(g => ({ resourceId: g.target.resourceId ?? 'user-templates', field: g.target.field ?? [g.target.templateId] }));
      throw e;
    }
  },
  registerPreview(delta, changes = [], extra = {}) {
    if (extra.migration) {
      if (delta !== null) fail('INVALID_REQUEST');
    } else {
      this.checkDelta(delta);
      this.checkGuards(delta);
    }
    for (const [key, p] of this.previews) if (this.now() >= p.expires) this.previews.delete(key);
    const previewId = uid(), expires = this.now() + 300000;
    this.previews.set(previewId, { delta, changes, expires, ...extra });
    while (this.previews.size > 16) this.previews.delete(this.previews.keys().next().value);
    return { ok: true, previewId, expiresAt: new Date(expires).toISOString(), changes, warnings: ['Disk changes are not runtime verification.', 'Cross-file writes are recoverable, not atomic.'], runtimeVerified: false };
  },
  finalState(old, delta) {
    const userTemplates = [...old.userTemplates];
    for (const m of delta.mutations) if (m.target.kind === 'user-template') {
      const i = userTemplates.findIndex(t => t.id === m.target.templateId);
      if (i >= 0) userTemplates.splice(i, 1);
      if (m.after.exists) userTemplates.push(m.after.value);
    }
    if (userTemplates.length > 20) fail('CAPACITY');
    return { format: 3, userTemplates, undo: [...old.undo.slice(-9), delta], pending: null };
  },
  commit(delta) {
    this.checkDelta(delta);
    this.assertWritable();
    // Capacity is checked before lock/state directory creation and again in lock.
    const admission = old => {
      this.checkGuards(delta, old);
      this.validateAcpEntries(delta);
      const pending = bounded(JSON.stringify({ ...old, pending: delta }));
      const final = bounded(JSON.stringify(this.finalState(old, delta)));
      const writes = this.prepare(this.nativeEntries(delta), 'after');
      this.prepare(this.nativeEntries(delta), 'before');
      return { pending, final, writes };
    };
    admission(this.state());
    return this.files.withLock(() => {
      this.assertWritable();
      const old = this.state(), expected = this.files.snapshot(statePath);
      const { pending, final, writes } = admission(old);
      try {
        this.files.inject('pending', statePath);
        this.files.atomic(statePath, pending, 0o600, expected);
        const pendingSnapshot = this.files.snapshot(statePath);
        this.files.inject('pending-published', statePath);
        this.writePrepared(writes);
        for (const m of delta.mutations) if (m.target.kind !== 'user-template' && !same(this.readCell(m.target, old), m.after)) fail('CONFLICT');
        this.files.inject('state-commit', statePath);
        this.files.atomic(statePath, final, 0o600, pendingSnapshot);
        this.files.inject('committed', statePath);
      } catch { fail('RECOVERY_REQUIRED'); }
      return { ok: true, state: 'saved-pending-reload', transactionId: delta.id, runtimeVerified: false };
    });
  },
  save(body) {
    if (!object(body) || !Object.keys(body).every(k => ['previewId', 'confirmRisk'].includes(k)) || typeof body.previewId !== 'string') fail('INVALID_REQUEST');
    const p = this.previews.get(body.previewId); this.previews.delete(body.previewId);
    if (!p || this.now() >= p.expires) fail('STALE_PREVIEW');
    if (p.changes.some(c => c.risk) && body.confirmRisk !== true) fail('CONFIRMATION_REQUIRED');
    if (p.migration) return this.commitMigration(p);
    return this.commit(p.delta);
  },
  undoPreview(body) {
    if (!keys(body, ['transactionId'])) fail('INVALID_REQUEST');
    const prior = this.state().undo.find(d => d.id === body.transactionId);
    if (!prior) fail('STALE_REVISION');
    const mutations = prior.mutations.map(m => ({ target: m.target, before: m.after, after: m.before }));
    return this.registerPreview(this.delta(mutations, 'Undo change'), this.safeChanges(mutations));
  },
  migrationPreview(body) {
    if (!object(body) || !Object.keys(body).every(k => ['confirmOldWriterStopped', 'confirmDiscardReceipts'].includes(k)) || body.confirmOldWriterStopped !== true ||
        body.confirmDiscardReceipts !== undefined && body.confirmDiscardReceipts !== true) fail('CONFIRMATION_REQUIRED');
    if (this.load('manager-state.json')) { this.state(); fail('NO_CHANGES'); }
    if (this.load('journal.json') || this.load('manager-journal.json')) fail('LEGACY_RECOVERY_REQUIRED');
    const legacy = this.validateLegacy(body.confirmDiscardReceipts === true);
    // Explicit one-time legacy adapter, not a fabricated business mutation.
    return this.registerPreview(null, [], { migration: { id: uid(), hashes: legacy.hashes, state: legacy.state, discard: body.confirmDiscardReceipts === true } });
  },
  validateLegacy(discard) {
    const names = ['state.json', 'manager-history.json', 'user-templates.json'];
    const hashes = names.map(name => ({ name, snapshot: this.files.snapshot(`.omo-coworkers/${name}`) }));
    const old = this.load('manager-history.json');
    if (old) {
      if (!keys(old, ['format', 'records', 'receipts']) || old.format !== 2 || !Array.isArray(old.records) || old.records.length > 10 || !Array.isArray(old.receipts) || old.receipts.length > 20) fail('RECOVERY_REQUIRED');
      if (old.receipts.length && !discard) fail('CONFIRMATION_REQUIRED');
      // Never interpret legacy instructions as format3 mutations.
      for (const r of old.records) this.validateLegacyRecord(r);
      for (const r of old.receipts) {
        if (!keys(r, ['metadata', 'entries']) || !object(r.metadata) || typeof r.metadata.templateId !== 'string') fail('RECOVERY_REQUIRED');
        this.validateLegacyRecord({ format: 2, id: '0'.repeat(32), createdAt: new Date(0).toISOString(), entries: r.entries, metadata: r.metadata });
      }
    }
    const managed = this.load('state.json');
    if (managed) this.validateLegacyManaged(managed);
    const users = this.load('user-templates.json');
    if (users && (!keys(users, ['format', 'templates']) || users.format !== 2 || !Array.isArray(users.templates) || users.templates.length > 20)) fail('RECOVERY_REQUIRED');
    const userTemplates = users?.templates ?? [];
    for (const t of userTemplates) this.checkUserTemplate(t);
    if (new Set(userTemplates.map(t => t.id)).size !== userTemplates.length) fail('RECOVERY_REQUIRED');
    return { hashes, state: { format: 3, userTemplates, undo: [], pending: null } };
  },
  commitMigration(preview) {
    const text = bounded(JSON.stringify(preview.migration.state));
    return this.files.withLock(() => {
      if (this.load('manager-state.json')) fail('CONFLICT');
      if (this.load('journal.json') || this.load('manager-journal.json')) fail('LEGACY_RECOVERY_REQUIRED');
      const fresh = this.validateLegacy(preview.migration.discard);
      if (!same(fresh.hashes, preview.migration.hashes) || !same(fresh.state, preview.migration.state)) fail('CONFLICT');
      this.files.atomic(statePath, text, 0o600, null);
      return { ok: true, state: 'migrated', transactionId: preview.migration.id, runtimeVerified: false };
    });
  },
  recover(body) {
    if (!keys(body, ['confirm']) || body.confirm !== true) fail('CONFIRMATION_REQUIRED');
    // Old recovery is deliberately not converted into a format3 transaction.
    if (this.load('journal.json') || this.load('manager-journal.json')) fail('LEGACY_RECOVERY_REQUIRED');
    return this.files.withLock(() => {
      const s = this.state(), expected = this.files.snapshot(statePath), d = s.pending;
      if (!d) return { ok: true, state: 'recovered', runtimeVerified: false };
      const restore = [];
      for (const m of d.mutations) {
        const current = this.readCell(m.target, s);
        if (same(current, m.before)) continue;
        if (!same(current, m.after)) fail('CONFLICT');
        if (m.target.kind !== 'user-template') restore.push(m);
      }
      // Recheck after planning and use the same ordinary before-CAS compiler.
      const inverse = restore.map(m => ({ target: m.target, before: m.after, after: m.before }));
      this.checkGuards(this.delta(inverse, 'Recover pending'), s);
      this.writePrepared(this.prepare(this.nativeEntries({ mutations: inverse }), 'after'));
      for (const m of d.mutations) if (!same(this.readCell(m.target, s), m.before)) fail('CONFLICT');
      this.files.atomic(statePath, bounded(JSON.stringify({ ...s, pending: null })), 0o600, expected);
      return { ok: true, state: 'recovered', runtimeVerified: false };
    }, true);
  },
  safeChanges(mutations) {
    return mutations.map(m => ({
      resourceId: m.target.resourceId ?? 'user-templates', field: m.target.field ?? [m.target.templateId],
      action: m.after.exists ? 'set' : 'delete',
      beforeExists: m.before.exists, afterExists: m.after.exists,
      ...(m.target.category === 'acp-entry' ? { entrySummary: this.publicEntrySummary(m) } : {}),
      ...(['ordinary', 'membership', 'behavior-env'].includes(m.target.category) ? { before: m.before.value, after: m.after.value } : { beforeHash: m.before.exists ? hash(JSON.stringify(m.before.value)) : null, afterHash: m.after.exists ? hash(JSON.stringify(m.after.value)) : null }),
      risk: m.target.category === 'behavior-env' ? 'behavior-change' : m.target.category === 'acp-entry' ? 'execution-and-content' : !m.after.exists ? 'delete' : m.target.field?.some(k => ['permission', 'permissions', 'permissionMode', 'command', 'args', 'cwd'].includes(k)) ? 'permission-or-execution' : null,
    }));
  },
  publicEntrySummary(m) {
    if (m.before.exists === m.after.exists) fail('RECOVERY_REQUIRED');
    const value = m.after.exists ? m.after.value : m.before.value;
    this.checkNativeValue(m.target, value);
    const runtime = {};
    for (const key of ['command', 'args', 'cwd', 'wrapperModel', 'timeoutMs', 'permissionMode']) {
      if (Object.hasOwn(value, key)) runtime[key] = value[key];
    }
    return { action: m.after.exists ? 'create' : 'delete', agentId: m.target.field[1], runtime };
  },
};
