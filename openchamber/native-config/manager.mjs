import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { NativeStore, MAX_FILE_BYTES } from './transaction.mjs';
import { parse, edit, hash, NativeError } from './generator.mjs';
import { listTemplates, composeTemplate } from './templates.mjs';
import { recipeState } from './recipe-state.mjs';
import { recipeIntents } from './recipe-intents.mjs';
import { capabilities } from './capabilities.mjs';

const id = () => crypto.randomBytes(16).toString('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const get = (o, p) => p.reduce((a, k) => a != null && own(Object(a), k) ? a[k] : undefined, o);
const byteLimit = text => { if (Buffer.byteLength(text) > MAX_FILE_BYTES) fail('CAPACITY'); return text; };
const fail = (code, resource = null, field = null) => { const e = new NativeError(code); e.resource = resource; e.field = field; throw e; };
const validPath = p => Array.isArray(p) && p.length <= 12 && p.every(k => typeof k === 'string' && k.length > 0 && k.length <= 128 && !['__proto__', 'prototype', 'constructor'].includes(k) && !k.includes('\0'));
const sensitive = value => typeof value === 'string' && (
  /\{env:|(?:bearer|basic)\s+\S|-----BEGIN|(?:sk-|ghp_|github_pat_|xox[baprs]-)[a-z0-9_-]{8}|[a-z]+:\/\/[^/\s]*@|[?&](?:key|token|secret|password)=/i.test(value)
);
const forbidden = p => p.some(k => /^(env|headers?|authorization|api.?key|token|password|secret|credentials?|provider|mcpServers)$/i.test(k));
const promptKey = p => /^(prompt|appendPrompt|orchestratorPrompt|description)$/.test(p.at(-1));
const nativeSchema = JSON.parse(fs.readFileSync(new URL('./schema/omo-3.0.8.json', import.meta.url), 'utf8'));
function schemaAt(p) {
  if (p.length === 4 && p[0] === 'presets' && p[2] !== 'agents') p = [p[0], p[1], 'agents', p[2], p[3]];
  let s = nativeSchema;
  for (const k of p) {
    if (s.oneOf || s.anyOf) s = (s.oneOf ?? s.anyOf).find(v => v.type === 'object') ?? {};
    s = s.properties?.[k] ?? (typeof s.additionalProperties === 'object' ? s.additionalProperties : {});
  }
  return s;
}
function schemaAccepts(s, v) {
  if (s.anyOf || s.oneOf) return (s.anyOf ?? s.oneOf).some(t => schemaAccepts(t, v));
  if (s.enum && !s.enum.includes(v) || own(s, 'const') && v !== s.const) return false;
  if (s.type === 'string') return typeof v === 'string' && (!s.minLength || v.length >= s.minLength) && (!s.pattern || new RegExp(s.pattern).test(v));
  if (s.type === 'boolean') return typeof v === 'boolean';
  if (s.type === 'number' || s.type === 'integer') return typeof v === 'number' && Number.isFinite(v) && (s.type !== 'integer' || Number.isInteger(v)) && (s.minimum === undefined || v >= s.minimum) && (s.maximum === undefined || v <= s.maximum);
  if (s.type === 'array') return Array.isArray(v) && (!s.minItems || v.length >= s.minItems) && v.every(x => schemaAccepts(s.items ?? {}, x));
  if (s.type === 'object') return safeObject(v) && (s.required ?? []).every(k => own(v, k)) && Object.entries(v).every(([k, x]) => s.properties?.[k] ? schemaAccepts(s.properties[k], x) : s.additionalProperties !== false && schemaAccepts(s.additionalProperties ?? {}, x));
  return true;
}
const ordinaryKey = /^(model|variant|inheritModelFrom|skills|mcps|mcp|permission|permissions|permissionMode|command|args|cwd|timeout|enabled|disabled|temperature|maxTokens|preset|extends|defaultAgent|fallback|fallbackModels|thinking|reasoningEffort|autoUpdate|notifications|experimental)$/;
const contextKnown = p => p.length === 1 && ['preset', 'defaultAgent', 'autoUpdate', 'notifications'].includes(p[0]) ||
  p.length === 3 && ['agents', 'acpAgents'].includes(p[0]) ||
  p.length === 3 && p[0] === 'presets' && p[2] === 'extends' ||
  p.length === 5 && p[0] === 'presets' && p[2] === 'agents' ||
  p.length === 4 && p[0] === 'presets' && p[2] !== 'agents' ||
  p.length >= 4 && ['agents', 'acpAgents'].includes(p[0]) && ['permission', 'permissions'].includes(p[2]);
function classification(p, value) {
  if (!contextKnown(p) || !Object.keys(schemaAt(p)).length || forbidden(p) || sensitive(value)) return 'protected';
  if (promptKey(p) && typeof value === 'string') return 'prompt';
  const key = p.at(-1);
  if ((ordinaryKey.test(key) || ['wrapperModel', 'timeoutMs', 'skills_add', 'skills_remove', 'skills_include_local'].includes(key)) && (value === null || ['string', 'number', 'boolean'].includes(typeof value) || Array.isArray(value) && value.every(v => ['string', 'number', 'boolean'].includes(typeof v) && !sensitive(v)))) return 'ordinary';
  // Explicit permission-map leaves, never conflate with ACP permissionMode.
  if (p.some(k => k === 'permission' || k === 'permissions') && ['allow', 'ask', 'deny', true, false].includes(value)) return 'ordinary';
  return 'protected';
}
const containsSensitive = value => typeof value === 'string' ? sensitive(value) : value && typeof value === 'object' ? Object.entries(value).some(([k, v]) => forbidden([k]) || containsSensitive(v)) : false;
function validateValue(p, value, category) {
  if (JSON.stringify(value)?.length > 60000 || containsSensitive(value) || value === undefined) fail('PROTECTED_FIELD', 'config', p);
  if (category === 'prompt') {
    if (typeof value !== 'string') fail('INVALID_VALUE', 'config', p);
    return;
  }
  if (classification(p, value) !== 'ordinary') fail('PROTECTED_FIELD', 'config', p);
  if (!schemaAccepts(schemaAt(p), value)) fail('INVALID_VALUE', 'config', p);
  const key = p.at(-1);
  if (['skills', 'mcps', 'mcp', 'args', 'fallbackModels'].includes(key) && (!Array.isArray(value) || !value.every(v => typeof v === 'string'))) fail('INVALID_VALUE', 'config', p);
   if (['variant', 'inheritModelFrom', 'command', 'cwd', 'preset', 'extends', 'permissionMode'].includes(key) && typeof value !== 'string') fail('INVALID_VALUE', 'config', p);
  if (key === 'permissionMode' && !['ask', 'allow', 'reject'].includes(value)) fail('INVALID_VALUE', 'config', p);
  if (['timeout', 'temperature', 'maxTokens'].includes(key) && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) fail('INVALID_VALUE', 'config', p);
}
const riskFor = op => op.action === 'delete' ? 'delete' : op.field.some(k => ['permission', 'permissions', 'permissionMode'].includes(k)) ? 'permission' : op.field.some(k => ['command', 'args', 'cwd'].includes(k)) ? 'execution' : null;
const safeObject = x => x && typeof x === 'object' && !Array.isArray(x);
const exactKeys = (o, allowed, required = allowed) => safeObject(o) && Object.keys(o).every(k => allowed.includes(k)) && required.every(k => own(o, k));

// Shared filesystem primitives, not the legacy content compiler/authority.
class ManagerFiles {
  constructor(root, { inject, now }) { this.root = root; this.inject = inject; this.now = now; }
  safe(relative, { missing = true, directory = false } = {}) {
    const target = relative ? path.resolve(this.root, relative) : this.root;
    if (relative && (path.isAbsolute(relative) || relative.split('/').some(p => p === '..' || p === '.')) || !(target === this.root || target.startsWith(this.root + path.sep))) fail('UNSAFE_PATH');
    let current = path.parse(target).root, privateAncestor = false;
    const parts = target.split(path.sep).filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      let stat;
      try { stat = fs.lstatSync(current); } catch (e) { if (e.code === 'ENOENT' && missing) return null; throw e; }
      if (stat.isSymbolicLink() || stat.uid !== process.getuid() && stat.uid !== 0 || stat.mode & 0o022 && !privateAncestor) fail('UNSAFE_PATH');
      if (stat.isDirectory() && stat.uid === process.getuid() && !(stat.mode & 0o077)) privateAncestor = true;
      if (i < parts.length - 1 || directory) { if (!stat.isDirectory()) fail('UNSAFE_PATH'); }
      else if (!stat.isFile() || stat.nlink !== 1) fail('UNSAFE_PATH');
    }
    return fs.lstatSync(target);
  }
}
// Reuse only low-level file/lock primitives, never legacy state/compiler methods.
for (const name of ['snapshot', 'statePath', 'load', 'ensureDir', 'syncDir', 'atomic', 'remove', 'deadLock', 'withLock']) {
  ManagerFiles.prototype[name] = NativeStore.prototype[name];
}

export class ConfigManager {
  constructor(root, { inject = () => {}, now = () => Date.now() } = {}) {
    this.root = path.resolve(root); this.files = new ManagerFiles(this.root, { inject, now });
    this.now = now; this.snapshots = new Map(); this.previews = new Map(); this.revealed = new Set();
    this.resources = new Map(); this.fileIds = new Map();
    this.recipePromptNames = JSON.parse(fs.readFileSync(new URL('./manifest.json', import.meta.url), 'utf8')).prompts.map(p => path.basename(p.path, '.md'));
  }
  diagnostic(code, resource = null) {
    const messages = {
      UNSAFE_PATH: ['Path ownership, sharing, link or file type is not safely writable.', 'Use a private owned directory; external symlink targets need explicit approval. No chmod is performed.'],
      RECOVERY_REQUIRED: ['An unfinished transaction or confirmed dead lock needs recovery.', 'Use the explicit recovery action before saving.'],
      LEGACY_STATE: ['Legacy managed baseline exists; it is not the manager authority.', 'Legacy incomplete journals require explicit recovery; completed state is retained untouched.'],
      SHADOWED: ['Both JSON and JSONC exist; JSONC is selected by native precedence.', 'Edit the selected resource; inspect project/env overrides separately.'],
      RUNTIME_UNCONFIRMED: ['Disk candidate is not evidence of running-host configuration.', 'Reload the host explicitly when ready; verify runtime separately.'],
      CUSTOM_ROOT_UNAVAILABLE: ['P0 edits the displayed default candidate only.', 'Do not assume OPENCODE_CONFIG_DIR is forwarded by the host.'],
      LOCKED: ['Another writer or unrecognized lock owner holds the lock.', 'Wait for that writer; only confirmed dead owners can be recovered.'],
      MIGRATION_REQUIRED: ['Legacy metadata requires an explicit one-time migration.', 'Preview migration after stopping the old writer; confirm receipt capability discard separately.'],
      LEGACY_RECOVERY_REQUIRED: ['An unresolved legacy journal blocks format3 migration and saving.', 'Use the legacy recovery procedure locally before migration; this service does not silently reinterpret it.'],
    };
    const [reason, nextAction] = messages[code] ?? ['The resource cannot be read safely.', 'Inspect the file locally, fix syntax or access, then refresh.'];
    return { code, resource, reason, nextAction };
  }
  resolve(logical, { missing = true } = {}) {
    if (path.isAbsolute(logical) || logical.split('/').some(k => !k || k === '.' || k === '..')) fail('UNSAFE_PATH');
    let full = path.join(this.root, logical);
    // Resolve approved internal links, preserving the logical link itself.
    const links = [];
    let current = this.root;
    this.files.safe('', { missing: false, directory: true });
    for (const part of logical.split('/')) {
      current = path.join(current, part);
      let stat;
      try { stat = fs.lstatSync(current); } catch (e) { if (e.code === 'ENOENT' && missing) break; throw e; }
      if (stat.isSymbolicLink()) {
        const resolved = fs.realpathSync(current);
        if (!resolved.startsWith(this.root + path.sep)) fail('UNSAFE_PATH');
        links.push({ path: current, target: fs.readlinkSync(current), ino: stat.ino, dev: stat.dev });
        current = resolved;
      }
    }
    full = path.join(this.root, logical);
    // When a missing parent stopped traversal, use full original resolved suffix.
    if (links.length) {
      const last = links.at(-1), prefix = path.relative(this.root, last.path);
      full = path.join(fs.realpathSync(last.path), path.relative(prefix, logical));
    }
    const relative = path.relative(this.root, full);
    let directory = false;
    try { directory = fs.lstatSync(full).isDirectory(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    this.files.safe(relative, { missing, directory });
    return { relative, links };
  }
  checkLinks(resource) {
    const next = this.resolve(resource.logical);
    if (next.relative !== resource.relative || !same(next.links, resource.links)) fail('CONFLICT', resource.id);
  }
  resource(logical, kind, forcedId) {
    const resolved = this.resolve(logical);
    if (this.fileIds.has(resolved.relative)) return this.resources.get(this.fileIds.get(resolved.relative));
    const resourceId = forcedId ?? `prompt-${hash(logical).slice(0, 24)}`;
    const r = { id: resourceId, kind, logical, ...resolved };
    this.resources.set(resourceId, r); this.fileIds.set(resolved.relative, resourceId);
    return r;
  }
  readResource(r) {
    this.checkLinks(r);
    const before = this.files.snapshot(r.relative);
    const text = before ? fs.readFileSync(path.join(this.root, r.relative), 'utf8') : r.kind === 'config' ? '{}\n' : '';
    if (before && hash(text) !== before.hash || !same(before, this.files.snapshot(r.relative))) fail('CONFLICT', r.id);
    return { text, object: r.kind === 'config' ? parse(text) : before ? text : undefined, snapshot: before };
  }
  discover() {
    this.resources.clear(); this.fileIds.clear();
    const diagnostics = [this.diagnostic('RUNTIME_UNCONFIRMED'), this.diagnostic('CUSTOM_ROOT_UNAVAILABLE')];
    const exists = name => { try { return !!fs.lstatSync(path.join(this.root, name)); } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
    const jsonc = exists('oh-my-opencode-slim.jsonc'), json = exists('oh-my-opencode-slim.json');
    this.resource(jsonc || !json ? 'oh-my-opencode-slim.jsonc' : 'oh-my-opencode-slim.json', 'config', 'config');
    if (jsonc && json) diagnostics.push(this.diagnostic('SHADOWED', 'config'));
    const promptDir = 'oh-my-opencode-slim';
    const walk = (directory, depth) => {
      const resolved = this.resolve(directory);
      if (!this.files.safe(resolved.relative, { directory: true })) return;
      for (const ent of fs.readdirSync(path.join(this.root, resolved.relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (this.resources.size > 128) fail('CAPACITY');
        if (!/^[a-zA-Z0-9_-]+(?:\.md)?$/.test(ent.name)) continue;
        const logical = `${directory}/${ent.name}`;
        if (ent.isDirectory() && depth < 1) walk(logical, depth + 1);
        else if (ent.name.endsWith('.md')) {
          try { this.resource(logical, 'prompt'); } catch { diagnostics.push(this.diagnostic('UNSAFE_PATH')); }
        }
      }
    };
    try { if (exists(promptDir)) walk(promptDir, 0); } catch { diagnostics.push(this.diagnostic('UNSAFE_PATH')); }
    if (!exists('.omo-coworkers/manager-state.json') && exists('.omo-coworkers/state.json')) diagnostics.push(this.diagnostic('LEGACY_STATE'));
    if (exists('.omo-coworkers/journal.json') || exists('.omo-coworkers/manager-journal.json') || this.files.deadLock()) diagnostics.push(this.diagnostic('RECOVERY_REQUIRED'));
    return diagnostics;
  }
  project(resource, data, revision) {
    const fields = [];
    const protect = (p, value) => {
      const category = resource.kind === 'prompt' ? sensitive(value) ? 'protected' : 'prompt' : classification(p, value);
      const placeholder = hash(`${revision}:${resource.id}:${JSON.stringify(p)}:${id()}`);
      const field = { path: p, classification: category, editable: category === 'ordinary' };
      if (category === 'ordinary') field.value = value;
      else field.placeholder = placeholder;
      fields.push(field);
      return category === 'ordinary' ? value : { protected: true, placeholder };
    };
    const visit = (value, p) => {
      if (Array.isArray(value) && classification(p, value) !== 'ordinary') return value.map((v, i) => visit(v, [...p, String(i)]));
      if (safeObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, visit(v, [...p, k])]));
      return protect(p, value);
    };
    const projection = resource.kind === 'prompt' ? protect([], data.object) : visit(data.object, []);
    return { id: resource.id, kind: resource.kind, logicalPath: resource.logical, actualPath: path.join(this.root, resource.relative), revision, projection, fields, writable: true };
  }
  snapshot() {
    const revision = id(), raw = new Map();
    let diagnostics, resources = [];
    try {
      diagnostics = this.discover();
      for (const r of this.resources.values()) {
        try { const data = this.readResource(r); raw.set(r.id, { ...r, ...data }); resources.push(this.project(r, data, revision)); }
        catch (e) { diagnostics.push(this.diagnostic(e.code ?? 'IO_FAILURE', r.id)); }
      }
    } catch (e) { diagnostics = [this.diagnostic(e.code ?? 'IO_FAILURE')]; }
    this.snapshots.set(revision, { raw, created: this.now() });
    this.pruneSnapshots();
    let history = [];
    try { history = this.history(); } catch { diagnostics.push(this.diagnostic('RECOVERY_REQUIRED')); }
    try {
      const state = this.state();
      if (state.pending) diagnostics.push(this.diagnostic('RECOVERY_REQUIRED'));
      if (!this.load('manager-state.json') && this.hasLegacy()) diagnostics.push(this.diagnostic('MIGRATION_REQUIRED'));
    } catch { diagnostics.push(this.diagnostic('RECOVERY_REQUIRED')); }
    return { ok: true, revision, resources, diagnostics, history: history.map(h => ({ id: h.id, summary: h.label, undoable: true })), capabilities: { differentialEdit: true, protectedProjection: true, runtimeVerified: false }, runtimeVerified: false };
  }
  pruneSnapshots() {
    for (const [key, snap] of this.snapshots) if (this.now() - snap.created >= 300000) this.snapshots.delete(key);
    while (this.snapshots.size > 16) this.snapshots.delete(this.snapshots.keys().next().value);
    for (const grant of this.revealed) if (!this.snapshots.has(grant.split(':')[0])) this.revealed.delete(grant);
  }
  currentSnapshot(revision) {
    this.pruneSnapshots();
    const snap = this.snapshots.get(revision);
    if (!snap) fail('STALE_REVISION');
    return snap;
  }
  reveal(body) {
    if (!exactKeys(body, ['resourceId', 'revision', 'field', 'confirm'], ['resourceId', 'revision', 'confirm']) || body.confirm !== true) fail('CONFIRMATION_REQUIRED');
    const snap = this.currentSnapshot(body.revision), r = snap.raw.get(body.resourceId), p = body.field ?? [];
    if (!r || !validPath(p) || r.kind === 'prompt' && p.length) fail('STALE_REVISION');
    const value = r.kind === 'prompt' ? r.object : get(r.object, p);
    if ((r.kind !== 'prompt' && classification(p, value) !== 'prompt') || sensitive(value) || typeof value !== 'string') fail('PROTECTED_FIELD', r.id, p);
    this.revealed.add(`${body.revision}:${r.id}:${JSON.stringify(p)}`);
    return { ok: true, resourceId: r.id, field: p, value, warning: 'Explicit ordinary-text reveal. Do not use prompts for credentials; this resource may enter bounded undo history when saved.' };
  }
  preview(body, trustedTemplate = false, readDependencies = []) {
    if (!exactKeys(body, ['revision', 'operations']) || !Array.isArray(body.operations) || body.operations.length < 1 || body.operations.length > 32) fail('INVALID_REQUEST');
    const snap = this.currentSnapshot(body.revision);
    const entries = [], changes = [], seen = new Set();
    for (const op of body.operations) {
      if (!exactKeys(op, ['resourceId', 'field', 'action', 'value'], op.action === 'set' ? ['resourceId', 'field', 'action', 'value'] : ['resourceId', 'field', 'action']) || !validPath(op.field) || !['set', 'delete'].includes(op.action)) fail('INVALID_REQUEST');
      const r = snap.raw.get(op.resourceId);
      if (!r || r.kind === 'prompt' && op.field.length || r.kind === 'config' && !op.field.length) fail('INVALID_RESOURCE');
      const key = `${r.id}:${JSON.stringify(op.field)}`;
      if (seen.has(key) || [...seen].some(k => k.startsWith(`${r.id}:`) && (JSON.parse(k.slice(r.id.length + 1)).every((v, i) => op.field[i] === v) || op.field.every((v, i) => JSON.parse(k.slice(r.id.length + 1))[i] === v)))) fail('INVALID_REQUEST');
      seen.add(key);
      const before = r.kind === 'prompt' ? r.object : get(r.object, op.field);
      let category = r.kind === 'prompt' ? sensitive(before) ? 'protected' : 'prompt' : classification(op.field, before === undefined ? op.value : before);
      if (category === 'protected') fail('PROTECTED_FIELD', r.id, op.field);
      if (category === 'prompt' && !this.revealed.has(`${body.revision}:${r.id}:${JSON.stringify(op.field)}`) && !trustedTemplate) fail('REVEAL_REQUIRED', r.id, op.field);
      if (op.action === 'set') validateValue(op.field, op.value, category);
      const after = op.action === 'delete' ? undefined : op.value;
      if (same(before, after)) continue;
      entries.push({ resourceId: r.id, logical: r.logical, relative: r.relative, links: r.links, kind: r.kind, field: op.field, beforeExists: before !== undefined, before: before ?? null, afterExists: after !== undefined, after: after ?? null, category });
      changes.push({ resourceId: r.id, field: op.field, action: op.action, before: before ?? null, after: after ?? null, risk: riskFor(op) });
    }
    if (!entries.length) fail('NO_CHANGES');
    const mutations = entries.map(e => {
      const { before, beforeExists, after, afterExists, ...target } = e;
      return { target, before: { exists: beforeExists, value: before }, after: { exists: afterExists, value: after } };
    });
    const safeChanges = this.safeChanges(mutations);
    for (let i = 0; i < mutations.length; i++) {
      const m = mutations[i], change = safeChanges[i];
      if (m.target.category !== 'prompt') continue;
      if (this.revealed.has(`${body.revision}:${m.target.resourceId}:${JSON.stringify(m.target.field)}`)) {
        change.before = m.before.value; change.after = m.after.value;
      } else if (trustedTemplate) {
        // New bundled desired content is public repository text; existing
        // personal content remains hash-only until explicitly revealed.
        change.after = m.after.value;
      }
    }
    const delta = this.delta(mutations, trustedTemplate ? 'Apply recipe' : 'Edit configuration');
    delta.guards.push(...readDependencies);
    return this.registerPreview(delta, safeChanges);
  }
  assertNoConflicts(entries, side) {
    const conflicts = [];
    for (const e of entries) {
      const data = this.readResource({ id: e.resourceId, logical: e.logical, relative: e.relative, links: e.links, kind: e.kind });
        const value = e.kind === 'prompt' ? data.object : get(data.object, e.field);
      if (!same(value, e[side + 'Exists'] ? e[side] : undefined)) conflicts.push({ resourceId: e.resourceId, field: e.field });
    }
    if (conflicts.length) { const e = new NativeError('CONFLICT'); e.conflicts = conflicts; throw e; }
  }
  load(name) { return this.files.load(name); }
  target(r, field, category) {
    return { resourceId: r.id, logical: r.logical, relative: r.relative, links: r.links, kind: r.kind, field, category };
  }
  checkNativeTarget(t, live = false) {
    if (!exactKeys(t, ['resourceId', 'logical', 'relative', 'links', 'kind', 'field', 'category']) ||
        !['config', 'prompt'].includes(t.kind) || !validPath(t.field) || !['ordinary', 'prompt', 'membership', 'presence'].includes(t.category) ||
        t.kind === 'config' && (!['oh-my-opencode-slim.json', 'oh-my-opencode-slim.jsonc'].includes(t.logical) || !t.field.length) ||
        t.kind === 'prompt' && (!/^oh-my-opencode-slim\/(?:[a-zA-Z0-9_-]+\/)?[a-zA-Z0-9_-]+\.md$/.test(t.logical) || t.field.length)) fail('RECOVERY_REQUIRED');
    if (typeof t.relative !== 'string' || path.isAbsolute(t.relative) || t.relative.split('/').some(k => !k || k === '.' || k === '..') || !Array.isArray(t.links)) fail('RECOVERY_REQUIRED');
    for (const link of t.links) if (!exactKeys(link, ['path', 'target', 'ino', 'dev']) ||
        typeof link.path !== 'string' || !link.path.startsWith(this.root + path.sep) ||
        typeof link.target !== 'string' || !Number.isSafeInteger(link.ino) || !Number.isSafeInteger(link.dev)) fail('RECOVERY_REQUIRED');
    if (live) {
      const resolved = this.resolve(t.logical);
      if (resolved.relative !== t.relative || !same(resolved.links, t.links)) fail('CONFLICT');
    }
  }
  checkNativeValue(t, value) {
    if (t.category === 'membership') {
      if (t.kind !== 'config' || t.field.length !== 2 || t.field[0] !== 'disabled_agents' || !['document-writer', 'lark-operator'].includes(t.field[1]) || typeof value !== 'boolean') fail('INVALID_VALUE');
      return;
    }
    if (t.category === 'prompt' && ['prompt', 'appendPrompt'].includes(t.field.at(-1)) && contextKnown(t.field) && typeof value === 'string') {
      validateValue(t.field, value, 'prompt'); return;
    }
    if (t.kind === 'config' && (t.category === 'prompt' ? classification(t.field, value) !== 'prompt' : classification(t.field, value) !== 'ordinary')) fail('PROTECTED_FIELD');
    validateValue(t.field, value, t.category);
  }
  nativeCell(t) {
    const data = this.readResource({ ...t, id: t.resourceId });
    if (t.category === 'presence') {
      if (t.kind !== 'config' || t.field.length !== 4 || t.field[0] !== 'presets' || t.field[2] !== 'agents' || !['document-writer', 'lark-operator'].includes(t.field[3])) fail('INVALID_VALUE');
      return { exists: true, value: own(get(data.object, t.field.slice(0, -1)) ?? {}, t.field.at(-1)) };
    }
    if (t.category === 'membership') {
      const members = data.object.disabled_agents ?? ['observer'];
      if (!Array.isArray(members) || members.some(v => typeof v !== 'string')) fail('INVALID_VALUE');
      return { exists: true, value: members.includes(t.field[1]) };
    }
    const value = t.kind === 'prompt' ? data.object : get(data.object, t.field);
    return { exists: value !== undefined, value: value ?? null };
  }
  nativeEntries(delta) {
    return delta.mutations.filter(m => m.target.kind !== 'user-template').map(m => ({
      ...m.target, beforeExists: m.before.exists, before: m.before.value,
      afterExists: m.after.exists, after: m.after.value,
    }));
  }
  checkUserSelection(field, value) {
    if (!validPath(field) || field.some(k => ['command', 'args', 'cwd'].includes(k)) || classification(field, value) !== 'ordinary') fail('PROTECTED_FIELD');
    validateValue(field, value, 'ordinary');
  }
  checkUserTemplate(t) {
    if (!safeObject(t) || !/^user-[a-z0-9-]{1,48}$/.test(t.id) || typeof t.description !== 'string' || t.description.length > 200 || containsSensitive(t)) fail('INVALID_REQUEST');
    if (exactKeys(t, ['id', 'description', 'baseTemplateId', 'parameters'])) {
      if (!listTemplates().some(b => b.id === t.baseTemplateId) || !safeObject(t.parameters)) fail('INVALID_REQUEST');
      // Compiler validates a finite parameter shape without importing personal data.
      composeTemplate(t.baseTemplateId, { config: {}, parameters: t.parameters });
    } else {
      if (!exactKeys(t, ['id', 'description', 'changes']) || !Array.isArray(t.changes) || !t.changes.length || t.changes.length > 32) fail('INVALID_REQUEST');
      const seen = new Set();
      for (const c of t.changes) {
        if (!exactKeys(c, ['kind', 'path', 'value']) || c.kind !== 'field') fail('INVALID_REQUEST');
        this.checkUserSelection(c.path, c.value);
        const key = JSON.stringify(c.path); if (seen.has(key)) fail('INVALID_REQUEST'); seen.add(key);
      }
    }
  }
  validateLegacyManaged(record) {
    // Read-only validator; no legacy recovery/compiler authority is inherited.
    const validator = new NativeStore(this.root);
    validator.checkRecord(record);
  }
  validateLegacyRecord(r) {
    if (!exactKeys(r, ['format', 'id', 'createdAt', 'entries', 'metadata']) || r.format !== 2 || !/^[a-f0-9]{32}$/.test(r.id) ||
        !Number.isFinite(Date.parse(r.createdAt)) || !Array.isArray(r.entries) || r.entries.length > 32) fail('RECOVERY_REQUIRED');
    for (const e of r.entries) {
      if (!exactKeys(e, ['resourceId', 'logical', 'relative', 'links', 'kind', 'field', 'beforeExists', 'before', 'afterExists', 'after', 'category']) || typeof e.beforeExists !== 'boolean' || typeof e.afterExists !== 'boolean') fail('RECOVERY_REQUIRED');
      const { before, beforeExists, after, afterExists, ...target } = e;
      this.checkNativeTarget(target);
      if (beforeExists) this.checkNativeValue(target, before); else if (before !== null) fail('RECOVERY_REQUIRED');
      if (afterExists) this.checkNativeValue(target, after); else if (after !== null) fail('RECOVERY_REQUIRED');
    }
    if (r.metadata !== null && (!safeObject(r.metadata) || !Object.keys(r.metadata).every(k => ['templateId', 'templateVersion', 'removed', 'trustedTemplate', 'baseline', 'receiptUndo', 'inverseMetadata', 'adoption'].includes(k)))) fail('RECOVERY_REQUIRED');
    const validateMetadata = (m, depth = 0) => {
      if (m === null || m === undefined) return;
      if (depth > 2 || !safeObject(m) || !Object.keys(m).every(k => ['templateId', 'templateVersion', 'removed', 'trustedTemplate', 'baseline', 'receiptUndo', 'inverseMetadata', 'adoption'].includes(k))) fail('RECOVERY_REQUIRED');
      for (const k of ['templateId', 'templateVersion']) if (own(m, k) && (typeof m[k] !== 'string' || m[k].length > 200)) fail('RECOVERY_REQUIRED');
      for (const k of ['removed', 'trustedTemplate', 'adoption']) if (own(m, k) && typeof m[k] !== 'boolean') fail('RECOVERY_REQUIRED');
      if (m.baseline !== undefined) {
        if (!Array.isArray(m.baseline) || m.baseline.length > 32) fail('RECOVERY_REQUIRED');
        for (const b of m.baseline) {
          if (!exactKeys(b, ['logical', 'field', 'value']) || !validPath(b.field)) fail('RECOVERY_REQUIRED');
          const kind = b.field.length ? 'config' : 'prompt', resolved = this.resolve(b.logical);
          const target = { resourceId: kind, logical: b.logical, ...resolved, kind, field: b.field, category: kind === 'prompt' || promptKey(b.field) ? 'prompt' : 'ordinary' };
          this.checkNativeTarget(target); this.checkNativeValue(target, b.value);
        }
      }
      if (m.receiptUndo !== undefined) {
        const u = m.receiptUndo;
        if (!exactKeys(u, ['templateId', 'expected', 'restore']) || typeof u.templateId !== 'string') fail('RECOVERY_REQUIRED');
        for (const receipt of [u.expected, u.restore]) if (receipt !== null) {
          if (!exactKeys(receipt, ['metadata', 'entries']) || receipt.metadata?.templateId !== u.templateId) fail('RECOVERY_REQUIRED');
          validateMetadata(receipt.metadata, depth + 1);
          this.validateLegacyRecord({ format: 2, id: '0'.repeat(32), createdAt: new Date(0).toISOString(), entries: receipt.entries, metadata: null });
        }
      }
      validateMetadata(m.inverseMetadata, depth + 1);
    };
    validateMetadata(r.metadata);
  }
  prepare(entries, side) {
    const groups = new Map();
    for (const e of entries) { if (!groups.has(e.relative)) groups.set(e.relative, []); groups.get(e.relative).push(e); }
    const writes = [];
    for (const [relative, group] of groups) {
      const e = group[0], r = { id: e.resourceId, logical: e.logical, relative, links: e.links, kind: e.kind };
      const data = this.readResource(r); let text = data.text;
      if (side === 'after') for (const entry of group) {
        const current = entry.category === 'membership' ? (data.object.disabled_agents ?? ['observer']).includes(entry.field[1]) : e.kind === 'config' ? get(data.object, entry.field) : data.object;
        if (!same(current, entry.beforeExists ? entry.before : undefined)) fail('CONFLICT', e.resourceId, entry.field);
      }
      for (const entry of group) {
        const value = entry[side + 'Exists'] ? entry[side] : undefined;
        if (entry.category === 'membership') {
          const object = parse(text), members = object.disabled_agents ?? ['observer'];
          if (!Array.isArray(members) || members.some(v => typeof v !== 'string')) fail('INVALID_VALUE');
          const next = members.filter(v => v !== entry.field[1]);
          if (value) next.push(entry.field[1]);
          text = edit(text, ['disabled_agents'], next); continue;
        }
        text = e.kind === 'config' ? value === undefined && get(parse(text), entry.field) === undefined ? text : edit(text, entry.field, value) : value;
      }
      if (text !== undefined) byteLimit(text);
      writes.push({ r, text, snapshot: data.snapshot });
    }
    return writes;
  }
  writePrepared(writes) {
    for (const { r, text, snapshot } of writes) {
      this.checkLinks(r);
      if (!same(snapshot, this.files.snapshot(r.relative))) fail('CONFLICT', r.id);
      if (text === undefined) this.files.remove(r.relative, snapshot);
      else this.files.atomic(r.relative, text, snapshot?.mode ?? 0o600, snapshot);
      this.files.inject('after-file', r.relative);
    }
  }
}

export { exactKeys, classification };

Object.assign(ConfigManager.prototype, recipeState, recipeIntents);
Object.assign(ConfigManager.prototype, capabilities);
