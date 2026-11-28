import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { WorkbenchState, initialDraft } from '../openchamber/native-config/workbench-state.mjs';
import { projectDraft, importNativeDraft } from '../openchamber/native-config/workbench-projection.mjs';
import { Workbench } from '../openchamber/native-config/workbench.mjs';
import { publicModels, setupCatalogPublisher } from '../openchamber/plugin/catalog-publisher.mjs';
import { createService } from '../openchamber/service/main.mjs';

const fixtures = path.resolve('.opencode/work/workbench-fixtures');
fs.mkdirSync(fixtures, { recursive: true, mode: 0o700 });
const directory = () => fs.mkdtempSync(path.join(fixtures, 'backend-'));
const code = (fn, value) => assert.throws(fn, e => e.code === value);

test('private autosave survives restart and mutation replay without native writes', () => {
  const data = directory(), state = new WorkbenchState(data), draft = initialDraft();
  assert.equal(draft.settings.allowGlobalWrites, false);
  delete draft.roles.designer.model; // Incomplete drafts may autosave.
  const request = { expectedRevision: 0, mutationId: 'mutation_1', draft };
  assert.equal(state.save(request).revision, 1);
  const restarted = new WorkbenchState(data);
  assert.deepEqual(restarted.save(request), { ok: true, revision: 1, replayed: true });
  code(() => restarted.save({ ...request, draft: initialDraft() }), 'MUTATION_MISMATCH');
  code(() => restarted.save({ ...request, mutationId: 'mutation_2' }), 'STALE_REVISION');
  draft.roles.claude.env = { SECRET: 'not-allowed' };
  code(() => restarted.save({ expectedRevision: 1, mutationId: 'mutation_3', draft }), 'INVALID_VALUE');
});

test('projection preserves unmanaged secrets, council seats and opaque ids; ACP variant stays intent', () => {
  const draft = initialDraft();
  draft.roles.claude.permissionMode = 'reject';
  const before = '{"provider":{"token":"keep-secret"},"council":{"presets":{"x":{"seats":["a"]}}},"agents":{"councillor-a":{"model":"keep/seat"}},"acpAgents":{"claude":{"env":{"PRIVATE":"keep"}}}}';
  const result = JSON.parse(projectDraft(before, draft).text);
  assert.equal(result.provider.token, 'keep-secret');
  assert.equal(result.agents['councillor-a'].model, 'keep/seat');
  assert.deepEqual(result.council.presets.x.seats, ['a']);
  assert.equal(result.agents['document-writer'].model, 'magpie/agy-cli/gemini-4-hydrogen');
  assert.equal(result.acpAgents.claude.env.PRIVATE, 'keep');
  assert.equal(result.acpAgents.claude.requestedVariant, undefined);
  assert.equal(result.acpAgents.claude.permissionMode, 'reject');
  const imported = importNativeDraft(before);
  assert.equal(JSON.stringify(imported).includes('keep-secret'), false);
  assert.equal(JSON.stringify(imported).includes('PRIVATE'), false);
});

test('cold publish pins saved revision, persists receipt, protects external changes', () => {
  const root = directory(), data = directory(), config = path.join(root, 'oh-my-opencode-slim.jsonc');
  fs.writeFileSync(config, '{"custom":{"secret":"preserve"}}', { mode: 0o600 });
  const wb = new Workbench({ root, directory: data });
  const draft = wb.snapshot().draft;
  draft.settings.allowGlobalWrites = true;
  wb.save({ expectedRevision: 0, mutationId: 'mutation_1', draft });
  const preview = wb.preview({ revision: 1, mode: 'publish' });
  assert.equal(fs.readFileSync(config, 'utf8'), '{"custom":{"secret":"preserve"}}');
  assert.equal(JSON.stringify(preview).includes('preserve'), false);
  const operation = { operationId: 'operation_1', previewId: preview.previewId, revision: 1,
    diffDigest: preview.diffDigest, targetId: preview.writeTarget.targetId,
    confirmations: preview.requiredConfirmations };
  code(() => wb.operation({ ...operation, confirmations: [] }), 'CONFIRMATION_REQUIRED');
  const later = structuredClone(draft);
  later.roles.designer.model = 'other/model';
  wb.save({ expectedRevision: 1, mutationId: 'mutation_2', draft: later });
  assert.equal(wb.operation(operation).operation.state, 'applied');
  assert.equal(wb.snapshot().revision, 2);
  assert.equal(wb.snapshot().draft.roles.designer.model, 'other/model');
  assert.equal(wb.snapshot().appliedDraft.roles.designer.model, draft.roles.designer.model);
  assert.equal(JSON.parse(fs.readFileSync(config)).custom.secret, 'preserve');
  const restarted = new Workbench({ root, directory: data });
  assert.equal(restarted.operation(operation).operation.state, 'applied');
  code(() => restarted.operation({ ...operation, revision: 2 }), 'OPERATION_MISMATCH');
  const p2 = restarted.preview({ revision: 2, mode: 'publish' });
  fs.appendFileSync(config, '\n ');
  code(() => restarted.operation({ ...operation, operationId: 'operation_2', previewId: p2.previewId,
    revision: 2, diffDigest: p2.diffDigest, targetId: p2.writeTarget.targetId,
    confirmations: p2.requiredConfirmations }), 'CONFLICT');
});

test('publisher whitelists canonical ids, emits full unchanged snapshots and disposes', async () => {
  const model = { providerID: 'magpie', id: 'agy/model/name', modelID: 'different',
    variants: { high: { secret: true } }, token: 'never' };
  assert.deepEqual(publicModels([model]), [{ providerID: 'magpie', id: 'agy/model/name', variants: ['high'] }]);
  const tasks = [], emitted = [];
  let disposed = 0, calls = 0;
  const ctx = { model: { async list() { calls++; return [model]; } },
    rpc: { async register(spec, handlers) {
      assert.equal(spec.id, 'omo-coworkers.catalog.v1'); assert.deepEqual(handlers, {});
      return { events: { async emit(name, payload) { emitted.push(payload); } },
        dispose() { disposed++; } };
    } } };
  const publisher = await setupCatalogPublisher(ctx, { instanceId: 'test-instance',
    now: () => 123, schedule(fn, delay) { tasks.push({ fn, delay }); return tasks.length; }, cancel() {} });
  assert.equal(calls, 0);
  await new Promise(resolve => setImmediate(resolve));
  await tasks.shift().fn();
  assert.equal(tasks[0].delay, 30000);
  await tasks.shift().fn();
  assert.equal(emitted.length, 2);
  assert.equal(emitted[0].catalogRevision, emitted[1].catalogRevision);
  assert.equal(emitted[1].sequence, 2);
  assert.equal(JSON.stringify(emitted).includes('never'), false);
  publisher.dispose();
  await tasks.shift().fn();
  assert.equal(calls, 2); assert.equal(disposed, 1);
});

test('write readback resolves response loss without replay and leaves partial operations blocked', () => {
  const root = directory(), data = directory(), wb = new Workbench({ root, directory: data });
  const draft = wb.snapshot().draft;
  draft.settings.allowGlobalWrites = true;
  wb.save({ expectedRevision: 0, mutationId: 'mutation_1', draft });
  const p = wb.preview({ revision: 1, mode: 'publish' });
  const original = wb.native.atomic.bind(wb.native);
  wb.native.atomic = (...args) => { original(...args); if (args[0].endsWith('.jsonc')) throw new Error('lost response'); };
  const request = { operationId: 'operation_1', previewId: p.previewId, revision: 1,
    diffDigest: p.diffDigest, targetId: p.writeTarget.targetId, confirmations: p.requiredConfirmations };
  assert.equal(wb.operation(request).operation.state, 'unknown');
  const restarted = new Workbench({ root, directory: data });
  assert.equal(restarted.status('operation_1').operation.state, 'applied');
  assert.equal(restarted.snapshot().appliedDraft.settings.allowGlobalWrites, true);
  const next = restarted.snapshot().draft;
  next.settings.claudeGuardEnabled = true;
  restarted.save({ expectedRevision: 1, mutationId: 'mutation_2', draft: next });
  const p2 = restarted.preview({ revision: 2, mode: 'publish' });
  const write = restarted.native.atomic.bind(restarted.native);
  restarted.native.atomic = (...args) => { write(...args); throw new Error('lost before guard'); };
  const partial = { ...request, operationId: 'operation_2', previewId: p2.previewId, revision: 2,
    diffDigest: p2.diffDigest, targetId: p2.writeTarget.targetId, confirmations: p2.requiredConfirmations };
  assert.equal(restarted.operation(partial).operation.state, 'unknown');
  assert.equal(restarted.status('operation_2').operation.state, 'unknown');
  code(() => restarted.operation({ ...partial, operationId: 'operation_3' }), 'RECOVERY_REQUIRED');
  const recovery = restarted.status('operation_2').operation.recovery;
  assert.ok(recovery);
  code(() => restarted.restore('operation_2', { confirm: true, recoveryDigest: 'stale' }), 'CONFLICT');
  assert.equal(restarted.restore('operation_2', { confirm: true, recoveryDigest: recovery.digest }).operation.state, 'restored');
});

test('native import replay is durable across source change and validates saved history', () => {
  const root = directory(), data = directory(), config = path.join(root, 'oh-my-opencode-slim.jsonc');
  fs.writeFileSync(config, '{"agents":{"designer":{"model":"custom/multi/part","variant":"unknown"}},"acpAgents":{"claude":{"permissionMode":"reject","timeoutMs":2147483647,"env":{"API_TOKEN":"never-copy"}}}}', { mode: 0o600 });
  const wb = new Workbench({ root, directory: data });
  assert.equal(wb.snapshot().draft.roles.designer.model, 'custom/multi/part');
  assert.equal(wb.snapshot().draft.roles.claude.timeoutMs, 2147483647);
  const request = { expectedRevision: 0, mutationId: 'import_01', confirm: true };
  assert.equal(wb.importNative(request).revision, 1);
  fs.writeFileSync(config, '{}');
  const restarted = new Workbench({ root, directory: data });
  assert.deepEqual(restarted.importNative(request), { ok: true, revision: 1, replayed: true });
  assert.equal(JSON.stringify(restarted.snapshot()).includes('never-copy'), false);
  const file = path.join(data, 'workbench-state.json');
  const corrupt = JSON.parse(fs.readFileSync(file));
  corrupt.mutations.push({ id: 'invalid', hash: 'bad', revision: 0 });
  fs.writeFileSync(file, JSON.stringify(corrupt));
  code(() => new WorkbenchState(data), 'RECOVERY_REQUIRED');
});

test('HTTP v4 authenticates, retires old writers and separates catalog selector from target', async () => {
  let context = null, disposed = false;
  const catalog = { async get({ directory }) { context = directory; return { models: [], status: 'unbound' }; },
    dispose() { disposed = true; } };
  const server = createService({ root: directory(), dataDir: directory(), token: 'test-token-at-least-16', catalog });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (route, options = {}) => fetch(base + route, { ...options,
    headers: { authorization: ['Bearer', 'test-token-at-least-16'].join(' '), 'content-type': 'application/json', ...options.headers } });
  try {
    assert.equal((await fetch(base + '/workbench')).status, 401);
    assert.equal((await call('/config', { method: 'PATCH', body: '{}' })).status, 410);
    const before = await (await call('/workbench')).json();
    assert.equal(before.draft.settings.allowGlobalWrites, false);
    const response = await call('/workbench/context', { method: 'POST', body: JSON.stringify({ directory: '/claimed/catalog' }) });
    assert.equal(response.status, 200); assert.equal(context, '/claimed/catalog');
    const after = await (await call('/workbench')).json();
    assert.deepEqual(after.writeTarget, before.writeTarget);
    assert.equal((await call('/workbench/context', { method: 'POST', body: '{"directory":"/x","root":"/evil"}' })).status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); }
  assert.equal(disposed, true);
});
