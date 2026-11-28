import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createService, defaultRoot } from '../openchamber/service/main.mjs';

const base = path.resolve('.opencode/work/workbench-fixtures');
fs.mkdirSync(base, { recursive: true, mode: 0o700 });
const directory = () => fs.mkdtempSync(path.join(base, 'service-v4-'));
test('all previous native editing authorities are retired, authenticated and nonwriting', async () => {
  const root = directory(), dataDir = directory();
  const config = path.join(root, 'oh-my-opencode-slim.jsonc');
  fs.writeFileSync(config, '{"custom":"unchanged"}', { mode: 0o600 });
  const server = createService({ root, dataDir, token: 'a'.repeat(48),
    catalog: { async get() { return { models: [], status: 'unbound' }; }, dispose() {} } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: ['Bearer', 'a'.repeat(48)].join(' '), 'content-type': 'application/json' };
  try {
    const retired = [
      ['GET', '/templates'], ['POST', '/reveal'], ['POST', '/preview'], ['POST', '/template-preview'],
      ['POST', '/user-templates'], ['DELETE', '/user-templates'], ['GET', '/snapshot'], ['GET', '/status'],
      ['POST', '/intent-preview'], ['PATCH', '/config'], ['POST', '/undo-preview'],
      ['POST', '/migration-preview'], ['POST', '/recover'], ['PATCH', '/settings'],
    ];
    for (const [method, route] of retired) {
      assert.equal((await fetch(url + route, { method })).status, 401);
      const response = await fetch(url + route, { method, headers,
        ...(method === 'GET' ? {} : { body: '{"path":"/escape","bytes":"never"}' }) });
      assert.equal(response.status, 410, route);
      assert.equal((await response.json()).error.code, 'API_RETIRED');
    }
    const snapshot = await (await fetch(url + '/workbench', { headers })).json();
    assert.equal(snapshot.apiVersion, 4);
    assert.equal(snapshot.runtimeBinding.applied, 'unverified');
    assert.equal((await fetch(url + '/workbench/draft', { method: 'PATCH', headers,
      body: JSON.stringify({ huge: 'x'.repeat(64000) }) })).status, 413);
    assert.equal((await fetch(url + '/workbench/preview', { method: 'POST', headers,
      body: JSON.stringify({ revision: 0, mode: 'hot' }) })).status, 409);
    assert.equal(fs.readFileSync(config, 'utf8'), '{"custom":"unchanged"}');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('legacy unresolved journals block v4 publish without being recovered or removed', async () => {
  const root = directory(), dataDir = directory();
  fs.mkdirSync(path.join(root, '.omo-coworkers'), { mode: 0o700 });
  const journal = path.join(root, '.omo-coworkers/manager-journal.json');
  fs.writeFileSync(journal, '{"private":"legacy"}', { mode: 0o600 });
  const server = createService({ root, dataDir, token: 'a'.repeat(48),
    catalog: { async get() { return { models: [] }; }, dispose() {} } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/workbench/preview`, {
      method: 'POST', headers: { authorization: ['Bearer', 'a'.repeat(48)].join(' '), 'content-type': 'application/json' },
      body: '{"revision":0,"mode":"publish"}' });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'LEGACY_RECOVERY_REQUIRED');
    assert.equal(fs.readFileSync(journal, 'utf8'), '{"private":"legacy"}');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('default candidate ignores service OPENCODE_CONFIG_DIR; invalid home fails closed', () => {
  assert.equal(defaultRoot({ HOME: '/isolated', OPENCODE_CONFIG_DIR: '/not-evidence' }), '/isolated/.config/opencode');
  assert.throws(() => defaultRoot({ HOME: 'relative' }));
  assert.throws(() => defaultRoot({ HOME: '/isolated', XDG_CONFIG_HOME: 'relative' }));
});
