import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ConfigManager } from '../openchamber/native-config/manager.mjs';
const keys = ['CLAUDE_CODE_DISABLE_CLAUDE_MDS', 'CLAUDE_CODE_DISABLE_BUNDLED_SKILLS', 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS'];
function fixture(t, env) {
  const root = fs.mkdtempSync(path.resolve('.opencode/work/validation/v71-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'oh-my-opencode-slim.jsonc');
  fs.writeFileSync(file, JSON.stringify({ acpAgents: { claude: { command: 'fixture', ...(env === undefined ? {} : { env }) } } }));
  return { root, file, m: new ConfigManager(root) };
}
const preview = (m, behaviorEnv, agentId = 'claude') => m.intentPreview({ revision: m.capabilitySnapshot().revision, intent: { kind: 'acp-settings', agentId, behaviorEnv } });
const save = (m, p) => m.save({ previewId: p.previewId, confirmRisk: true });
test('three exact env controls use explicit risk, inheritance and selected-leaf history only', t => {
  const { m, root, file } = fixture(t, { TOKEN: 'fixture-only-secret' });
  const body = Object.fromEntries(keys.map(k => [k, '1']));
  let p = preview(m, body);
  assert.ok(p.changes.every(c => c.risk === 'behavior-change'));
  assert.throws(() => m.save({ previewId: p.previewId }), { code: 'CONFIRMATION_REQUIRED' });
  const saved = save(m, preview(m, body));
  let value = JSON.parse(fs.readFileSync(file)).acpAgents.claude.env;
  assert.equal(value.TOKEN, 'fixture-only-secret'); for (const k of keys) assert.equal(value[k], '1');
  const controls = m.capabilitySnapshot().acpAgents.find(a => a.id === 'claude').env;
  for (const key of keys) assert.equal(controls.find(c => c.key === key).value, '1');
  const state = fs.readFileSync(path.join(root, '.omo-coworkers/manager-state.json'), 'utf8');
  assert.ok(!state.includes('fixture-only-secret')); assert.ok(!state.includes('"TOKEN"'));
  const fresh = new ConfigManager(root); save(fresh, fresh.undoPreview({ transactionId: saved.transactionId }));
  value = JSON.parse(fs.readFileSync(file)).acpAgents.claude.env;
  for (const k of keys) assert.equal(value[k], undefined);
  assert.equal(value.TOKEN, 'fixture-only-secret');
  save(m, preview(m, Object.fromEntries(keys.map(k => [k, '0']))));
  save(m, preview(m, Object.fromEntries(keys.map(k => [k, null]))));
  const absent = m.capabilitySnapshot().acpAgents.find(a => a.id === 'claude').env.find(e => e.key === keys[0]);
  assert.equal(absent.present, false); assert.equal(absent.value, null); assert.match(absent.reason, /inherited/);
});
test('noncanonical values and dynamic/unknown keys never returned or overwritten', t => {
  for (const value of ['true', 'yes', 'fixture-only-secret']) {
    const { m } = fixture(t, { [keys[0]]: value, ANTHROPIC_MODEL: 'private-model', CLAUDE_CODE_EFFORT_LEVEL: 'private-effort' });
    const controls = m.capabilitySnapshot().acpAgents.find(a => a.id === 'claude').env;
    const c = controls.find(e => e.key === keys[0]); assert.equal(c.value, null); assert.equal(c.editable, false);
    for (const v of ['1', null]) assert.throws(() => preview(m, { [keys[0]]: v }), { code: 'PROTECTED_FIELD' });
    assert.ok(!JSON.stringify(controls).includes('private-model')); assert.ok(!JSON.stringify(controls).includes('private-effort'));
  }
  const { m } = fixture(t);
  for (const body of [{ TOKEN: '1' }, { ANTHROPIC_MODEL: '1' }, { CLAUDE_CODE_EFFORT_LEVEL: '1' }, { [keys[0]]: 'yes' }]) assert.throws(() => preview(m, body), { code: 'PROTECTED_FIELD' });
  assert.throws(() => preview(m, { [keys[0]]: '1' }, 'antigravity'), { code: 'PROTECTED_FIELD' });
});
test('env CAS rebases unrelated secrets, conflicts same key, pending recovery restores only selected leaf', t => {
  const { m, file, root } = fixture(t);
  let p = preview(m, { [keys[0]]: '1' });
  let object = JSON.parse(fs.readFileSync(file)); object.acpAgents.claude.env = { TOKEN: 'concurrent-fixture-secret' };
  fs.writeFileSync(file, JSON.stringify(object)); save(m, p);
  p = preview(m, { [keys[0]]: '0' });
  object = JSON.parse(fs.readFileSync(file)); object.acpAgents.claude.env[keys[0]] = '0';
  fs.writeFileSync(file, JSON.stringify(object)); assert.throws(() => save(m, p), { code: 'CONFLICT' });
  p = preview(m, { [keys[1]]: '1' });
  m.files.inject = event => { if (event === 'after-file') throw Error('fixture interruption'); };
  assert.throws(() => save(m, p), { code: 'RECOVERY_REQUIRED' });
  const fresh = new ConfigManager(root); fresh.recover({ confirm: true });
  object = JSON.parse(fs.readFileSync(file));
  assert.equal(object.acpAgents.claude.env[keys[1]], undefined); assert.equal(object.acpAgents.claude.env.TOKEN, 'concurrent-fixture-secret');
  assert.equal(object.acpAgents.claude.env[keys[0]], '0');
});
