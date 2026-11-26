import test from 'node:test';
import assert from 'node:assert/strict';
import { generate, parse, payload } from '../openchamber/native-config/generator.mjs';
const config = `{
 // retained
 "secret": "{env:PRIVATE}",
 "agents": {"document-writer":{"model":"personal/writer"},"lark-operator":{"model":"personal/operator"}},
 "acpAgents":{"antigravity":{"command":"fake","permissionMode":"ask"},"claude":{"command":"fake"}}
}\n`;
test('deterministic native generation preserves personal fields, comments and ask', () => {
  const first = generate({ config });
  assert.deepEqual(first, generate({ config }));
  assert.match(first.config, /\/\/ retained/);
  assert.match(first.config, /"\{env:PRIVATE\}"/);
  assert.equal(parse(first.config).acpAgents.antigravity.permissionMode, 'ask');
  assert.equal(generate({ config: first.config, prompts: first.files, baseline: first.managed }).changes.length, 0);
  assert.equal(Object.keys(first.files).length, 7);
  assert.equal(payload().prompts.find(p => p.path.endsWith('/document-writer.md')).source, '../plugin/roles/document-writer.md');
});
test('reject malformed, duplicate and unsafe keys recursively', () => {
  for (const text of ['{', '{"x":1,"x":2}', '{"x":{"__proto__":1}}', '{"constructor":1}'])
    assert.throws(() => parse(text));
});
test('refuse missing dependencies, inline shadow, invalid overrides and managed drift', () => {
  assert.throws(() => generate({}), /MISSING_MODEL/);
  assert.throws(() => generate({ config, shadows: ['project'] }), /SHADOWED/);
  assert.throws(() => generate({ config: config.replace('"model":"personal/writer"', '"model":"personal/writer","prompt":"inline"') }), /SHADOWED/);
  assert.throws(() => generate({ config, overrides: '{"models":{}}' }), /INVALID_OVERRIDES/);
  const first = generate({ config });
  assert.throws(() => generate({ config: first.config, prompts: { ...first.files, 'oh-my-opencode-slim/oracle_append.md': 'drift' }, baseline: first.managed }), /DRIFT/);
});
