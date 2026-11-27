import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCatalog } from '../openchamber/service/model-catalog.mjs';

const api = JSON.stringify({ data: [
  { providerID: 'p', modelID: 'm', variants: [{ id: 'none' }, { id: 'thinking' }, { id: 'novel' }, { id: 'none' }] },
  { providerID: 'else', modelID: 'missing', variants: [{ id: 'high' }] },
] });
const mock = (args) => args[0] === 'models' ? 'p/m\np/m\n# comment\ninvalid\np/other\n' : api;

test('exact CLI vectors, real variants only, safe projection and cloned cache', async () => {
  const calls = [];
  const adapter = createModelCatalog({ runCli: (args, options) => {
    calls.push(args);
    assert.equal(options.timeoutMs, 5000);
    assert.equal(options.maxBytes, 1048576);
    return mock(args);
  }, context: { secret: 'do-not-project' } });
  const result = await adapter.get();
  assert.deepEqual(calls, [['models'], ['api', 'GET', '/api/model']]);
  assert.deepEqual(result.catalog, ['p/m', 'p/other']);
  assert.deepEqual(result.variants['p/m'], ['none', 'thinking', 'novel']);
  assert.equal(result.variants['p/other'], undefined);
  assert.equal(result.variants['else/missing'], undefined);
  assert.equal(result.provenance, 'unverified');
  assert.equal(result.context.verified, false);
  assert.ok(!JSON.stringify(result).includes('do-not-project'));
  result.catalog.push('mutated/m');
  const cached = await adapter.get();
  assert.equal(cached.cache.hit, true);
  assert.equal(cached.catalog.length, 2);
});

test('TTL, refresh, concurrent dedupe and context isolation', async () => {
  let clock = 0;
  let key = 'a';
  let calls = 0;
  const adapter = createModelCatalog({ now: () => clock, context: () => key,
    runCli: async (args) => { calls++; return mock(args); } });
  await Promise.all([adapter.get(), adapter.get(), adapter.get({ refresh: true })]);
  assert.equal(calls, 2);
  clock = 59999;
  assert.equal((await adapter.get()).cache.hit, true);
  clock = 60000;
  await adapter.get();
  assert.equal(calls, 4);
  await adapter.get({ refresh: true });
  assert.equal(calls, 6);
  key = 'b';
  await adapter.get();
  assert.equal(calls, 8);
  key = 'a';
  assert.equal((await adapter.get()).cache.hit, true);
});

test('malformed API and models are finite diagnostics, no fallback, recovery', async () => {
  let mode = 'bad-models';
  const calls = [];
  const adapter = createModelCatalog({ runCli: (args) => {
    calls.push(args);
    if (mode === 'bad-models') return 'not a model';
    if (mode === 'bad-api' && args[0] === 'api') return '{broken SECRET';
    if (mode === 'bad-shape' && args[0] === 'api') return '{"data":{}}';
    if (mode === 'error') throw new Error('SECRET /private/path');
    return mock(args);
  } });
  assert.deepEqual((await adapter.get()).diagnostics, ['models:malformed-output']);
  assert.equal(calls.length, 1);
  mode = 'bad-api';
  assert.deepEqual((await adapter.get()).diagnostics, ['variants:malformed-output']);
  mode = 'bad-shape';
  assert.deepEqual((await adapter.get()).diagnostics, ['variants:malformed-output']);
  mode = 'error';
  assert.deepEqual((await adapter.get()).diagnostics, ['models:cli-failed']);
  mode = 'ok';
  assert.deepEqual((await adapter.get()).diagnostics, []);
});

test('byte bound, nontext output and no guessed variants', async () => {
  for (const output of ['x'.repeat(1048577), null]) {
    const adapter = createModelCatalog({ runCli: () => output });
    const result = await adapter.get();
    assert.deepEqual(result.catalog, []);
    assert.deepEqual(result.diagnostics, [output === null
      ? 'models:malformed-output' : 'models:output-limit']);
  }
  const adapter = createModelCatalog({ runCli: (args) => args[0] === 'models'
    ? 'opencode/m' : '{"data":[]}' });
  assert.deepEqual((await adapter.get()).variants, {});
});

test('bounded timeout clears inflight and permits recovery', async () => {
  let stuck = true;
  const adapter = createModelCatalog({ runCli: (args) => stuck
    ? new Promise(() => {}) : mock(args) });
  const [a, b] = await Promise.all([adapter.get(), adapter.get({ refresh: true })]);
  assert.deepEqual(a.diagnostics, ['models:timeout']);
  assert.deepEqual(b.diagnostics, ['models:timeout']);
  stuck = false;
  assert.deepEqual((await adapter.get()).diagnostics, []);
});
