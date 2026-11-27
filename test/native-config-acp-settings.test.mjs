import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ConfigManager } from '../openchamber/native-config/manager.mjs';
const base = path.resolve('.opencode/work/validation');
function fixture(t, object = {}, options = {}) {
  const root = fs.mkdtempSync(path.join(base, 'acp-settings-'));
  const file = path.join(root, 'oh-my-opencode-slim.jsonc');
  fs.writeFileSync(file, JSON.stringify(object));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, file, m: new ConfigManager(root, options) };
}
const preview = (m, intent) => m.intentPreview({ revision: m.capabilitySnapshot().revision, intent });
const settings = values => ({ kind: 'acp-settings', agentId: 'claude', ...values });
const create = values => ({ kind: 'acp-create', agentId: 'claude', ...values });
const save = (m, p) => m.save({ previewId: p.previewId, confirmRisk: true });
test('public create, independent decoder undo, third-value whole entry is not deleted', t => {
  const { m, root, file } = fixture(t);
  const p = preview(m, create({}));
  assert.throws(() => m.save({ previewId: p.previewId }), { code: 'CONFIRMATION_REQUIRED' });
  const saved = save(m, preview(m, create({})));
  const value = JSON.parse(fs.readFileSync(file)).acpAgents.claude;
  assert.equal(value.command, 'claude-agent-acp'); assert.equal(value.permissionMode, 'ask');
  assert.equal(value.timeoutMs, 0); assert.deepEqual(value.args, []); assert.ok(value.prompt);
  const fresh = new ConfigManager(root);
  const undo = fresh.undoPreview({ transactionId: saved.transactionId });
  const object = JSON.parse(fs.readFileSync(file)); object.acpAgents.claude.env = { TOKEN: 'fixture-only-secret' };
  fs.writeFileSync(file, JSON.stringify(object));
  assert.throws(() => save(fresh, undo), { code: 'CONFLICT' });
  delete object.acpAgents.claude.env; fs.writeFileSync(file, JSON.stringify(object));
  save(fresh, fresh.undoPreview({ transactionId: saved.transactionId }));
  assert.equal(JSON.parse(fs.readFileSync(file)).acpAgents.claude, undefined);
});
test('existing leaf CAS preserves credentials, unknown siblings, zero, empty and live ask', t => {
  const { m, file, root } = fixture(t, { acpAgents: {
    claude: { command: 'mine', args: [], timeoutMs: 0, permissionMode: 'ask', env: { TOKEN: 'fixture-only-secret' } },
    other: { command: 'other' },
  } });
  assert.throws(() => preview(m, create({ settings: { command: 'ignored', permissionMode: 'reject', timeoutMs: 50 } })), { code: 'NO_CHANGES' });
  const value = JSON.parse(fs.readFileSync(file)).acpAgents.claude;
  assert.equal(value.command, 'mine'); assert.equal(value.permissionMode, 'ask'); assert.equal(value.timeoutMs, 0); assert.deepEqual(value.args, []);
  assert.equal(fs.existsSync(path.join(root, '.omo-coworkers/manager-state.json')), false);
});
test('settings field rebases unrelated native env without full entry persistence', t => {
  const { m, file, root } = fixture(t, { acpAgents: { claude: { command: 'mine', env: { TOKEN: 'fixture-only-secret' } } } });
  const p = preview(m, settings({ settings: { timeoutMs: 44 }, enabled: false }));
  const object = JSON.parse(fs.readFileSync(file)); object.acpAgents.claude.env.NEW = 'second-fixture-secret'; object.acpAgents.other = { command: 'other' };
  fs.writeFileSync(file, JSON.stringify(object));
  save(m, p);
  const after = JSON.parse(fs.readFileSync(file)); assert.equal(after.acpAgents.claude.timeoutMs, 44);
  assert.equal(after.acpAgents.claude.env.NEW, 'second-fixture-secret'); assert.deepEqual(after.disabled_agents, ['observer', 'claude']);
  const state = fs.readFileSync(path.join(root, '.omo-coworkers/manager-state.json'), 'utf8');
  assert.ok(!state.includes('fixture-secret')); assert.ok(!state.includes('fixture-only-secret'));
  const q = preview(m, settings({ settings: { timeoutMs: 55 } }));
  after.acpAgents.claude.timeoutMs = 66; fs.writeFileSync(file, JSON.stringify(after));
  assert.throws(() => save(m, q), { code: 'CONFLICT' });
});
test('shape-only guards permit newly added env and unrelated ACP parent entries', t => {
  const { m, file } = fixture(t, { acpAgents: { claude: { command: 'mine' } } });
  const p = preview(m, settings({ settings: { timeoutMs: 22 } }));
  const object = JSON.parse(fs.readFileSync(file)); object.acpAgents.claude.env = { TOKEN: 'new-fixture-secret' };
  fs.writeFileSync(file, JSON.stringify(object)); save(m, p);
  assert.equal(JSON.parse(fs.readFileSync(file)).acpAgents.claude.env.TOKEN, 'new-fixture-secret');
  const other = fixture(t), q = preview(other.m, create({}));
  fs.writeFileSync(other.file, '{"acpAgents":{"other":{"command":"other"}}}');
  save(other.m, q); assert.equal(JSON.parse(fs.readFileSync(other.file)).acpAgents.other.command, 'other');
});
test('all ordinary native settings roundtrip, comments retained and guidance unchanged', t => {
  const { m, file } = fixture(t);
  fs.writeFileSync(file, '{/*keep*/"acpAgents":{"claude":{"command":"mine","description":"personal","prompt":"personal","orchestratorPrompt":"personal"}}}');
  const p = preview(m, settings({ settings: { command: 'next', args: ['acp'], cwd: 'relative', wrapperModel: 'provider/model', timeoutMs: 2147483647, permissionMode: 'allow' } }));
  save(m, p);
  let text = fs.readFileSync(file, 'utf8'); assert.ok(text.includes('/*keep*/'));
  let value = JSON.parse(text.replace('/*keep*/', '')).acpAgents.claude;
  assert.equal(value.command, 'next'); assert.deepEqual(value.args, ['acp']); assert.equal(value.cwd, 'relative');
  assert.equal(value.wrapperModel, 'provider/model'); assert.equal(value.timeoutMs, 2147483647); assert.equal(value.permissionMode, 'allow');
  assert.equal(value.prompt, 'personal'); assert.equal(value.description, 'personal'); assert.equal(value.orchestratorPrompt, 'personal');
  save(m, preview(m, settings({ settings: { cwd: null, wrapperModel: null, args: [], timeoutMs: 0, permissionMode: 'ask' } })));
  text = fs.readFileSync(file, 'utf8'); value = JSON.parse(text.replace('/*keep*/', '')).acpAgents.claude;
  assert.equal(value.cwd, undefined); assert.equal(value.wrapperModel, undefined); assert.equal(value.timeoutMs, 0);
});
test('full target schema is revalidated after unrelated rebase before pending publication', t => {
  const { m, file, root } = fixture(t, { acpAgents: { claude: { command: 'mine' } } });
  const p = preview(m, settings({ settings: { timeoutMs: 22 } }));
  fs.writeFileSync(file, '{"acpAgents":{"claude":{"command":"mine","unknown":true}}}');
  assert.throws(() => save(m, p), { code: 'INVALID_CONFIG' });
  assert.equal(fs.existsSync(path.join(root, '.omo-coworkers/manager-state.json')), false);
});
test('missing transport guidance, malformed parents and final strict schema refuse prewrite', t => {
  for (const object of [
    {}, { acpAgents: [] }, { acpAgents: { claude: false } },
    { acpAgents: { claude: { command: 'mine', unknown: true } } },
    { acpAgents: { claude: { command: 'mine', prompt: 'bad {env:SECRET}' } } },
  ]) {
    const { m, file, root } = fixture(t, object), before = fs.readFileSync(file, 'utf8');
    assert.throws(() => preview(m, { kind: 'adopt-content', capabilityId: 'claude-acp-guidance', confirmInlineReplacement: true }));
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(fs.existsSync(path.join(root, '.omo-coworkers/manager-state.json')), false);
  }
  for (const settingsValue of [{ timeoutMs: 2147483648 }, { permissionMode: 'deny' }, { wrapperModel: 'not-a-model' }, { command: '' }, { env: {} }]) {
    const { m } = fixture(t); assert.throws(() => preview(m, create({ settings: settingsValue })));
  }
});
test('public view treats every native field, readonly env and absent semantics', t => {
  const { m } = fixture(t, { acpAgents: { claude: { command: 'mine', timeoutMs: 0, args: [], permissionMode: 'ask', env: { TOKEN: 'fixture-only-secret', ANTHROPIC_MODEL: 'private' } } } });
  const s = m.capabilitySnapshot(), view = s.acpAgents.find(a => a.id === 'claude');
  assert.equal(view.settings.timeoutMs.value, 0); assert.deepEqual(view.settings.args.value, []);
  assert.equal(view.settings.cwd.present, false); assert.equal(view.settings.permissionMode.value, 'ask');
  assert.ok(view.env.every(e => e.value === null)); assert.equal(view.env.filter(e => e.editable).length, 3); assert.ok(!JSON.stringify(s).includes('fixture-only-secret'));
});
test('malformed ACP parents and membership remain inspectable without fabricated enabled state', t => {
  for (const invalid of [null, {}, 3, ['observer', 4]]) {
    const { m } = fixture(t, { disabled_agents: invalid });
    const view = m.capabilitySnapshot().acpAgents[0];
    assert.equal(view.enabled, null); assert.equal(view.membershipEditable, false);
    assert.throws(() => preview(m, settings({ enabled: false })));
  }
  for (const invalid of [null, [], 3, 'invalid']) {
    const { m } = fixture(t, { acpAgents: invalid });
    assert.equal(m.capabilitySnapshot().acpAgents[0].editable, false);
    assert.throws(() => preview(m, create({})));
    const nested = fixture(t, { acpAgents: { claude: { command: 'mine', env: invalid } } });
    assert.equal(nested.m.capabilitySnapshot().acpAgents.find(v => v.id === 'claude').editable, false);
    assert.throws(() => preview(nested.m, settings({ settings: { timeoutMs: 4 } })));
  }
  const { m } = fixture(t); assert.throws(() => preview(m, create({ settings: { command: null } })));
});
test('ACP pending create recovers in a fresh manager and refuses externally extended entry', t => {
  for (const thirdValue of [false, true]) {
    let armed = false;
    const { m, root, file } = fixture(t, {}, { inject(stage) { if (armed && stage === 'after-file') throw Error('fixture interruption'); } });
    const p = preview(m, create({})); armed = true;
    assert.throws(() => save(m, p), { code: 'RECOVERY_REQUIRED' });
    const fresh = new ConfigManager(root);
    if (thirdValue) {
      const object = JSON.parse(fs.readFileSync(file)); object.acpAgents.claude.env = { TOKEN: 'added-fixture-secret' };
      fs.writeFileSync(file, JSON.stringify(object));
      assert.throws(() => fresh.recover({ confirm: true }), { code: 'CONFLICT' });
      assert.equal(JSON.parse(fs.readFileSync(file)).acpAgents.claude.env.TOKEN, 'added-fixture-secret');
    } else {
      fresh.recover({ confirm: true });
      assert.equal(JSON.parse(fs.readFileSync(file)).acpAgents.claude, undefined);
      assert.equal(fresh.state().pending, null);
    }
  }
});
test('actual installed OMO3.0.8 loader accepts public profiles and matches strict ACP rejection', t => {
  const installed = process.env.OMO_SLIM_PACKAGE_ROOT;
  if (!installed) return t.skip('OMO_SLIM_PACKAGE_ROOT must explicitly select installed 3.0.8');
  assert.equal(JSON.parse(fs.readFileSync(path.join(installed, 'package.json'))).version, '3.0.8');
  const { m, root, file } = fixture(t);
  save(m, preview(m, create({})));
  save(m, preview(m, { kind: 'acp-create', agentId: 'antigravity' }));
  save(m, preview(m, settings({ behaviorEnv: { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '0', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' } })));
  const script = `
    import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict'; import {pathToFileURL} from 'node:url';
    const native=await import(pathToFileURL(${JSON.stringify(path.join(installed, 'dist/chunks/plugin-3x21gfn2.js'))}));
    const file=${JSON.stringify(file)}, original=JSON.parse(fs.readFileSync(file,'utf8'));
    const loaded=native.loadPluginConfigFromPath(file);
    assert.equal(loaded.acpAgents.claude.command,'claude-agent-acp');
    assert.equal(loaded.acpAgents.antigravity.command,'agy');
    assert.equal(loaded.acpAgents.claude.timeoutMs,0);
    assert.equal(loaded.acpAgents.claude.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS,'1');
    assert.equal(loaded.acpAgents.claude.env.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS,'0');
    assert.equal(loaded.acpAgents.claude.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS,'1');
    for(const entry of [{command:'x'}, {command:'x',args:[],env:{FLAG:'1'},cwd:'session',wrapperModel:'p/m',timeoutMs:2147483647,permissionMode:'ask'}]){
      fs.writeFileSync(file,JSON.stringify({acpAgents:{test:entry}})); assert.ok(native.loadPluginConfigFromPath(file));
    }
    for(const entry of [{}, {command:''},{command:'x',unknown:true},{command:'x',prompt:''},{command:'x',wrapperModel:'invalid'},{command:'x',timeoutMs:2147483648},{command:'x',permissionMode:'deny'}]){
      fs.writeFileSync(file,JSON.stringify({acpAgents:{test:entry}})); assert.equal(native.loadPluginConfigFromPath(file),null);
    }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root, env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root, XDG_DATA_HOME: root, XDG_STATE_HOME: root, TMPDIR: root, OPENCODE_CONFIG_DIR: root, OMO_DISABLE_POSTHOG: '1' }, encoding: 'utf8', timeout: 10000,
  });
  fs.writeFileSync(path.join(base, 'v7-acp-native-loader.log'), result.stdout + result.stderr);
  assert.equal(result.status, 0, result.stderr);
});
