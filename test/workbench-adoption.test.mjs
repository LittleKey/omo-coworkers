import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Workbench } from '../openchamber/native-config/workbench.mjs';
import { projectDraft, importNativeDraft } from '../openchamber/native-config/workbench-projection.mjs';
import { hash } from '../openchamber/native-config/generator.mjs';

const fixtures = path.resolve('.opencode/work/workbench-fixtures');
fs.mkdirSync(fixtures, { recursive: true, mode: 0o700 });
const directory = () => fs.mkdtempSync(path.join(fixtures, 'adoption-'));
const expectCode = (fn, code) => assert.throws(fn, e => e.code === code);
function setup(config = '{}') {
  const root = directory(), data = directory();
  fs.writeFileSync(path.join(root, 'oh-my-opencode-slim.jsonc'), config, { mode: 0o600 });
  const wb = new Workbench({ root, directory: data });
  const draft = wb.snapshot().draft;
  draft.settings.allowGlobalWrites = true;
  wb.save({ expectedRevision: 0, mutationId: 'mutation_1', draft });
  return { root, data, wb, draft };
}
const request = (preview, id = 'operation_1') => ({
  operationId: id, previewId: preview.previewId, revision: preview.revision,
  diffDigest: preview.diffDigest, targetId: preview.writeTarget.targetId,
  confirmations: preview.requiredConfirmations,
});

test('same writer adopts frozen prompts/registration and reuses consent without checkbox flags', () => {
  const { root, data, wb } = setup('{"unmanaged":{"credential":"never-copy"}}');
  const p = wb.preview({ revision: 1, mode: 'publish' });
  assert.ok(p.requiredConfirmations.includes('firstTakeover'));
  assert.equal(wb.operation(request(p)).operation.state, 'applied');
  const after = JSON.parse(fs.readFileSync(path.join(root, 'oh-my-opencode-slim.jsonc')));
  assert.ok(after.agents['document-writer'].description);
  assert.ok(after.agents['lark-operator'].orchestratorPrompt);
  assert.ok(after.acpAgents.claude.prompt);
  assert.equal(after.unmanaged.credential, 'never-copy');
  const oldAssets = wb.native.data.prompts.map(source => {
    const file = path.join(root, source.path);
    return [file, fs.statSync(file).ino, hash(fs.readFileSync(file))];
  });
  const restarted = new Workbench({ root, directory: data });
  const p2 = restarted.preview({ revision: 1, mode: 'publish' });
  assert.deepEqual(p2.requiredConfirmations, []);
  assert.equal(p2.writeTarget.consent, 'user-confirmed');
  assert.equal(restarted.operation(request(p2, 'operation_2')).operation.state, 'applied');
  for (const [file, inode, digest] of oldAssets) {
    assert.equal(fs.statSync(file).ino, inode, 'matching maintained asset was not rewritten');
    assert.equal(hash(fs.readFileSync(file)), digest);
  }
  assert.equal(fs.readFileSync(path.join(data, 'operation-operation_1.json'), 'utf8').includes('never-copy'), false);
  assert.equal(fs.readFileSync(path.join(data, 'operation-operation_1.json'), 'utf8').includes('跨'), false);
  assert.equal(restarted.snapshot().runtimeBinding.configRoot, 'unverified');
});

test('personal/unknown historical prompts and inline definitions fail closed without retaining bodies', () => {
  for (const kind of ['prompt', 'inline', 'definition']) {
    const { root, data, wb } = setup();
    if (kind === 'prompt') {
      fs.mkdirSync(path.join(root, 'oh-my-opencode-slim'), { mode: 0o700 });
      fs.writeFileSync(path.join(root, wb.native.promptPaths[0]), 'unknown-old-or-personal-body', { mode: 0o600 });
    } else {
      fs.writeFileSync(path.join(root, 'oh-my-opencode-slim.jsonc'), JSON.stringify({
        agents: { [kind === 'inline' ? 'oracle' : 'document-writer']: {
          [kind === 'inline' ? 'prompt' : 'description']: 'unknown-old-or-personal-body',
        } },
      }));
    }
    expectCode(() => wb.preview({ revision: 1, mode: 'publish' }), 'PERSONAL_CONTENT_BLOCKED');
    assert.ok(wb.snapshot().blockers.includes('PERSONAL_CONTENT_BLOCKED'));
    for (const name of fs.readdirSync(data).filter(n => n.endsWith('.json')))
      assert.equal(fs.readFileSync(path.join(data, name), 'utf8').includes('unknown-old-or-personal-body'), false);
  }
});

for (let breakpoint = 1; breakpoint <= 8; breakpoint++) {
  test(`multi-file adoption interruption ${breakpoint}/8 survives restart and conditionally restores`, () => {
    const { root, data, wb } = setup('{"provider":{"secret":"keep"}}');
    const draft = wb.snapshot().draft;
    draft.settings.claudeGuardEnabled = true; // Ensures config-write interruption remains partial.
    wb.save({ expectedRevision: 1, mutationId: 'mutation_2', draft });
    const p = wb.preview({ revision: 2, mode: 'publish' }), body = request(p);
    const atomic = wb.native.atomic.bind(wb.native);
    let writes = 0;
    wb.native.atomic = (...args) => {
      atomic(...args);
      if (++writes === breakpoint) throw new Error('isolated interruption');
    };
    assert.equal(wb.operation(body).operation.state, 'unknown');
    const restarted = new Workbench({ root, directory: data });
    const receipt = restarted.status(body.operationId).operation;
    assert.equal(receipt.state, 'unknown');
    expectCode(() => restarted.operation({ ...body, operationId: 'operation_2' }), 'RECOVERY_REQUIRED');
    assert.ok(receipt.recovery);
    assert.equal(restarted.restore(body.operationId, {
      confirm: true, recoveryDigest: receipt.recovery.digest,
    }).operation.state, 'restored');
    for (const source of restarted.native.data.prompts) assert.equal(fs.existsSync(path.join(root, source.path)), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'oh-my-opencode-slim.jsonc'))).provider.secret, 'keep');
  });
}

test('existing exact assets retain their version hashes through interrupted adoption/restore', () => {
  const { root, data, wb } = setup();
  const existing = wb.native.data.prompts[0];
  fs.mkdirSync(path.dirname(path.join(root, existing.path)), { mode: 0o700 });
  fs.writeFileSync(path.join(root, existing.path), existing.text, { mode: 0o600 });
  const p = wb.preview({ revision: 1, mode: 'publish' }), original = wb.native.atomic.bind(wb.native);
  wb.native.atomic = (...args) => { original(...args); throw new Error('stop'); };
  assert.equal(wb.operation(request(p)).operation.state, 'unknown');
  const restarted = new Workbench({ root, directory: data });
  // A changed bundle identity must never be used to reconstruct an old body.
  restarted.native.data.hash = '0'.repeat(64);
  const recovery = restarted.status('operation_1').operation.recovery;
  assert.ok(recovery);
  assert.equal(restarted.restore('operation_1', { confirm: true, recoveryDigest: recovery.digest }).operation.state, 'restored');
  assert.equal(hash(fs.readFileSync(path.join(root, existing.path))), hash(existing.text));
});

test('third-value prompt replacement blocks recovery and subsequent writes', () => {
  const { root, data, wb } = setup();
  const p = wb.preview({ revision: 1, mode: 'publish' }), original = wb.native.atomic.bind(wb.native);
  wb.native.atomic = (...args) => { original(...args); throw new Error('stop'); };
  assert.equal(wb.operation(request(p)).operation.state, 'unknown');
  fs.writeFileSync(path.join(root, wb.native.promptPaths[0]), 'third-value');
  const restarted = new Workbench({ root, directory: data });
  assert.equal(restarted.status('operation_1').operation.recovery, null);
  expectCode(() => restarted.restore('operation_1', { confirm: true, recoveryDigest: 'stale' }), 'CONFLICT');
  assert.equal(fs.readFileSync(path.join(root, wb.native.promptPaths[0]), 'utf8'), 'third-value');
});

test('selected flat/nested presets preserve native choices, dot keys and council seats; complex sources block', () => {
  for (const nested of [false, true]) {
    const roles = { oracle: { model: 'user/model', variant: 'user' }, councillor: { model: 'user/council' } };
    const native = { preset: 'team.v1', presets: { 'team.v1': nested ? { agents: roles } : roles,
      untouched: { extends: 'opaque' } }, council: { presets: { x: { seats: ['a'] } } },
      agents: { 'councillor-a': { model: 'keep/seat' } } };
    const draft = importNativeDraft(JSON.stringify(native));
    assert.equal(draft.roles.oracle.model, 'user/model');
    draft.roles.oracle.model = 'new/model';
    delete draft.roles.oracle.variant;
    const projected = projectDraft(JSON.stringify(native), draft);
    assert.ok(projected.entries.some(e => e.keys[0] === 'presets' && e.keys[1] === 'team.v1'));
    const after = JSON.parse(projected.text), entry = nested ? after.presets['team.v1'].agents.oracle : after.presets['team.v1'].oracle;
    assert.equal(entry.model, 'new/model');
    assert.equal(entry.variant, undefined);
    assert.equal(after.agents['councillor-a'].model, 'keep/seat');
    assert.deepEqual(after.council, native.council);
    assert.deepEqual(after.presets.untouched, native.presets.untouched);
  }
  for (const native of [
    { preset: 'x', presets: { x: { extends: 'y' } } },
    { agents: { oracle: { inheritModelFrom: 'session' } } },
    { preset: 'x', presets: { x: { oracle: {}, agents: { oracle: {} } } } },
  ]) expectCode(() => importNativeDraft(JSON.stringify(native)), 'COMPLEX_MODEL_SOURCE');
});

test('interrupted preset restore uses actual path arrays even when preset names contain dots', () => {
  const { root, data, wb } = setup('{"preset":"team.v1","presets":{"team.v1":{"oracle":{"model":"old/model"}}}}');
  const draft = wb.snapshot().draft;
  assert.equal(draft.roles.oracle.variant, undefined);
  draft.roles.oracle.model = 'new/model';
  draft.settings.claudeGuardEnabled = true;
  wb.save({ expectedRevision: 1, mutationId: 'mutation_2', draft });
  const p = wb.preview({ revision: 2, mode: 'publish' }), atomic = wb.native.atomic.bind(wb.native);
  wb.native.atomic = (...args) => { atomic(...args); if (args[0].endsWith('.jsonc')) throw new Error('stop'); };
  assert.equal(wb.operation(request(p)).operation.state, 'unknown');
  const restarted = new Workbench({ root, directory: data }), recovery = restarted.status('operation_1').operation.recovery;
  assert.equal(restarted.restore('operation_1', { confirm: true, recoveryDigest: recovery.digest }).operation.state, 'restored');
  const after = JSON.parse(fs.readFileSync(path.join(root, 'oh-my-opencode-slim.jsonc')));
  assert.equal(after.presets['team.v1'].oracle.model, 'old/model');
  assert.equal(after.presets.team, undefined);
});

test('target root replacement, file replacement and JSON selection changes require fresh consent', () => {
  for (const change of ['root', 'file', 'json']) {
    const { root, data, wb } = setup();
    assert.equal(wb.operation(request(wb.preview({ revision: 1, mode: 'publish' }))).operation.state, 'applied');
    const before = wb.snapshot().writeTarget;
    if (change === 'root') {
      fs.renameSync(root, `${root}-old`);
      fs.cpSync(`${root}-old`, root, { recursive: true });
      fs.chmodSync(root, 0o700);
      fs.chmodSync(path.join(root, 'oh-my-opencode-slim'), 0o700);
      fs.chmodSync(path.join(root, '.omo-coworkers'), 0o700);
      for (const source of wb.native.data.prompts) fs.chmodSync(path.join(root, source.path), 0o600);
      fs.chmodSync(path.join(root, 'oh-my-opencode-slim.jsonc'), 0o600);
    } else if (change === 'file') {
      const file = path.join(root, 'oh-my-opencode-slim.jsonc');
      fs.copyFileSync(file, `${file}.replacement`);
      fs.renameSync(`${file}.replacement`, file);
    } else fs.renameSync(path.join(root, 'oh-my-opencode-slim.jsonc'), path.join(root, 'oh-my-opencode-slim.json'));
    const restarted = new Workbench({ root, directory: data }), p = restarted.preview({ revision: 1, mode: 'publish' });
    assert.equal(p.writeTarget.consent, 'none');
    assert.ok(p.requiredConfirmations.includes('userConsent'));
    assert.ok(p.risks.includes('targetAuthorization'));
    if (change !== 'file') assert.notEqual(p.writeTarget.targetId, before.targetId);
  }
});

test('hot mode requires internal trusted evidence and never carries cold ACP or roster changes', () => {
  const { root, data, wb } = setup();
  wb.operation(request(wb.preview({ revision: 1, mode: 'publish' })));
  const draft = wb.snapshot().draft;
  draft.roles.oracle.model = 'other/model';
  wb.save({ expectedRevision: 1, mutationId: 'mutation_2', draft });
  expectCode(() => wb.preview({ revision: 2, mode: 'hot' }), 'HOT_UNVERIFIED');
  assert.ok(wb.snapshot().capabilities.hotReasons.includes('RUNTIME_ROOT_UNVERIFIED'));
  const trusted = new Workbench({ root, directory: data, runtimeEvidence: {
    version: '3.0.8', rootBound: true, noProjectShadow: true,
    gates: { liveConfigRefresh: true, sidebar: true }, registeredEnabled: ['oracle'],
  } });
  const p = trusted.preview({ revision: 2, mode: 'hot' });
  assert.deepEqual(p.changes.map(c => c.field), ['agents.oracle.model']);
  assert.equal(p.changes[0].classification, 'hot');
  assert.equal(trusted.operation(request(p, 'operation_2')).operation.state, 'applied');
  assert.equal(trusted.snapshot().runtime.state, 'pending');
  draft.roles.oracle.model = 'third/model';
  draft.roles.claude.command = 'different-command';
  trusted.save({ expectedRevision: 2, mutationId: 'mutation_3', draft });
  expectCode(() => trusted.preview({ revision: 3, mode: 'hot' }), 'HOT_UNVERIFIED');
});
