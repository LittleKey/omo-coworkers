import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ConfigManager } from '../openchamber/native-config/manager.mjs';
const base = path.resolve('.opencode/work/validation');
fs.mkdirSync(base, { recursive: true });
function fixture(t) {
  const home = fs.mkdtempSync(path.join(base, 'recipe-'));
  const root = path.join(home, 'opencode'); fs.mkdirSync(root, { mode: 0o775 });
  const file = path.join(root, 'oh-my-opencode-slim.jsonc');
  fs.writeFileSync(file, '{// retained\n"agents":{"writer":{"model":"vendor/old"}},"unknown":"PRIVATE"}', { mode: 0o664 });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { root, file, m: new ConfigManager(root) };
}
const op = value => ({ resourceId: 'config', field: ['agents', 'writer', 'model'], action: 'set', value });
const preview = (m, value) => m.preview({ revision: m.snapshot().revision, operations: [op(value)] });
const save = (m, p) => m.save({ previewId: p.previewId, confirmRisk: true });
test('ordinary, recipe, user definition and undo use one preview/commit state', t => {
  const { m, file, root } = fixture(t);
  const p = preview(m, 'vendor/new');
  assert.ok(p.expiresAt); assert.ok(!fs.existsSync(path.join(root, '.omo-coworkers')));
  fs.appendFileSync(file, '\n// unrelated');
  const first = save(m, p);
  assert.match(fs.readFileSync(file, 'utf8'), /unrelated/);
  assert.throws(() => save(m, p), { code: 'STALE_PREVIEW' });
  save(m, m.undoPreview({ transactionId: first.transactionId }));
  assert.match(fs.readFileSync(file, 'utf8'), /vendor\/old/);
  const user = m.saveUserTemplate({ revision: m.snapshot().revision, id: 'user-model', description: 'Model', selection: [{ resourceId: 'config', field: op('').field }] });
  assert.equal(m.userTemplates().length, 0);
  const created = save(m, user); assert.equal(m.userTemplates().length, 1);
  save(m, m.undoPreview({ transactionId: created.transactionId })); assert.equal(m.userTemplates().length, 0);
  const recipe = m.templatePreview({ revision: m.snapshot().revision, templateId: 'document-role' });
  save(m, recipe);
  assert.throws(() => m.templatePreview({ revision: m.snapshot().revision, templateId: 'document-role' }), { code: 'NO_CHANGES' });
  assert.equal(m.state().format, 3); assert.equal(m.state().pending, null);
  assert.ok(!JSON.stringify(m.state()).includes('PRIVATE'));
});
test('recipe customized values require explicit replacement', t => {
  const { m, file } = fixture(t);
  save(m, m.templatePreview({ revision: m.snapshot().revision, templateId: 'document-role' }));
  let text = fs.readFileSync(file, 'utf8');
  text = text.replace('"description":', '"description":'); // mutate selected field through ordinary disk authority
  const data = JSON.parse(text.replace(/\/\/[^\n]*/g, ''));
  data.agents['document-writer'].description = 'Personal description';
  fs.writeFileSync(file, JSON.stringify(data));
  const revision = m.snapshot().revision;
  let conflict;
  try { m.templatePreview({ revision, templateId: 'document-role' }); } catch (e) { conflict = e; }
  assert.equal(conflict.code, 'CONFLICT');
  const replacement = m.templatePreview({ revision, templateId: 'document-role', replace: conflict.conflicts });
  assert.ok(!replacement.warnings.includes('PERSONAL_VALUE_PRESERVED'));
  save(m, replacement);
});
test('same-field conflicts, sixteen cache and all snapshot/preview expiry', t => {
  const { m, file } = fixture(t);
  const p = preview(m, 'vendor/new');
  fs.writeFileSync(file, '{"agents":{"writer":{"model":"other"}}}');
  assert.throws(() => save(m, p), { code: 'CONFLICT' });
  const first = preview(m, 'v/0');
  for (let i = 1; i <= 16; i++) preview(m, `v/${i}`);
  assert.equal(m.previews.size, 16);
  assert.throws(() => save(m, first), { code: 'STALE_PREVIEW' });
  const last = preview(m, 'v/end'), revision = m.snapshot().revision;
  m.now = () => Date.now() + 300001;
  assert.throws(() => save(m, last), { code: 'STALE_PREVIEW' });
  assert.throws(() => m.saveUserTemplate({ revision, id: 'user-x', description: 'X', selection: [] }), { code: 'STALE_REVISION' });
  assert.throws(() => m.deleteUserTemplate({ revision, id: 'user-x' }), { code: 'STALE_REVISION' });
  assert.throws(() => m.templatePreview({ revision, templateId: 'document-role' }), { code: 'STALE_REVISION' });
});
test('history last ten has no age expiration', t => {
  const { m } = fixture(t);
  for (let i = 0; i < 12; i++) save(m, preview(m, `v/${i}`));
  assert.equal(m.history().length, 10);
  m.now = () => Date.now() + 1000 * 86400000;
  assert.equal(m.history().length, 10);
  save(m, m.undoPreview({ transactionId: m.history().at(-1).id }));
});
test('every observed write/rename/phase failure recovers in a new manager', t => {
  const observed = [];
  {
    const { m } = fixture(t);
    m.files.inject = (stage, target) => observed.push([stage, target]);
    save(m, m.templatePreview({ revision: m.snapshot().revision, templateId: 'document-role' }));
  }
  assert.ok(observed.some(([s]) => s === 'pending-published'));
  for (let index = 0; index < observed.length; index++) {
    const { m, root, file } = fixture(t);
    const p = m.templatePreview({ revision: m.snapshot().revision, templateId: 'document-role' });
    let count = 0;
    m.files.inject = () => { if (count++ === index) throw Error('injected'); };
    assert.throws(() => save(m, p), { code: 'RECOVERY_REQUIRED' });
    const fresh = new ConfigManager(root);
    fresh.recover({ confirm: true }); fresh.recover({ confirm: true });
    assert.equal(fresh.state().pending, null);
    const text = fs.readFileSync(file, 'utf8');
    const object = JSON.parse(text.replace(/\/\/[^\n]*/g, ''));
    assert.ok(!object.agents['document-writer']?.description || fresh.history().length === 1);
  }
});
test('true child crash after pending/native file and third-value refusal', t => {
  for (const boundary of ['pending-published', 'after-file', 'committed']) {
    const { root, file } = fixture(t);
    const script = `import {ConfigManager} from ${JSON.stringify(new URL('../openchamber/native-config/manager.mjs', import.meta.url).href)};
      const m=new ConfigManager(${JSON.stringify(root)},{inject:s=>{if(s===${JSON.stringify(boundary)})process.exit(77)}});
      const p=m.preview({revision:m.snapshot().revision,operations:[${JSON.stringify(op('vendor/new'))}]});m.save({previewId:p.previewId});`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, HOME: base, TMPDIR: base, XDG_CACHE_HOME: base } });
    assert.equal(child.status, 77, child.stderr.toString());
    const m = new ConfigManager(root);
    m.recover({ confirm: true });
    assert.equal(m.state().pending, null);
    assert.match(fs.readFileSync(file, 'utf8'), boundary === 'committed' ? /vendor\/new/ : /vendor\/old/);
  }
  const { m, root, file } = fixture(t), p = preview(m, 'vendor/new');
  m.files.inject = s => { if (s === 'after-file') throw Error('stop'); };
  assert.throws(() => save(m, p));
  fs.writeFileSync(file, '{"agents":{"writer":{"model":"third"}}}');
  const fresh = new ConfigManager(root);
  assert.throws(() => fresh.recover({ confirm: true }), { code: 'CONFLICT' });
  assert.ok(fresh.state().pending); assert.match(fs.readFileSync(file, 'utf8'), /third/);
});
test('migration explicit receipt discard, legacy unchanged and new state authority', t => {
  const { m, root } = fixture(t);
  const dir = path.join(root, '.omo-coworkers'); fs.mkdirSync(dir);
  const legacy = JSON.stringify({ format: 2, records: [], receipts: [{ metadata: { templateId: 'old' }, entries: [] }] });
  fs.writeFileSync(path.join(dir, 'manager-history.json'), legacy);
  const p = preview(m, 'v/new');
  assert.throws(() => save(m, p), { code: 'MIGRATION_REQUIRED' });
  assert.throws(() => m.migrationPreview({ confirmOldWriterStopped: true }), { code: 'CONFIRMATION_REQUIRED' });
  const migration = m.migrationPreview({ confirmOldWriterStopped: true, confirmDiscardReceipts: true });
  assert.ok(!fs.existsSync(path.join(dir, 'manager-state.json')));
  save(m, migration);
  assert.equal(fs.readFileSync(path.join(dir, 'manager-history.json'), 'utf8'), legacy);
  fs.writeFileSync(path.join(dir, 'manager-history.json'), 'broken');
  // Old source no longer read after format3 exists.
  save(m, preview(m, 'v/new')); assert.equal(m.history().length, 1);
});
test('all intent previews share cache, TTL, one-shot and metadata conflict CAS', t => {
  const { m } = fixture(t);
  const userBody = () => ({ revision: m.snapshot().revision, id: 'user-x', description: 'X', selection: [{ resourceId: 'config', field: op('').field }] });
  const user = m.saveUserTemplate(userBody());
  const ordinary = save(m, preview(m, 'v/next'));
  assert.throws(() => save(m, user), { code: 'CONFLICT' });
  const created = save(m, m.saveUserTemplate(userBody()));
  const makers = [
    () => preview(m, 'v/another'),
    () => m.templatePreview({ revision: m.snapshot().revision, templateId: 'document-role' }),
    () => m.deleteUserTemplate({ revision: m.snapshot().revision, id: 'user-x' }),
    () => m.undoPreview({ transactionId: created.transactionId }),
  ];
  for (const make of makers) {
    const p = make();
    for (let i = 0; i < 16; i++) make();
    assert.throws(() => save(m, p), { code: 'STALE_PREVIEW' });
    const expiring = make(), prior = m.now;
    m.now = () => prior() + 300000;
    assert.throws(() => save(m, expiring), { code: 'STALE_PREVIEW' });
    m.now = prior;
  }
  assert.ok(ordinary.transactionId);
});
test('actual UTF8 pending/new-state/output admission refuses before lock', t => {
  const { m, root, file } = fixture(t);
  const p = preview(m, 'v/new'), d = m.previews.get(p.previewId).delta;
  const seed = n => ({ format: 3, userTemplates: [], pending: null, undo: Array.from({ length: 10 }, (_, i) => ({
    ...d, id: String(i).repeat(32), mutations: d.mutations.map(x => ({ ...x, before: { exists: true, value: 'é'.repeat(n) }, after: { exists: true, value: 'ø'.repeat(n) } })),
    guards: [{ ...d.guards[0], expected: { exists: true, value: 'é'.repeat(n) } }, ...Array.from({ length: 2 }, (_, j) => ({ ...d.guards[0], target: { ...d.guards[0].target, field: ['agents', `history${j}`, 'model'] }, expected: { exists: true, value: 'é'.repeat(n) } }))],
  })) });
  const originalState = m.state.bind(m), originalLock = m.files.withLock;
  let candidate, locks = 0;
  m.state = () => candidate;
  m.files.withLock = () => { locks++; throw Error('ADMITTED'); };
  const admitted = n => {
    candidate = seed(n);
    try { m.commit(d); } catch (e) { if (e.message === 'ADMITTED') return true; assert.equal(e.code, 'CAPACITY'); return false; }
  };
  let lo = 1, hi = 59000;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (admitted(mid)) lo = mid; else hi = mid - 1; }
  assert.ok(admitted(lo)); const before = locks;
  assert.equal(admitted(lo + 1), false); assert.equal(locks, before);
  assert.ok(!fs.existsSync(path.join(root, '.omo-coworkers')));
  m.state = originalState; m.files.withLock = originalLock;
  const directory = path.join(root, '.omo-coworkers'); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'manager-state.json'), JSON.stringify(seed(lo)));
  save(m, p); assert.equal(m.state().pending, null);
  const clean = fixture(t);
  // Near-limit unmanaged output is never persisted in metadata and cannot grow
  // past native file byte cap, even when Delta itself is tiny.
  fs.writeFileSync(clean.file, '{"agents":{"writer":{"model":"x"}},"unknown":"' + 'é'.repeat(2097110) + '"}');
  const q = preview(clean.m, 'v/'.repeat(100));
  let acquired = false; clean.m.files.withLock = () => { acquired = true; throw Error('unexpected'); };
  assert.throws(() => save(clean.m, q), { code: 'CAPACITY' }); assert.equal(acquired, false);
});
test('history eviction does not govern pending recovery and locks remain independent', t => {
  const { m, root, file } = fixture(t);
  for (let i = 0; i < 11; i++) save(m, preview(m, `v/${i}`));
  const p = preview(m, 'v/failed');
  m.files.withLock(() => assert.throws(() => new ConfigManager(root).commit(m.previews.get(p.previewId).delta), { code: 'LOCKED' }));
  m.files.inject = stage => { if (stage === 'state-commit') throw Error('stop'); };
  assert.throws(() => save(m, p), { code: 'RECOVERY_REQUIRED' });
  const fresh = new ConfigManager(root); fresh.now = () => Date.now() + 1000 * 86400000;
  fresh.recover({ confirm: true });
  assert.equal(fresh.history().length, 10); assert.match(fs.readFileSync(file, 'utf8'), /v\/10/);
});
test('copy user recipe is reference-only and shared undo restores deletion', t => {
  const { m } = fixture(t);
  const p = m.saveUserTemplate({ revision: m.snapshot().revision, id: 'user-copy', description: 'Copy', copyTemplateId: 'document-role', parameters: {} });
  save(m, p);
  assert.deepEqual(JSON.parse(JSON.stringify(m.userTemplates()[0])), { id: 'user-copy', description: 'Copy', baseTemplateId: 'document-role', parameters: {} });
  save(m, m.templatePreview({ revision: m.snapshot().revision, templateId: 'user-copy' }));
  const deleted = save(m, m.deleteUserTemplate({ revision: m.snapshot().revision, id: 'user-copy' }));
  assert.equal(m.userTemplates().length, 0);
  save(m, m.undoPreview({ transactionId: deleted.transactionId })); assert.equal(m.userTemplates().length, 1);
});
test('migration shared cache/expiry and source CAS, malformed format fails closed', t => {
  const { m, root } = fixture(t);
  const dir = path.join(root, '.omo-coworkers'); fs.mkdirSync(dir);
  const file = path.join(dir, 'manager-history.json');
  fs.writeFileSync(file, JSON.stringify({ format: 2, records: [], receipts: [] }));
  const make = () => m.migrationPreview({ confirmOldWriterStopped: true });
  const old = make(); for (let i = 0; i < 16; i++) make();
  assert.throws(() => save(m, old), { code: 'STALE_PREVIEW' });
  const expired = make(); m.now = () => Date.now() + 300000;
  assert.throws(() => save(m, expired), { code: 'STALE_PREVIEW' }); m.now = () => Date.now();
  const stale = make(); fs.appendFileSync(file, '\n');
  assert.throws(() => save(m, stale), { code: 'CONFLICT' });
  fs.writeFileSync(file, '{"format":2,"records":[],"receipts":[{"metadata":{"templateId":"x","unknown":true},"entries":[]}]}');
  assert.throws(() => m.migrationPreview({ confirmOldWriterStopped: true, confirmDiscardReceipts: true }), { code: 'RECOVERY_REQUIRED' });
  fs.writeFileSync(path.join(dir, 'manager-state.json'), '{"format":2}');
  assert.throws(() => m.state(), { code: 'RECOVERY_REQUIRED' });
});
test('revealed prompt diff actual text; unrevealed recipe before remains withheld', t => {
  const { m, file } = fixture(t);
  save(m, m.templatePreview({ revision: m.snapshot().revision, templateId: 'document-role' }));
  const text = fs.readFileSync(file, 'utf8');
  const data = JSON.parse(text.replace(/\/\/[^\n]*/g, ''));
  data.agents['document-writer'].description = 'Personal wording';
  fs.writeFileSync(file, JSON.stringify(data));
  let revision = m.snapshot().revision;
  const field = ['agents', 'document-writer', 'description'];
  let p = m.templatePreview({ revision, templateId: 'document-role', replace: [{ resourceId: 'config', field }] });
  let change = p.changes.find(c => JSON.stringify(c.field) === JSON.stringify(field));
  assert.equal(change.beforeExists, true); assert.equal(change.afterExists, true);
  assert.ok(!Object.hasOwn(change, 'before')); assert.ok(change.beforeHash);
  assert.equal(typeof change.after, 'string');
  revision = m.snapshot().revision;
  m.reveal({ resourceId: 'config', revision, field, confirm: true });
  p = m.preview({ revision, operations: [{ resourceId: 'config', field, action: 'set', value: 'New wording' }] });
  assert.equal(p.changes[0].before, 'Personal wording'); assert.equal(p.changes[0].after, 'New wording');
  assert.ok(!JSON.stringify(m.previews.get(p.previewId).delta).includes('revealed'));
  m.now = () => Date.now() + 300000;
  assert.throws(() => m.preview({ revision, operations: [{ resourceId: 'config', field, action: 'set', value: 'Other' }] }), { code: 'STALE_REVISION' });
});
test('inheritance recipe guards direct/preset models and inheritance, not unrelated models', t => {
  for (const field of [
    ['agents', 'document-writer', 'model'],
    ['agents', 'document-writer', 'inheritModelFrom'],
    ['presets', 'chosen', 'agents', 'document-writer', 'model'],
    ['presets', 'chosen', 'agents', 'document-writer', 'inheritModelFrom'],
  ]) {
    const { m, file, root } = fixture(t);
    fs.writeFileSync(file, '{"preset":"chosen","presets":{"chosen":{"agents":{}}},"agents":{}}');
    const p = m.templatePreview({ revision: m.snapshot().revision, templateId: 'document-role', parameters: { inheritModelFrom: 'session' } });
    const other = new ConfigManager(root);
    save(other, other.preview({ revision: other.snapshot().revision, operations: [{ resourceId: 'config', field, action: 'set', value: field.at(-1) === 'model' ? ['vendor/personal'] : 'session' }] }));
    const before = fs.readFileSync(file, 'utf8'), state = fs.readFileSync(path.join(root, '.omo-coworkers/manager-state.json'), 'utf8');
    assert.throws(() => save(m, p), { code: 'CONFLICT' });
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(fs.readFileSync(path.join(root, '.omo-coworkers/manager-state.json'), 'utf8'), state);
  }
  const { m, root } = fixture(t);
  const p = m.templatePreview({ revision: m.snapshot().revision, templateId: 'document-role', parameters: { inheritModelFrom: 'session' } });
  const other = new ConfigManager(root);
  save(other, preview(other, 'vendor/unrelated')); save(m, p);
});
test('stale history links do not block unrelated save/recovery; selected links still refuse', t => {
  const { m, root } = fixture(t);
  const dir = path.join(root, 'oh-my-opencode-slim'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(root, 'first.md'), 'First'); fs.writeFileSync(path.join(root, 'second.md'), 'Second');
  const link = path.join(dir, 'oracle_append.md'); fs.symlinkSync('../first.md', link);
  const snap = m.snapshot(), resourceId = snap.resources.find(r => r.kind === 'prompt').id;
  m.reveal({ revision: snap.revision, resourceId, confirm: true });
  const changed = save(m, m.preview({ revision: snap.revision, operations: [{ resourceId, field: [], action: 'set', value: 'Changed' }] }));
  fs.unlinkSync(link); fs.symlinkSync('../second.md', link);
  save(m, preview(m, 'v/unrelated'));
  assert.throws(() => m.undoPreview({ transactionId: changed.transactionId }), { code: 'CONFLICT' });
  const p = preview(m, 'v/pending');
  m.files.inject = s => { if (s === 'after-file') throw Error('stop'); };
  assert.throws(() => save(m, p));
  new ConfigManager(root).recover({ confirm: true });
  const fresh = new ConfigManager(root), next = fresh.snapshot();
  fresh.reveal({ revision: next.revision, resourceId, confirm: true });
  const q = fresh.preview({ revision: next.revision, operations: [{ resourceId, field: [], action: 'set', value: 'Pending prompt' }] });
  fresh.files.inject = s => { if (s === 'after-file') throw Error('stop'); };
  assert.throws(() => save(fresh, q));
  fs.unlinkSync(link); fs.symlinkSync('../first.md', link);
  assert.throws(() => new ConfigManager(root).recover({ confirm: true }), { code: 'CONFLICT' });
});
test('selected preset extends dependency conflicts; unrelated preset remains rebasable', t => {
  for (const selected of [true, false]) {
    const { m, root, file } = fixture(t);
    fs.writeFileSync(file, JSON.stringify({ preset: 'chosen', presets: { chosen: {}, other: {}, base: { agents: { 'document-writer': { model: ['vendor/personal'] } } } } }));
    const p = m.templatePreview({ revision: m.snapshot().revision, templateId: 'document-role', parameters: { inheritModelFrom: 'session' } });
    const other = new ConfigManager(root);
    save(other, other.preview({ revision: other.snapshot().revision, operations: [{ resourceId: 'config', field: ['presets', selected ? 'chosen' : 'other', 'extends'], action: 'set', value: 'base' }] }));
    const before = fs.readFileSync(file, 'utf8'), state = fs.readFileSync(path.join(root, '.omo-coworkers/manager-state.json'), 'utf8');
    if (selected) {
      assert.throws(() => save(m, p), { code: 'CONFLICT' });
      assert.equal(fs.readFileSync(file, 'utf8'), before);
      assert.equal(fs.readFileSync(path.join(root, '.omo-coworkers/manager-state.json'), 'utf8'), state);
    } else save(m, p);
  }
});
test('pre-existing extends or unresolved selector suppresses inheritance with accurate warning', t => {
  for (const declaration of ['base', '', null, 42, {}, false, undefined]) {
    const { m, file } = fixture(t);
    const config = { preset: 'chosen', presets: { base: { agents: { 'document-writer': { model: ['vendor/personal'] } } } } };
    if (declaration !== undefined) config.presets.chosen = { extends: declaration };
    fs.writeFileSync(file, JSON.stringify(config));
    const p = m.templatePreview({ revision: m.snapshot().revision, templateId: 'document-role', parameters: { inheritModelFrom: 'session' } });
    assert.ok(p.warnings.includes('PRESET_MODEL_INHERITANCE_UNRESOLVED'));
    assert.ok(!p.changes.some(c => c.field?.at(-1) === 'inheritModelFrom'));
    save(m, p);
    const output = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(output.agents['document-writer'].inheritModelFrom, undefined);
    assert.deepEqual(output.presets.base.agents['document-writer'].model, ['vendor/personal']);
  }
});
