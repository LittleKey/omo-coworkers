import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { NativeStore } from './transaction.mjs';
import { NativeError, hash, parse, edit } from './generator.mjs';
import { WorkbenchState, exact, digest, initialDraft, validateDraft, validateState, roleIds } from './workbench-state.mjs';
import { projectDraft, importNativeDraft } from './workbench-projection.mjs';
import { planContent, assetText, assetsMatch } from './workbench-content.mjs';
import { classifyHot, hotProjection } from './workbench-hot.mjs';
import { readBehaviorSettings, updateBehaviorSettings } from '../service/behavior-settings.mjs';

const fail = code => { throw new NativeError(code); };
const validId = v => typeof v === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(v);
const clone = v => structuredClone(v);
const hashValue = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const integer = v => Number.isSafeInteger(v) && v >= 0;
const safeText = v => typeof v === 'string' && v.length <= 2048 && !/[\u0000-\u001f\u007f]/u.test(v);
const standardConsent = ['nativeCandidateRoot', 'defaultManagedHost', 'workPaused', 'overwriteAuthority', 'userConsent'];
function validCell(cell) {
  if (!exact(cell, ['keys', 'exists', 'value']) || typeof cell.exists !== 'boolean' ||
    !Array.isArray(cell.keys) || !cell.keys.every(k => typeof k === 'string')) return false;
  let keys = cell.keys;
  if (keys[0] === 'presets') {
    if (!safeText(keys[1]) || !keys[1]) return false;
    keys = keys[2] === 'agents' && keys.length === 5 ? ['agents', ...keys.slice(3)] :
      keys.length === 4 ? ['agents', ...keys.slice(2)] : [];
  }
  const [group, id, field, env] = keys;
  let validPath = group === 'disabled_agents' && keys.length === 1;
  validPath ||= group === 'agents' && keys.length === 3 && roleIds.includes(id) &&
    !['claude', 'antigravity'].includes(id) && ['model', 'variant', 'description', 'orchestratorPrompt'].includes(field);
  validPath ||= group === 'acpAgents' && ['claude', 'antigravity'].includes(id) &&
    (keys.length === 3 && ['wrapperModel', 'command', 'args', 'cwd', 'permissionMode', 'timeoutMs', 'description', 'prompt', 'orchestratorPrompt'].includes(field) ||
      id === 'claude' && keys.length === 4 && field === 'env' &&
      ['CLAUDE_CODE_DISABLE_CLAUDE_MDS', 'CLAUDE_CODE_DISABLE_BUNDLED_SKILLS', 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS'].includes(env));
  if (!validPath) return false;
  if (!cell.exists) return cell.value === null;
  if (group === 'disabled_agents') return Array.isArray(cell.value) && cell.value.length <= 4096 && cell.value.every(safeText);
  if (field === 'args') return Array.isArray(cell.value) && cell.value.length <= 128 && cell.value.every(safeText);
  if (field === 'timeoutMs') return integer(cell.value) && cell.value <= 2147483647;
  if (field === 'permissionMode') return ['ask', 'allow', 'reject'].includes(cell.value);
  if (field === 'env') return ['0', '1'].includes(cell.value);
  return safeText(cell.value);
}
export class Workbench {
  constructor({ root, directory, now = Date.now, runtimeEvidence = null }) {
    this.root = path.resolve(root);
    this.now = now;
    // Internal integration seam for isolated exported-consumer fixtures only;
    // no service route, environment variable or catalog field populates this.
    this.runtimeEvidence = runtimeEvidence;
    this.native = new NativeStore(root);
    this.private = new WorkbenchState(directory, () => {
      try { return importNativeDraft(this.target().text, readBehaviorSettings({ root }).claudeGuardEnabled); }
      catch { return initialDraft(); }
    });
    this.disk = this.private.paths;
    for (const store of [this.disk, this.native]) {
      const withLock = store.withLock.bind(store);
      store.withLock = fn => withLock(fn, true);
    }
    this.directory = directory;
  }
  load(name) {
    if (!this.disk.safe(name)) return null;
    if (fs.statSync(path.join(this.directory, name)).size > 1024 * 1024) fail('RECOVERY_REQUIRED');
    try {
      const value = JSON.parse(fs.readFileSync(path.join(this.directory, name), 'utf8'));
      if (name === 'workbench-state.json') return validateState(value);
      if (name.startsWith('operation-')) {
        if (!exact(value, ['operationId', 'revision', 'requestHash', 'state', 'code', 'runtime', 'relative',
          'nativeBeforeHash', 'nativeAfterHash', 'guardAfter', 'appliedDraft', 'guardBefore', 'nativeChanges',
          'createdAt', 'targetPath', 'restoreHash', 'assets', 'targetId', 'afterFileIdentity', 'mode'],
        ['operationId', 'revision', 'requestHash', 'state', 'code', 'runtime', 'relative',
          'nativeBeforeHash', 'nativeAfterHash', 'guardAfter', 'appliedDraft', 'guardBefore', 'nativeChanges',
          'createdAt', 'targetPath', 'assets', 'targetId', 'mode']) ||
          !['publish', 'hot'].includes(value.mode) ||
          !validId(value.operationId) || name !== `operation-${value.operationId}.json` ||
          !integer(value.revision) || !integer(value.createdAt) || !hashValue(value.requestHash) ||
          !hashValue(value.nativeBeforeHash) || !hashValue(value.nativeAfterHash) ||
          !hashValue(value.targetId) || value.afterFileIdentity !== undefined && !hashValue(value.afterFileIdentity) ||
          value.restoreHash !== undefined && !hashValue(value.restoreHash) ||
          !['pending', 'unknown', 'applied', 'restored'].includes(value.state) ||
          ![null, 'RECOVERY_REQUIRED'].includes(value.code) || value.runtime !== 'pending' ||
          !['oh-my-opencode-slim.json', 'oh-my-opencode-slim.jsonc'].includes(value.relative) ||
          value.targetPath !== path.join(this.root, value.relative) ||
          typeof value.guardBefore !== 'boolean' || typeof value.guardAfter !== 'boolean' ||
          !Array.isArray(value.nativeChanges) || value.nativeChanges.length > 100 ||
          !value.nativeChanges.every(validCell)) fail('RECOVERY_REQUIRED');
        validateDraft(value.appliedDraft);
        if (!Array.isArray(value.assets) || value.assets.length > 7 || value.assets.some(a =>
          !exact(a, ['path', 'beforeHash', 'afterHash', 'payloadHash']) ||
          !this.native.promptPaths.includes(a.path) || ![null, a.afterHash].includes(a.beforeHash) ||
          !hashValue(a.afterHash) || !hashValue(a.payloadHash))) fail('RECOVERY_REQUIRED');
      }
      if (name === 'workbench-preview.json') {
        if (!exact(value, ['previewId', 'revision', 'diffDigest', 'changes', 'risks', 'blockers',
          'requiredConfirmations', 'writeTarget', 'expiresAt', 'nativeBeforeHash', 'nativeSnapshot',
          'behaviorRevision', 'draft', 'assets', 'mode']) ||
          !['publish', 'hot'].includes(value.mode) ||
          !validId(value.previewId) || !integer(value.revision) || !integer(value.expiresAt) ||
          !hashValue(value.diffDigest) || !hashValue(value.nativeBeforeHash) ||
          !Array.isArray(value.changes) || value.changes.length > 100 ||
          !Array.isArray(value.risks) || value.risks.length > 5 ||
          !value.risks.every(v => ['firstTakeover', 'externalOverwrite', 'acpExecution', 'guardEnable', 'targetAuthorization'].includes(v)) ||
          !Array.isArray(value.requiredConfirmations) ||
          digest(value.requiredConfirmations) !== digest([
            ...(value.writeTarget?.consent === 'none' ? standardConsent : []), ...value.risks]) ||
          !exact(value.writeTarget, ['targetId', 'path', 'consent']) || !hashValue(value.writeTarget.targetId) ||
          !['oh-my-opencode-slim.json', 'oh-my-opencode-slim.jsonc'].some(f => value.writeTarget.path === path.join(this.root, f)) ||
          !['none', 'user-confirmed'].includes(value.writeTarget.consent) || typeof value.behaviorRevision !== 'string' ||
          !Array.isArray(value.blockers)) fail('RECOVERY_REQUIRED');
        validateDraft(value.draft);
        if (!Array.isArray(value.assets) || value.assets.length > 7 ||
          value.assets.some(a => !exact(a, ['path', 'beforeHash', 'afterHash', 'payloadHash']) ||
          !this.native.promptPaths.includes(a.path) || ![null, a.afterHash].includes(a.beforeHash) ||
          !hashValue(a.afterHash) || !hashValue(a.payloadHash))) fail('RECOVERY_REQUIRED');
      }
      return value;
    }
    catch { fail('RECOVERY_REQUIRED'); }
  }
  put(name, value) { this.disk.atomic(name, JSON.stringify(value)); }
  target() {
    this.native.safe('', { directory: true, missing: false });
    if (this.native.safe('.omo-coworkers/journal.json') ||
      this.native.safe('.omo-coworkers/manager-journal.json')) fail('LEGACY_RECOVERY_REQUIRED');
    const candidates = ['oh-my-opencode-slim.json', 'oh-my-opencode-slim.jsonc'].filter(p => this.native.safe(p));
    if (candidates.length > 1) fail('CONFLICT');
    const relative = candidates[0] ?? 'oh-my-opencode-slim.jsonc';
    const snapshot = this.native.snapshot(relative);
    const stat = this.native.safe('', { directory: true, missing: false });
    const targetPath = path.join(this.root, relative);
    // Content belongs to CAS; path/root/file identity belongs to consent.
    const targetId = digest([targetPath, stat.dev, stat.ino]);
    const fileIdentity = digest([snapshot?.dev ?? null, snapshot?.ino ?? null]);
    const text = snapshot ? fs.readFileSync(targetPath, 'utf8') : '{}\n';
    if (digest(snapshot) !== digest(this.native.snapshot(relative)) ||
      snapshot && hash(text) !== snapshot.hash) fail('CONFLICT');
    return { relative, snapshot, targetId, fileIdentity, path: targetPath, text };
  }
  publicTarget(t) {
    const consent = this.private?.state?.writeConsent;
    return { targetId: t.targetId, path: t.path,
      consent: consent?.targetId === t.targetId && consent.fileIdentity === t.fileIdentity ? 'user-confirmed' : 'none' };
  }
  snapshot() {
    const state = this.private.snapshot();
    let writeTarget = null, blockers = [];
    try {
      const target = this.target();
      writeTarget = this.publicTarget(target);
      try { importNativeDraft(target.text); planContent(this.native, target.text, target.text); }
      catch (e) { blockers.push(['COMPLEX_MODEL_SOURCE', 'PERSONAL_CONTENT_BLOCKED'].includes(e.code) ? e.code : 'INVALID_NATIVE_MANAGED_FIELDS'); }
    } catch { blockers = ['UNSAFE_OR_UNAVAILABLE_TARGET']; }
    return { ok: true, apiVersion: 4, ...state,
      appliedDraft: state.published?.appliedDraft ?? null,
      writeTarget, runtimeBinding: { configRoot: 'unverified', applied: 'unverified' },
      runtime: { state: state.published ? 'pending' : 'unknown' },
      capabilities: { publish: Boolean(writeTarget), hotApply: classifyHot({ entries: [] }, state.draft, this.runtimeEvidence).reasons.length === 0,
        hotState: classifyHot({ entries: [] }, state.draft, this.runtimeEvidence).state,
        hotReasons: classifyHot({ entries: [] }, state.draft, this.runtimeEvidence).reasons,
        hotCandidateBasis: { omoVersion: '3.0.8', scope: 'registered-enabled-ordinary-model-variant', runtimeVerified: false },
        nativeImport: true, diagnosticLogging: false },
      blockers,
      recommendationUpdate: { available: state.draft.recommendationVersion !== state.recommendations.version,
        fromVersion: state.draft.recommendationVersion, toVersion: state.recommendations.version } };
  }
  save(body) { return this.private.save(body); }
  importNative(body) {
    if (!exact(body, ['expectedRevision', 'mutationId', 'confirm']) || body.confirm !== true ||
      !Number.isSafeInteger(body.expectedRevision) || !validId(body.mutationId)) fail('INVALID_REQUEST');
    return this.disk.withLock(() => {
      this.private.state = this.load('workbench-state.json');
      const requestHash = digest({ kind: 'native-import', ...body });
      const prior = this.private.state.mutations.find(m => m.id === body.mutationId);
      if (prior) {
        if (prior.hash !== requestHash) fail('MUTATION_MISMATCH');
        return { ok: true, revision: prior.revision, replayed: true };
      }
      const draft = importNativeDraft(this.target().text, readBehaviorSettings({ root: this.root }).claudeGuardEnabled);
      return this.private.saveLocked({ expectedRevision: body.expectedRevision, mutationId: body.mutationId, draft }, requestHash);
    });
  }
  preview(body) {
    if (!exact(body, ['revision', 'mode']) || !Number.isSafeInteger(body.revision) ||
      !['publish', 'hot'].includes(body.mode)) fail('INVALID_REQUEST');
    const state = this.private.snapshot();
    if (body.revision !== state.revision) fail('STALE_REVISION');
    const target = this.target();
    let projection = projectDraft(target.text, state.draft);
    if (body.mode === 'hot') projection = hotProjection(target.text, projection, state.draft, this.runtimeEvidence);
    const content = body.mode === 'hot' ? { text: projection.text, entries: [], changes: [], assets: [] } :
      planContent(this.native, target.text, projection.text);
    const behavior = readBehaviorSettings({ root: this.root });
    if (behavior.source === 'blocked') fail('UNSAFE_PATH');
    if (body.mode === 'hot' && (!state.published || state.published.nativeHash !== hash(target.text) ||
      behavior.claudeGuardEnabled !== state.draft.settings.claudeGuardEnabled)) fail('HOT_UNVERIFIED');
    const changes = [...projection.changes, ...content.changes];
    if (behavior.claudeGuardEnabled !== state.draft.settings.claudeGuardEnabled)
      changes.push({ field: 'settings.claudeGuardEnabled', before: behavior.claudeGuardEnabled,
        after: state.draft.settings.claudeGuardEnabled, classification: 'cold' });
    const risks = [];
    if (!state.published) risks.push('firstTakeover');
    if (state.published && this.publicTarget(target).consent === 'none') risks.push('targetAuthorization');
    if (state.published && state.published.nativeHash !== hash(target.text)) risks.push('externalOverwrite');
    if (changes.some(c => c.field.startsWith('acpAgents.') &&
      ['command', 'args', 'cwd', 'permissionMode'].some(k => c.field.endsWith(`.${k}`))))
      risks.push('acpExecution');
    if (changes.some(c => c.field === 'settings.claudeGuardEnabled' && c.after)) risks.push('guardEnable');
    const previewId = crypto.randomUUID();
    const preview = { previewId, mode: body.mode, revision: state.revision, diffDigest: digest(changes),
      changes, risks, blockers: state.draft.settings.allowGlobalWrites ? [] : ['READ_ONLY'],
      requiredConfirmations: [...(this.publicTarget(target).consent === 'none' ? standardConsent : []), ...risks],
      writeTarget: this.publicTarget(target), expiresAt: this.now() + 24 * 60 * 60 * 1000,
      nativeBeforeHash: hash(target.text), nativeSnapshot: target.snapshot,
      behaviorRevision: behavior.revision, draft: state.draft, assets: content.assets };
    // Bounded latest preview per saved revision; no full native text is persisted.
    this.put('workbench-preview.json', preview);
    return this.publicPreview(preview);
  }
  publicPreview(p) {
    const { nativeBeforeHash, nativeSnapshot, behaviorRevision, draft, assets, ...value } = p;
    return { ok: true, ...value };
  }
  operation(body) {
    if (!exact(body, ['operationId', 'previewId', 'revision', 'diffDigest', 'confirmations', 'targetId']) ||
      !validId(body.operationId) || !validId(body.previewId) || !Array.isArray(body.confirmations) ||
      body.confirmations.length > 16 || !body.confirmations.every(v => typeof v === 'string')) fail('INVALID_REQUEST');
    return this.disk.withLock(() => {
      const file = `operation-${body.operationId}.json`, requestHash = digest(body);
      const prior = this.load(file);
      if (prior) {
        if (prior.requestHash !== requestHash) fail('OPERATION_MISMATCH');
        return this.statusLocked(body.operationId);
      }
      // Latest operator authorization can revoke an older pinned business draft.
      if (!this.load('workbench-state.json').draft.settings.allowGlobalWrites) fail('READ_ONLY');
      if (fs.readdirSync(this.directory).filter(f => f.startsWith('operation-')).length >= 128) fail('CAPACITY');
      const unresolved = fs.readdirSync(this.directory).filter(f => /^operation-[A-Za-z0-9_-]+\.json$/.test(f))
        .some(f => ['pending', 'unknown'].includes(this.load(f)?.state));
      if (unresolved) fail('RECOVERY_REQUIRED');
      const p = this.load('workbench-preview.json');
      if (!p || p.previewId !== body.previewId || p.revision !== body.revision ||
        p.diffDigest !== body.diffDigest || p.expiresAt < this.now()) fail('STALE_PREVIEW');
      if (!p.draft.settings.allowGlobalWrites) fail('READ_ONLY');
      if (p.writeTarget.targetId !== body.targetId ||
        p.requiredConfirmations.some(v => !body.confirmations.includes(v)) ||
        body.confirmations.some(v => !p.requiredConfirmations.includes(v))) fail('CONFIRMATION_REQUIRED');
      return this.native.withLock(() => {
        const target = this.target();
        if (target.targetId !== body.targetId || hash(target.text) !== p.nativeBeforeHash ||
          digest(target.snapshot) !== digest(p.nativeSnapshot)) fail('CONFLICT');
        const behavior = readBehaviorSettings({ root: this.root });
        if (behavior.revision !== p.behaviorRevision) fail('CONFLICT');
        let projection = projectDraft(target.text, p.draft);
        if (p.mode === 'hot') projection = hotProjection(target.text, projection, p.draft, this.runtimeEvidence);
        const content = p.mode === 'hot' ? { text: projection.text, entries: [], changes: [], assets: [] } :
          planContent(this.native, target.text, projection.text);
        if (digest(content.assets) !== digest(p.assets)) fail('CONFLICT');
        const op = { operationId: body.operationId, mode: p.mode, revision: p.revision, requestHash,
          state: 'pending', code: null, runtime: 'pending', relative: target.relative,
          nativeBeforeHash: hash(target.text), nativeAfterHash: hash(content.text),
          guardAfter: p.draft.settings.claudeGuardEnabled, appliedDraft: p.draft,
          guardBefore: behavior.claudeGuardEnabled,
          nativeChanges: [...projection.entries, ...content.entries], assets: content.assets, targetId: target.targetId,
          createdAt: this.now(), targetPath: target.path };
        this.put(file, op); // Durable ID and request hash precede all native writes.
        try {
          for (const asset of op.assets)
            if (asset.beforeHash === null) this.native.atomic(asset.path, assetText(this.native, asset), 0o600, null);
          this.native.atomic(target.relative, content.text, target.snapshot?.mode ?? 0o600, target.snapshot);
          if (behavior.claudeGuardEnabled !== op.guardAfter)
            updateBehaviorSettings({ root: this.root, revision: p.behaviorRevision,
              claudeGuardEnabled: op.guardAfter, confirmEnable: body.confirmations.includes('guardEnable') });
          const after = this.target();
          if (hash(after.text) !== op.nativeAfterHash || !assetsMatch(this.native, op.assets) ||
            readBehaviorSettings({ root: this.root }).claudeGuardEnabled !== op.guardAfter) fail('RECOVERY_REQUIRED');
          op.state = 'applied';
          op.afterFileIdentity = after.fileIdentity;
          this.put(file, op);
          // Update only the receipt; never replace a draft edited during this operation.
          this.recordApplied(op);
        } catch {
          op.state = 'unknown'; op.code = 'RECOVERY_REQUIRED';
          this.put(file, op);
        }
        return this.publicOperation(op);
      });
    });
  }
  publicOperation(op) {
    let recovery = null;
    if (['pending', 'unknown'].includes(op.state)) {
      try {
        const target = this.target(), guard = readBehaviorSettings({ root: this.root });
        if (target.targetId === op.targetId && target.path === op.targetPath &&
          [op.nativeBeforeHash, op.nativeAfterHash, op.restoreHash].includes(hash(target.text)) &&
          op.assets.every(a => [a.beforeHash, a.afterHash].includes(this.native.snapshot(a.path)?.hash ?? null)) &&
          guard.source !== 'blocked' && [op.guardBefore, op.guardAfter].includes(guard.claudeGuardEnabled))
          recovery = { action: 'conditional-restore', digest: digest([op.requestHash, target.snapshot, guard.revision,
            op.assets.map(a => this.native.snapshot(a.path))]) };
      } catch { /* No unsafe recovery offer. */ }
    }
    return { ok: true, operation: { operationId: op.operationId, revision: op.revision,
      state: op.state, code: op.code, runtime: op.runtime, recovery } };
  }
  restore(id, body) {
    if (!validId(id) || !exact(body, ['confirm', 'recoveryDigest']) || body.confirm !== true ||
      typeof body.recoveryDigest !== 'string') fail('INVALID_REQUEST');
    return this.disk.withLock(() => this.native.withLock(() => {
      const op = this.load(`operation-${id}.json`);
      if (!op) fail('NOT_FOUND');
      if (op.state === 'restored') return this.publicOperation(op);
      if (!this.load('workbench-state.json').draft.settings.allowGlobalWrites) fail('READ_ONLY');
      const offer = this.publicOperation(op).operation.recovery;
      if (!offer || offer.digest !== body.recoveryDigest) fail('CONFLICT');
      const target = this.target(), guard = readBehaviorSettings({ root: this.root });
      let output = target.text;
      if (!op.restoreHash && hash(output) === op.nativeAfterHash) {
        for (const cell of [...op.nativeChanges].reverse())
          output = edit(output, cell.keys, cell.exists ? cell.value : undefined);
      }
      // Restore only after-digest-equal managed leaves; never replace a mixed
      // whole-config backup or overwrite a third party's changed file.
      op.state = 'unknown'; op.code = 'RECOVERY_REQUIRED';
      op.restoreHash = hash(output);
      this.put(`operation-${id}.json`, op);
      try {
        if (output !== target.text)
          this.native.atomic(target.relative, output, target.snapshot?.mode ?? 0o600, target.snapshot);
        for (const asset of [...op.assets].reverse()) {
          const current = this.native.snapshot(asset.path);
          if (asset.beforeHash === null && current?.hash === asset.afterHash) this.native.remove(asset.path, current);
          else if ((current?.hash ?? null) !== asset.beforeHash) fail('CONFLICT');
        }
        if (guard.claudeGuardEnabled !== op.guardBefore)
          updateBehaviorSettings({ root: this.root, revision: guard.revision,
            claudeGuardEnabled: op.guardBefore, confirmEnable: true });
        if (hash(this.target().text) !== op.restoreHash ||
          !op.assets.every(a => (this.native.snapshot(a.path)?.hash ?? null) === a.beforeHash) ||
          readBehaviorSettings({ root: this.root }).claudeGuardEnabled !== op.guardBefore) fail('RECOVERY_REQUIRED');
        op.state = 'restored'; op.code = null;
        this.put(`operation-${id}.json`, op);
      } catch { /* Persisted unknown remains blocking, never retry blindly. */ }
      return this.publicOperation(op);
    }));
  }
  recordApplied(op) {
    const state = this.load('workbench-state.json');
    if (state.published && (state.published.createdAt > op.createdAt ||
      state.published.createdAt === op.createdAt && state.published.revision > op.revision)) return;
    if (state.published?.operationId === op.operationId) return;
    const current = this.target();
    this.private.state = { ...state,
      ...(op.afterFileIdentity && current.targetId === op.targetId && current.fileIdentity === op.afterFileIdentity ?
        { writeConsent: { targetId: op.targetId, fileIdentity: op.afterFileIdentity } } : {}),
      published: { revision: op.revision, operationId: op.operationId,
      appliedDraft: clone(op.appliedDraft), nativeHash: op.nativeAfterHash, createdAt: op.createdAt } };
    this.private.persist(this.private.state);
  }
  status(id) {
    return this.disk.withLock(() => this.statusLocked(id));
  }
  statusLocked(id) {
    if (!validId(id)) fail('INVALID_REQUEST');
    const op = this.load(`operation-${id}.json`);
    if (!op) fail('NOT_FOUND');
    // Readback resolves a successful write after response/process loss. Partial
    // writes stay unknown: never automatically replay or overwrite third parties.
    if (['pending', 'unknown'].includes(op.state)) {
      try {
        const target = this.target();
        if (op.restoreHash && target.targetId === op.targetId && target.path === op.targetPath && hash(target.text) === op.restoreHash &&
          op.assets.every(a => (this.native.snapshot(a.path)?.hash ?? null) === a.beforeHash) &&
          readBehaviorSettings({ root: this.root }).claudeGuardEnabled === op.guardBefore) {
          op.state = 'restored'; op.code = null;
          this.put(`operation-${id}.json`, op);
        } else if (!op.restoreHash && target.targetId === op.targetId && target.path === op.targetPath && hash(target.text) === op.nativeAfterHash &&
          assetsMatch(this.native, op.assets) &&
          readBehaviorSettings({ root: this.root }).claudeGuardEnabled === op.guardAfter) {
          op.state = 'applied'; op.code = null;
          this.put(`operation-${id}.json`, op);
          this.recordApplied(op);
        }
      } catch { /* Honest unresolved receipt, no raw exceptions. */ }
    }
    if (op.state === 'applied') this.recordApplied(op);
    return this.publicOperation(op);
  }
}
