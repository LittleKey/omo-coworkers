import test from 'node:test';
import assert from 'node:assert/strict';
import { composeTemplate, listTemplates } from '../openchamber/native-config/templates.mjs';
import { payload } from '../openchamber/native-config/generator.mjs';

test('five independent families with fresh metadata and selected prerequisites only', () => {
  assert.deepEqual(listTemplates().map(t => t.id), ['document-role', 'lark-role', 'collaboration', 'claude-acp-guidance', 'antigravity-acp-guidance']);
  for (const entry of listTemplates()) {
    const result = composeTemplate(entry.id);
    assert.equal(result.version, payload().manifest.version);
    assert.equal(result.warnings.some(w => w.code === 'MISSING_TRANSPORT'), entry.id.endsWith('-acp-guidance'));
    assert.equal(result.warnings.some(w => w.code === 'MISSING_MODEL'), entry.id.endsWith('-role'));
  }
  const first = listTemplates();
  first[2].parameters.agents.choices.push('evil');
  assert.equal(listTemplates()[2].parameters.agents.choices.includes('evil'), false);
});

test('every built-in leaf and prompt uses exact single-authority source bytes', () => {
  const data = payload();
  const changes = listTemplates().flatMap(t => composeTemplate(t.id).changes);
  for (const leaf of data.leaves) {
    const change = changes.find(c => c.kind === 'field' && JSON.stringify(c.path) === JSON.stringify(leaf.path));
    assert.equal(change.value, leaf.value);
  }
  for (const source of data.prompts) {
    const name = source.path.split('/').at(-1).replace(/\.md$/, '');
    assert.equal(changes.find(c => c.kind === 'prompt' && c.name === name).value, source.text);
  }
  assert.equal(changes.length, data.leaves.length + data.prompts.length);
});

test('collaboration selects agents independently; no ACP and no arbitrary names', () => {
  const result = composeTemplate('collaboration', { parameters: { agents: ['fixer'] } });
  assert.deepEqual(result.changes.map(c => c.name), ['fixer_append']);
  assert.deepEqual(result.warnings, []);
  for (const agents of [[], ['../x'], ['fixer', 'fixer'], 'fixer']) {
    assert.throws(() => composeTemplate('collaboration', { parameters: { agents } }), { code: 'INVALID_PARAMETERS' });
  }
});

test('personal config, prompts, transport, grants and environment never clobbered or returned', () => {
  const config = { agents: { 'document-writer': { model: 'personal', description: 'SECRET', appendPrompt: 'SECRET', permissions: { write: false } } },
    acpAgents: { claude: { command: '/personal/bin', env: { TOKEN: 'SECRET' }, wrapperModel: 'personal' } } };
  const original = JSON.stringify(config);
  const result = composeTemplate('document-role', { config, promptContents: { 'document-writer': 'SECRET' } });
  assert.equal(result.changes.find(c => c.path?.at(-1) === 'description').status, 'customized');
  assert.equal(result.changes.find(c => c.kind === 'prompt').status, 'customized');
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.equal(JSON.stringify(config), original);
  const acp = composeTemplate('claude-acp-guidance', { config });
  assert.equal(acp.warnings.length, 0);
  assert.ok(acp.changes.every(c => ['description', 'prompt', 'orchestratorPrompt'].includes(c.path.at(-1))));
});

test('logical identities retained for matching and customized lifecycle comparisons', () => {
  const first = composeTemplate('document-role');
  const config = { agents: { 'document-writer': { model: 'mine' } } };
  for (const c of first.changes.filter(c => c.kind === 'field')) config.agents['document-writer'][c.path.at(-1)] = c.value;
  const text = first.changes.find(c => c.kind === 'prompt').value;
  const second = composeTemplate('document-role', { config, promptContents: { 'document-writer': text } });
  assert.equal(second.changes.length, first.changes.length);
  assert.ok(second.changes.every(c => c.status === 'matching'));
  assert.deepEqual(second.warnings, []);
  assert.equal(composeTemplate('document-role', { config: { agents: false } }).changes[0].status, 'customized');
});

test('model inheritance follows native enum without fictitious agents and preserves personal choices', () => {
  for (const id of ['document-role', 'lark-role']) {
    assert.deepEqual(listTemplates().find(t => t.id === id).parameters.inheritModelFrom.choices, ['session', 'orchestrator']);
    for (const inheritModelFrom of ['session', 'orchestrator']) {
      const parameters = { inheritModelFrom };
      const result = composeTemplate(id, { config: {}, parameters });
      assert.equal(result.changes.find(c => c.path?.at(-1) === 'inheritModelFrom').value, inheritModelFrom);
      assert.ok(!result.warnings.some(w => w.code === 'MISSING_MODEL'));
      const name = id === 'document-role' ? 'document-writer' : 'lark-operator';
      for (const personal of [{ model: 'personal' }, { inheritModelFrom: 'session' }, { model: '' }]) {
        const config = { agents: { [name]: personal } };
        const original = JSON.stringify(config);
        assert.ok(!composeTemplate(id, { config, parameters }).changes.some(c => c.path?.at(-1) === 'inheritModelFrom'));
        assert.equal(JSON.stringify(config), original);
      }
    }
    assert.throws(() => composeTemplate(id, {
      config: { agents: { fixer: { model: 'mine' } } },
      parameters: { inheritModelFrom: 'fixer' },
    }), { code: 'INVALID_PARAMETERS' });
  }
  const preset = { preset: 'mine', presets: { mine: { agents: { 'document-writer': { model: 'personal' } } } } };
  assert.ok(!composeTemplate('document-role', { config: preset }).warnings.some(w => w.code === 'MISSING_MODEL'));
});

test('parent presets conservatively suppress only inheritance mutations without resolving native chains', () => {
  for (const id of ['document-role', 'lark-role']) {
    const name = id === 'document-role' ? 'document-writer' : 'lark-operator';
    for (const model of ['personal/model', ['personal/primary', 'personal/fallback']]) {
      for (const nested of [true, false]) {
        for (const extendsValue of ['base', 'missing-parent', '', null, false, [], {}]) {
          const parentAgent = { [name]: { model } };
          const config = { preset: 'chosen', presets: {
            chosen: { extends: extendsValue },
            base: nested ? { agents: parentAgent } : parentAgent,
          } };
          const original = JSON.stringify(config);
          for (const inheritModelFrom of ['session', 'orchestrator']) {
            const result = composeTemplate(id, { config, parameters: { inheritModelFrom } });
            assert.ok(!result.changes.some(c => c.path?.at(-1) === 'inheritModelFrom'));
            assert.ok(result.warnings.some(w => w.code === 'PRESET_MODEL_INHERITANCE_UNRESOLVED'));
            assert.ok(result.changes.some(c => c.path?.at(-1) === 'description'));
            assert.ok(result.changes.some(c => c.kind === 'prompt'));
            assert.equal(JSON.stringify(config), original);
          }
        }
      }
    }
    // No extends declaration remains eligible; direct and both preset shapes
    // still preserve personal model values, including arrays.
    const plain = { preset: 'chosen', presets: { chosen: {} } };
    assert.ok(composeTemplate(id, { config: plain, parameters: { inheritModelFrom: 'session' } })
      .changes.some(c => c.path?.at(-1) === 'inheritModelFrom'));
    for (const nested of [true, false]) {
      const agent = { [name]: { model: ['personal/model'] } };
      const config = { preset: 'chosen', presets: { chosen: nested ? { agents: agent } : agent } };
      assert.ok(!composeTemplate(id, { config, parameters: { inheritModelFrom: 'session' } })
        .changes.some(c => c.path?.at(-1) === 'inheritModelFrom'));
    }
    for (const config of [{ preset: 'missing' }, { preset: '', presets: {} }, { preset: 'bad', presets: { bad: null } }]) {
      const result = composeTemplate(id, { config, parameters: { inheritModelFrom: 'session' } });
      assert.ok(!result.changes.some(c => c.path?.at(-1) === 'inheritModelFrom'));
      assert.ok(result.warnings.some(w => w.code === 'PRESET_MODEL_INHERITANCE_UNRESOLVED'));
    }
  }
});

test('finite inputs reject unsafe config and unsupported parameters without reflecting text', () => {
  assert.throws(() => composeTemplate('unknown'), { code: 'UNKNOWN_TEMPLATE' });
  for (const config of ['[]', '{"__proto__":{}}', '{"agents":1,"agents":2}', null]) {
    assert.throws(() => composeTemplate('document-role', { config }), { code: 'INVALID_CONFIG' });
  }
  assert.throws(() => composeTemplate('claude-acp-guidance', { parameters: { command: 'SECRET' } }), { code: 'INVALID_PARAMETERS' });
});
