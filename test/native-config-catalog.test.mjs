import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createModelCatalog } from '../openchamber/service/model-catalog.mjs';

// The CLI/variant-deadline protocol was retired in API4. Detailed transport,
// SWR, aliases, epoch and bounded-event coverage lives in
// workbench-catalog-events.test.mjs; retain explicit no-CLI regression here.
test('catalog has no PATH CLI/model endpoint fallback and remains unbound without context', async () => {
  let cliCalls = 0, fetchCalls = 0;
  const catalog = createModelCatalog({ env: {},
    runCli() { cliCalls++; throw new Error('CLI must never run'); },
    async fetchImpl() { fetchCalls++; throw new Error('No configured proxy'); } });
  try {
    const result = await catalog.get({ refresh: true });
    assert.equal(cliCalls, 0);
    assert.equal(fetchCalls, 0);
    assert.deepEqual(result.models, []);
    assert.equal(result.status, 'unbound');
    assert.equal(result.runtimeBinding.configRoot, 'unverified');
  } finally { catalog.dispose(); }
});

test('public catalog implementation cannot spawn CLI or access private model route', () => {
  const source = fs.readFileSync(new URL('../openchamber/service/model-catalog.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:child_process|execFile|spawnSync|\/api\/model(?:['"?/]|$)/u);
  assert.match(source, /rpc\.omo-coworkers\.catalog\.v1\.snapshot/u);
});
