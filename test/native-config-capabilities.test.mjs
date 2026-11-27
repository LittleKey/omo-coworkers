import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ConfigManager } from '../openchamber/native-config/manager.mjs';
import { createService } from '../openchamber/service/main.mjs';
const base = path.resolve('.opencode/work/validation');
function fixture(t, object = {}) {
  const root = fs.mkdtempSync(path.join(base, 'capability-'));
  const file = path.join(root, 'oh-my-opencode-slim.jsonc');
  fs.writeFileSync(file, JSON.stringify(object));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, file, m: new ConfigManager(root) };
}
const intent = (m, value) => m.intentPreview({ revision: m.capabilitySnapshot().revision, intent: value });
const save = (m, p) => m.save({ previewId: p.previewId, confirmRisk: true });
const role = values => ({ kind: 'role-settings', capabilityId: 'document-role', ...values });
test('flat/nested model sources, inherited variant reset and complex chains readonly', t => {
  for (const nested of [true, false]) {
    const selected = nested ? { agents: { 'document-writer': { model: 'v/old', variant: 'unknown' } } } : { 'document-writer': { model: 'v/old', variant: 'unknown' } };
    const { m, file } = fixture(t, { preset: 'chosen', presets: { chosen: selected } });
    let snapshot = m.capabilitySnapshot(), settings = snapshot.capabilities[0].settings;
    assert.ok(settings.model.source.includes(nested ? '.agents.' : '.chosen.document-writer.'));
    save(m, intent(m, role({ model: 'v/new', variant: null })));
    const object = JSON.parse(fs.readFileSync(file));
    const agent = nested ? object.presets.chosen.agents['document-writer'] : object.presets.chosen['document-writer'];
    assert.equal(agent.model, 'v/new'); assert.equal(agent.variant, undefined);
    assert.equal(object.agents, undefined);
  }
  for (const object of [
    { agents: { 'document-writer': { model: ['v/chain'] } } },
    { agents: { 'document-writer': { inheritModelFrom: 'session' } } },
    { preset: 'chosen', presets: { chosen: { extends: 'base' } } },
  ]) {
    const { m, file } = fixture(t, object), before = fs.readFileSync(file, 'utf8');
    assert.equal(m.capabilitySnapshot().capabilities[0].settings.model.editable, false);
    assert.throws(() => intent(m, role({ model: 'v/new', variant: null })), { code: 'READ_ONLY' });
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
});
test('default observer plus concurrent other memberships rebase and conditional undo', t => {
  const { m, root, file } = fixture(t);
  const p = intent(m, role({ enabled: false }));
  assert.equal(p.changes[0].before, false); assert.equal(p.changes[0].after, true);
  assert.equal(p.changes[0].beforeExists, true); assert.equal(p.changes[0].afterExists, true);
  fs.writeFileSync(file, '{"disabled_agents":["observer","oracle"]}');
  const saved = save(m, p);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).disabled_agents, ['observer', 'oracle', 'document-writer']);
  fs.writeFileSync(file, '{"disabled_agents":["observer","oracle","document-writer","fixer"]}');
  save(m, m.undoPreview({ transactionId: saved.transactionId }));
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).disabled_agents, ['observer', 'oracle', 'fixer']);
  const fresh = fixture(t);
  save(fresh.m, intent(fresh.m, role({ enabled: false })));
  assert.deepEqual(JSON.parse(fs.readFileSync(fresh.file)).disabled_agents, ['observer', 'document-writer']);
});
test('source discriminator conflicts on flat-to-nested change but permits unrelated descriptions', t => {
  for (const change of ['same-role', 'other-role', 'flat-description', 'root-switch', 'preset-switch']) {
    const { m, file, root } = fixture(t, { preset: 'chosen', presets: { chosen: { 'document-writer': { model: 'v/flat' } }, other: {} } });
    const p = intent(m, role({ model: 'v/new', variant: null }));
    const object = JSON.parse(fs.readFileSync(file));
    if (change === 'same-role') object.presets.chosen.agents = { 'document-writer': { description: 'New nested description' } };
    if (change === 'other-role') object.presets.chosen.agents = { 'lark-operator': { description: 'Other description' } };
    if (change === 'flat-description') object.presets.chosen['document-writer'].description = 'Same source extra description';
    if (change === 'root-switch') object.agents = { 'document-writer': { model: 'v/direct' } };
    if (change === 'preset-switch') object.preset = 'other';
    fs.writeFileSync(file, JSON.stringify(object));
    const before = fs.readFileSync(file, 'utf8');
    if (['same-role', 'root-switch', 'preset-switch'].includes(change)) {
      assert.throws(() => save(m, p), { code: 'CONFLICT' });
      assert.equal(fs.readFileSync(file, 'utf8'), before);
      assert.equal(fs.existsSync(path.join(root, '.omo-coworkers')), false);
    } else {
      save(m, p);
      assert.equal(m.capabilitySnapshot().capabilities[0].settings.model.value, 'v/new');
      assert.ok(fs.readFileSync(file, 'utf8').includes('description'));
    }
  }
});
test('model saves do not touch content/dependencies, adoption explicit inline confirmation', t => {
  const { m, file } = fixture(t, { agents: { 'document-writer': { model: 'v/old', prompt: 'PERSONAL', skills: ['personal'] } }, acpAgents: { claude: { env: { TOKEN: 'PRIVATE' } } } });
  save(m, intent(m, role({ model: 'v/new', variant: null })));
  let object = JSON.parse(fs.readFileSync(file)); assert.equal(object.agents['document-writer'].prompt, 'PERSONAL'); assert.deepEqual(object.agents['document-writer'].skills, ['personal']);
  assert.equal(m.capabilitySnapshot().capabilities[0].contentStatus, 'different', 'known inline is consentable, not UI-blocked');
  assert.throws(() => intent(m, { kind: 'adopt-content', capabilityId: 'document-role' }), { code: 'INLINE_CONFIRMATION_REQUIRED' });
  save(m, intent(m, { kind: 'adopt-content', capabilityId: 'document-role', confirmInlineReplacement: true }));
  object = JSON.parse(fs.readFileSync(file));
  assert.equal(object.agents['document-writer'].prompt, undefined);
  assert.equal(object.agents['document-writer'].model, 'v/new');
  assert.deepEqual(object.agents['document-writer'].skills, ['personal']); assert.equal(object.acpAgents.claude.env.TOKEN, 'PRIVATE');
  assert.throws(() => intent(m, { kind: 'adopt-content', capabilityId: 'document-role' }), { code: 'NO_CHANGES' });
  const snapshot = m.capabilitySnapshot(); assert.ok(!JSON.stringify(snapshot).includes('PRIVATE'));
  assert.ok(!JSON.stringify(snapshot).includes('orchestratorPrompt'));
  assert.equal(snapshot.capabilities.find(c => c.id === 'lark-role').dependencies.readiness, 'unknown');
});
test('API3 retains old user-template undo and conditional pending recovery', async t => {
  const { m, root } = fixture(t, { agents: { 'document-writer': { model: 'v/old' } } });
  const snapshot = m.snapshot();
  const created = save(m, m.saveUserTemplate({ revision: snapshot.revision, id: 'user-old', description: 'Legacy definition', selection: [{ resourceId: 'config', field: ['agents', 'document-writer', 'model'] }] }));
  const token = 'z'.repeat(32), server = createService({ root, token, manager: m, catalog: { get: async () => ({ catalog: [], variants: {} }) } });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  const request = async (route, body, method = 'POST') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  let result = await request('/undo-preview', { transactionId: created.transactionId });
  assert.equal(result.status, 200);
  assert.equal((await request('/config', { previewId: result.data.previewId, confirmRisk: true }, 'PATCH')).status, 200);
  assert.equal(m.userTemplates().length, 0);
  const p = intent(m, role({ model: 'v/new', variant: null }));
  m.files.inject = s => { if (s === 'after-file') throw Error('interrupted'); };
  assert.throws(() => save(m, p)); m.files.inject = () => {};
  result = await request('/recover', { confirm: true }); assert.equal(result.status, 200);
  assert.equal(m.capabilitySnapshot().capabilities[0].settings.model.value, 'v/old');
});
test('API3 finite routes retire arbitrary editor and models wrapper is injected readonly', async t => {
  const { m, root, file } = fixture(t), before = fs.readFileSync(file, 'utf8');
  const calls = [], token = 'a'.repeat(32), server = createService({ root, token, manager: m, catalog: { get: async options => { calls.push(options); return { catalog: ['v/model'], variants: {}, provenance: 'unverified' }; } } });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  const request = (url, method = 'GET', body, auth = true) => fetch(`http://127.0.0.1:${server.address().port}${url}`, { method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await request('/health', 'GET', null, false)).status, 401);
  assert.equal((await (await request('/health')).json()).apiVersion, 3);
  for (const url of ['/preview', '/reveal', '/template-preview', '/user-templates']) assert.equal((await request(url, 'POST', {})).status, 410);
  const snapshot = await (await request('/snapshot')).json(); assert.ok(snapshot.capabilities); assert.equal(snapshot.resources, undefined);
  const models = await (await request('/models?refresh=true')).json(); assert.equal(models.ok, true); assert.equal(models.provenance, 'unverified'); assert.deepEqual(calls, [{ refresh: true }]);
  assert.equal((await request('/models?refresh=false')).status, 400);
  assert.equal((await request('/models?refresh=true&refresh=true')).status, 400);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});
test('variant deletion exposes inherited value without overwriting inherited model', t => {
  const { m, file } = fixture(t, { preset: 'chosen', presets: { chosen: { agents: { 'document-writer': { model: 'v/inherited', variant: 'preset-value' } } } }, agents: { 'document-writer': { variant: 'direct-value' } } });
  assert.equal(m.capabilitySnapshot().capabilities[0].settings.variant.inheritedValue, 'preset-value');
  save(m, intent(m, role({ variant: null })));
  assert.equal(m.capabilitySnapshot().capabilities[0].settings.variant.value, 'preset-value');
  assert.equal(JSON.parse(fs.readFileSync(file)).presets.chosen.agents['document-writer'].model, 'v/inherited');
});
test('preset inline override explicit adoption and concurrent inline introduction conflict', t => {
  const { m, file } = fixture(t, { preset: 'chosen', presets: { chosen: { 'document-writer': { appendPrompt: 'Personal inline' } } } });
  assert.throws(() => intent(m, { kind: 'adopt-content', capabilityId: 'document-role' }), { code: 'INLINE_CONFIRMATION_REQUIRED' });
  save(m, intent(m, { kind: 'adopt-content', capabilityId: 'document-role', confirmInlineReplacement: true }));
  assert.equal(JSON.parse(fs.readFileSync(file)).presets.chosen['document-writer'].appendPrompt, undefined);
  const fresh = fixture(t), p = intent(fresh.m, { kind: 'adopt-content', capabilityId: 'document-role' });
  fs.writeFileSync(fresh.file, '{"agents":{"document-writer":{"prompt":"added after preview"}}}');
  assert.throws(() => save(fresh.m, p), { code: 'CONFLICT' });
});
test('public source projection sanitizes inherited protected values and unresolved branches', t => {
  const { m } = fixture(t, { preset: 'chosen', presets: { chosen: { agents: { 'document-writer': { model: '{env:PERSONAL_MODEL}' } } } }, agents: { 'document-writer': { model: 'vendor/direct' } } });
  const projection = m.capabilitySnapshot(), model = projection.capabilities[0].settings.model;
  assert.equal(model.value, 'vendor/direct'); assert.equal(model.inheritedValue, null);
  assert.ok(!JSON.stringify(projection).includes('PERSONAL_MODEL'));
  for (const value of [['vendor/chain'], { private: 'personal-object' }, '{env:DIRECT_MODEL}']) {
    const sample = fixture(t, { preset: 'missing', agents: { 'document-writer': { model: value } } });
    const output = sample.m.capabilitySnapshot();
    assert.equal(output.capabilities[0].settings.model.value, null);
    assert.ok(!JSON.stringify(output).includes('personal-object'));
    assert.ok(!JSON.stringify(output).includes('DIRECT_MODEL'));
  }
});
test('content adoption never synthesizes inheritance and rebases concurrent model arrays', t => {
  const { m, file } = fixture(t);
  const p = intent(m, { kind: 'adopt-content', capabilityId: 'document-role' });
  assert.ok(!p.changes.some(c => c.field?.at(-1) === 'inheritModelFrom'));
  fs.writeFileSync(file, '{"agents":{"document-writer":{"model":["vendor/personal"]},"lark-operator":{"model":"vendor/unrelated"}}}');
  save(m, p);
  const object = JSON.parse(fs.readFileSync(file));
  assert.deepEqual(object.agents['document-writer'].model, ['vendor/personal']);
  assert.equal(object.agents['document-writer'].inheritModelFrom, undefined);
  assert.equal(object.agents['lark-operator'].model, 'vendor/unrelated');
});
