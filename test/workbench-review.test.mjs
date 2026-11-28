import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Workbench } from '../openchamber/native-config/workbench.mjs';
import { setupCatalogPublisher } from '../openchamber/plugin/catalog-publisher.mjs';
import { createService } from '../openchamber/service/main.mjs';
import { hash } from '../openchamber/native-config/generator.mjs';
const base = path.resolve('.opencode/work/workbench-fixtures');
const dir = () => fs.mkdtempSync(path.join(base, 'review-'));
function setup() {
  const root = dir(), directory = dir(), wb = new Workbench({ root, directory });
  const draft = wb.snapshot().draft; draft.settings.allowGlobalWrites = true;
  wb.save({ expectedRevision: 0, mutationId: 'mutation_1', draft });
  const p = wb.preview({ revision: 1, mode: 'publish' });
  return { root, directory, wb, draft, body: { operationId: 'operation_1', previewId: p.previewId,
    revision: 1, diffDigest: p.diffDigest, targetId: p.writeTarget.targetId, confirmations: p.requiredConfirmations } };
}
test('latest OFF revokes earlier preview without replacing newer draft', () => {
  const { wb, draft, body } = setup(); draft.settings.allowGlobalWrites = false;
  wb.save({ expectedRevision: 1, mutationId: 'mutation_2', draft });
  assert.throws(() => wb.operation(body), e => e.code === 'READ_ONLY');
  assert.equal(wb.snapshot().revision, 2);
});
test('incomplete ACP drafts save but cannot preview invalid native fields', () => {
  for (const patch of [{ wrapperModel: 'invalid' }, { cwd: '' }]) {
    const { wb, draft } = setup(); Object.assign(draft.roles.claude, patch);
    wb.save({ expectedRevision: 1, mutationId: 'mutation_2', draft });
    assert.throws(() => wb.preview({ revision: 2, mode: 'publish' }), e => e.code === 'INVALID_CONFIG');
  }
});
for (const kind of ['private', 'native', 'behavior']) test(`real process exit leaves ${kind} lock recoverable`, () => {
  const { root, directory, wb, body } = setup();
  const source = kind === 'behavior' ? `
    import fs from 'node:fs';
    import {readBehaviorSettings,updateBehaviorSettings} from './openchamber/service/behavior-settings.mjs';
    const original=fs.writeFileSync; fs.writeFileSync=(fd,...args)=>{original(fd,...args);process.exit(73)};
    updateBehaviorSettings({root:${JSON.stringify(root)},revision:readBehaviorSettings({root:${JSON.stringify(root)}}).revision,claudeGuardEnabled:false});
  ` : `
    import {NativeStore} from './openchamber/native-config/transaction.mjs';
    new NativeStore(${JSON.stringify(kind === 'private' ? directory : root)}).withLock(()=>process.exit(73));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: process.cwd(), env: process.env });
  assert.equal(child.status, 73, child.stderr.toString());
  const restart = new Workbench({ root, directory });
  assert.equal(restart.operation(body).operation.state, 'applied');
  assert.equal(restart.status('operation_1').operation.state, 'applied');
});
test('registration pending/rejected cannot block setup; late registration disposes', async () => {
  let resolve, disposed = 0;
  const tasks = [];
  const p = await setupCatalogPublisher({ model: { list() {} }, rpc: {
    register: () => new Promise(r => { resolve = r; }),
  } }, { schedule(fn) { tasks.push(fn); }, cancel() {} });
  p.dispose(); resolve({ dispose() { disposed++; } });
  await new Promise(r => setImmediate(r));
  assert.equal(disposed, 1); assert.equal(tasks.length, 0);
  const rejected = await setupCatalogPublisher({ model: { list() {} }, rpc: {
    register: async () => { throw Error('offline'); },
  } });
  await new Promise(r => setImmediate(r)); rejected.dispose();
});

test('real exit during WAL write recovers both locks and retains conditional restore authority', () => {
  const { root, directory, wb, body, draft } = setup();
  draft.settings.claudeGuardEnabled = true;
  wb.save({ expectedRevision: 1, mutationId: 'mutation_2', draft });
  const p = wb.preview({ revision: 2, mode: 'publish' });
  Object.assign(body, { revision: 2, previewId: p.previewId, diffDigest: p.diffDigest,
    confirmations: p.requiredConfirmations });
  const source = `
    import {Workbench} from './openchamber/native-config/workbench.mjs';
    const wb=new Workbench({root:${JSON.stringify(root)},directory:${JSON.stringify(directory)}});
    const atomic=wb.native.atomic.bind(wb.native);
    wb.native.atomic=(...args)=>{atomic(...args);process.exit(74)};
    wb.operation(${JSON.stringify(body)});
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { env: process.env });
  assert.equal(child.status, 74, child.stderr.toString());
  const restarted = new Workbench({ root, directory });
  const receipt = restarted.status(body.operationId).operation;
  assert.equal(receipt.state, 'pending');
  assert.ok(receipt.recovery);
  assert.equal(restarted.restore(body.operationId, {
    confirm: true, recoveryDigest: receipt.recovery.digest,
  }).operation.state, 'restored');
});

test('restore respects latest OFF across restart; query remains usable and ON permits confirmed recovery', () => {
  const { root, directory, wb, draft, body } = setup();
  draft.settings.claudeGuardEnabled = true;
  wb.save({ expectedRevision: 1, mutationId: 'mutation_2', draft });
  const p = wb.preview({ revision: 2, mode: 'publish' });
  Object.assign(body, { revision: 2, previewId: p.previewId, diffDigest: p.diffDigest,
    confirmations: p.requiredConfirmations });
  const atomic = wb.native.atomic.bind(wb.native);
  wb.native.atomic = (...args) => { atomic(...args); if (args[0].endsWith('.jsonc')) throw Error('partial'); };
  assert.equal(wb.operation(body).operation.state, 'unknown');
  draft.settings.allowGlobalWrites = false;
  wb.save({ expectedRevision: 2, mutationId: 'mutation_3', draft });
  const restarted = new Workbench({ root, directory });
  const hashes = () => {
    const files = fs.readdirSync(root, { recursive: true }).filter(f =>
      fs.statSync(path.join(root, f)).isFile() && !f.endsWith('/lock'));
    return files.sort().map(f => [f, hash(fs.readFileSync(path.join(root, f)))]);
  };
  const before = hashes(), receipt = restarted.status(body.operationId).operation;
  assert.ok(receipt.recovery);
  assert.throws(() => restarted.restore(body.operationId, {
    confirm: true, recoveryDigest: receipt.recovery.digest,
  }), e => e.code === 'READ_ONLY');
  assert.deepEqual(hashes(), before);
  assert.equal(restarted.status(body.operationId).operation.state, 'unknown');
  draft.settings.allowGlobalWrites = true;
  restarted.save({ expectedRevision: 3, mutationId: 'mutation_4', draft });
  const recovery = restarted.status(body.operationId).operation.recovery;
  assert.equal(restarted.restore(body.operationId, { confirm: true, recoveryDigest: recovery.digest }).operation.state, 'restored');
  draft.settings.allowGlobalWrites = false;
  restarted.save({ expectedRevision: 4, mutationId: 'mutation_5', draft });
  assert.equal(restarted.restore(body.operationId, { confirm: true, recoveryDigest: recovery.digest }).operation.state, 'restored');
});

test('HTTP live native lock yields explicit no-WAL proof then fresh operation succeeds after release', async () => {
  const { root, directory, wb, body } = setup();
  const lock = path.join(root, '.omo-coworkers/lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  const server = createService({ root, dataDir: directory, workbench: wb,
    token: 'review-token-at-least16', catalog: { dispose() {} } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const call = async (route, value) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method: 'POST', headers: { authorization: ['Bearer', 'review-token-at-least16'].join(' '), 'content-type': 'application/json' },
      body: JSON.stringify(value),
    });
    return { status: response.status, value: await response.json() };
  };
  try {
    const denied = await call('/workbench/operations', body);
    assert.equal(denied.status, 409);
    assert.equal(denied.value.error.code, 'LOCKED');
    assert.deepEqual(denied.value.error.disposition, { operationStarted: false });
    assert.equal(wb.load('operation-operation_1.json'), null);
    fs.unlinkSync(lock);
    const preview = (await call('/workbench/preview', { revision: 1, mode: 'publish' })).value;
    const next = { ...body, operationId: 'operation_2', previewId: preview.previewId,
      diffDigest: preview.diffDigest, confirmations: preview.requiredConfirmations };
    assert.equal((await call('/workbench/operations', next)).value.operation.state, 'applied');
    const mismatch = await call('/workbench/operations', { ...next, revision: 999 });
    assert.equal(mismatch.value.error.code, 'OPERATION_MISMATCH');
    assert.equal(mismatch.value.error.disposition, undefined);
  } finally {
    if (fs.existsSync(lock)) fs.unlinkSync(lock);
    await new Promise(resolve => server.close(resolve));
  }
});
