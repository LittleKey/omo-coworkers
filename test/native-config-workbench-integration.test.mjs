import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupCatalogPublisher } from '../openchamber/plugin/catalog-publisher.mjs';
import { createModelCatalog } from '../openchamber/service/model-catalog.mjs';
import { createService } from '../openchamber/service/main.mjs';
import { modelId } from '../openchamber/panel/model.js';

const fixtures = path.resolve('.opencode/work/workbench-fixtures');
fs.mkdirSync(fixtures, { recursive: true, mode: 0o700 });
const directory = () => fs.mkdtempSync(path.join(fixtures, 'integration-'));
const turn = () => new Promise(resolve => setImmediate(resolve));

test('actual publisher → public envelope → SSE catalog → service/models → panel opaque modelId', async () => {
  const tasks = [], token = 'integration-token-16', selected = directory();
  let stream, eventType, publisher;
  const catalog = createModelCatalog({
    dataDir: directory(), context: selected, env: {}, token,
    opencodeUrl: 'https://host.invalid', schedule: () => 1, cancel() {},
    fetchImpl: async (url, options) => {
      assert.equal(url, `https://host.invalid/api/event?types=${eventType}`);
      assert.equal(options.headers.Authorization, `Bearer ${token}`);
      return new Response(new ReadableStream({ start(controller) {
        stream = controller;
        options.signal.addEventListener('abort', () => { try { controller.close(); } catch {} });
      } }), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  publisher = await setupCatalogPublisher({
    model: { async list() { return { location: { directory: selected }, data: [
      { providerID: 'magpie', id: 'agy-cli/gemini/opaque',
        modelID: 'underlying-alias', name: '多层模型',
        variants: [{ id: 'high', settings: { token: 'never' } }, { id: 'low' }],
        apiKey: 'never' }] }; } },
    rpc: { async register(spec, handlers) {
      eventType = `rpc.${spec.id}.snapshot`;
      assert.deepEqual(handlers, {});
      assert.ok(spec.events.snapshot.schema);
      return { events: { async emit(name, data) {
        assert.equal(name, 'snapshot');
        // Public SDK supplies this envelope, not plugin-private transport.
        const envelope = { id: 'event-1', created: 123, type: eventType,
          location: { directory: selected }, data };
        const bytes = new TextEncoder().encode(`event: ${eventType}\r\ndata: ${JSON.stringify(envelope)}\r\n\r\n`);
        for (const byte of bytes) stream.enqueue(Uint8Array.of(byte));
      } }, dispose() {} };
    } },
  }, { schedule(fn) { tasks.push(fn); return tasks.length; }, cancel() {} });
  const server = createService({ root: directory(), dataDir: directory(), token, catalog });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const get = () => fetch(`http://127.0.0.1:${server.address().port}/models?directory=${encodeURIComponent(selected)}`,
    { headers: { authorization: `Bearer ${token}` } }).then(r => r.json());
  try {
    assert.equal((await get()).status, 'waiting');
    await tasks.shift()();
    await turn();
    const result = await get();
    assert.equal(result.status, 'live');
    assert.equal(modelId(result.models[0]), 'magpie/agy-cli/gemini/opaque');
    assert.deepEqual(result.models[0].variants, ['high', 'low']);
    assert.equal(JSON.stringify(result).includes('underlying-alias'), false);
    assert.equal(JSON.stringify(result).includes('never'), false);
    assert.equal(result.runtimeBinding.configRoot, 'unverified');
  } finally {
    publisher.dispose();
    await new Promise(resolve => server.close(resolve));
  }
});

test('actual authenticated v4 HTTP autosave → maintained preset preview → confirmation → operation readback', async () => {
  const root = directory(), dataDir = directory(), token = 'integration-token-16';
  const file = path.join(root, 'oh-my-opencode-slim.jsonc');
  const before = '{"preset":"team.v1","presets":{"team.v1":{"oracle":{"model":"user/model"}}},"unmanaged":{"secret":"preserve"}}';
  fs.writeFileSync(file, before, { mode: 0o600 });
  const catalog = { async get() { return { models: [], status: 'unbound' }; }, dispose() {} };
  const server = createService({ root, dataDir, token, catalog });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const call = async (method, route, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, value: await response.json() };
  };
  try {
    const initial = (await call('GET', '/workbench')).value;
    assert.equal(initial.draft.roles.oracle.model, 'user/model');
    initial.draft.settings.allowGlobalWrites = true;
    initial.draft.roles.oracle.model = 'magpie/agy-cli/model/with/slashes';
    const saved = await call('PATCH', '/workbench/draft', {
      expectedRevision: 0, mutationId: 'integration_save', draft: initial.draft,
    });
    assert.equal(saved.status, 200);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(fs.existsSync(path.join(root, 'oh-my-opencode-slim/oracle_append.md')), false);
    const preview = (await call('POST', '/workbench/preview', { revision: 1, mode: 'publish' })).value;
    assert.ok(preview.changes.some(c => c.field === 'presets.team.v1.oracle.model'));
    assert.ok(preview.changes.some(c => c.field.endsWith('oracle_append.md')));
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    const request = { operationId: 'integration_operation', previewId: preview.previewId,
      revision: 1, diffDigest: preview.diffDigest, targetId: preview.writeTarget.targetId,
      confirmations: [] };
    const denied = await call('POST', '/workbench/operations', request);
    assert.equal(denied.status, 409);
    assert.deepEqual(denied.value.error.disposition, { operationStarted: false });
    request.confirmations = preview.requiredConfirmations;
    const applied = await call('POST', '/workbench/operations', request);
    assert.equal(applied.status, 200);
    assert.equal(applied.value.operation.state, 'applied');
    assert.equal((await call('GET', '/workbench/operations/integration_operation')).value.operation.state, 'applied');
    assert.equal((await call('POST', '/workbench/operations', request)).value.operation.state, 'applied');
    const native = JSON.parse(fs.readFileSync(file));
    assert.equal(native.presets['team.v1'].oracle.model, 'magpie/agy-cli/model/with/slashes');
    assert.equal(native.unmanaged.secret, 'preserve');
    assert.ok(native.agents['document-writer'].description);
    assert.ok(fs.readFileSync(path.join(root, 'oh-my-opencode-slim/oracle_append.md'), 'utf8').length);
    const final = (await call('GET', '/workbench')).value;
    assert.equal(final.revision, 1);
    assert.equal(final.writeTarget.consent, 'user-confirmed');
    assert.equal(final.runtime.state, 'pending');
    assert.equal(JSON.stringify(final).includes('preserve'), false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
