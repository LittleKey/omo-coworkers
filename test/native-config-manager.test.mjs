import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ConfigManager } from '../openchamber/native-config/manager.mjs';
const base = path.resolve('.opencode/work/validation');
function fixture(t) {
  const home = fs.mkdtempSync(path.join(base, 'manager-'));
  const root = path.join(home, 'opencode'); fs.mkdirSync(root, { mode: 0o775 });
  const file = path.join(root, 'oh-my-opencode-slim.jsonc');
  fs.writeFileSync(file, '{\n// SECRET-COMMENT\n"agents":{"writer":{"model":"vendor/old","description":"ordinary text"}},"acpAgents":{"claude":{"command":"claude","env":{"TOKEN":"TOPSECRET"}}},"unknown":"UNKNOWNSECRET"}', { mode: 0o664 });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { m: new ConfigManager(root), file, root };
}
const operation = value => ({ resourceId: 'config', field: ['agents', 'writer', 'model'], action: 'set', value });
test('projection, JSONC preservation, private ancestor modes and unrelated rebase', t => {
  const { m, file } = fixture(t), snap = m.snapshot();
  for (const secret of ['TOPSECRET', 'UNKNOWNSECRET', 'SECRET-COMMENT', 'ordinary text']) assert.ok(!JSON.stringify(snap).includes(secret));
  const p = m.preview({ revision: snap.revision, operations: [operation('vendor/new')] });
  fs.appendFileSync(file, '\n// external unmanaged edit');
  const result = m.save({ previewId: p.previewId });
  m.save({ previewId: m.undoPreview({ transactionId: result.transactionId }).previewId });
  assert.match(fs.readFileSync(file, 'utf8'), /external unmanaged edit/);
  assert.match(fs.readFileSync(file, 'utf8'), /SECRET-COMMENT/);
  assert.ok(!JSON.stringify(m.state()).includes('TOPSECRET'));
});
test('known-looking fields below unknown ancestors protected; native ACP enum', t => {
  const { m, file } = fixture(t);
  fs.writeFileSync(file, '{"unknown":{"model":"NESTEDSECRET"},"acpAgents":{"claude":{"command":"claude-agent-acp"}}}');
  const snap = m.snapshot();
  assert.ok(!JSON.stringify(snap).includes('NESTEDSECRET'));
  assert.throws(() => m.preview({ revision: snap.revision, operations: [{ resourceId: 'config', field: ['unknown', 'model'], action: 'set', value: 'new' }] }), { code: 'PROTECTED_FIELD' });
  const op = value => ({ resourceId: 'config', field: ['acpAgents', 'claude', 'permissionMode'], action: 'set', value });
  assert.throws(() => m.preview({ revision: snap.revision, operations: [op('bypassPermissions')] }), { code: 'INVALID_VALUE' });
  m.save({ previewId: m.preview({ revision: snap.revision, operations: [op('reject')] }).previewId, confirmRisk: true });
});
test('permission-map union leaves and explicit prompt reveal', t => {
  const { m, file } = fixture(t);
  fs.writeFileSync(file, '{"agents":{"writer":{"permission":{"bash":"ask"},"description":"ordinary text"}},"unknown":"private"}');
  const snap = m.snapshot();
  assert.throws(() => m.reveal({ resourceId: 'config', revision: snap.revision, field: ['unknown'], confirm: true }), { code: 'PROTECTED_FIELD' });
  assert.equal(m.reveal({ resourceId: 'config', revision: snap.revision, field: ['agents', 'writer', 'description'], confirm: true }).value, 'ordinary text');
  const p = m.preview({ revision: snap.revision, operations: [{ resourceId: 'config', field: ['agents', 'writer', 'permission', 'bash'], action: 'set', value: 'allow' }] });
  m.save({ previewId: p.previewId, confirmRisk: true });
});
test('native inheritance enum rejects arbitrary existing agent', t => {
  const { m } = fixture(t);
  assert.throws(() => m.templatePreview({ revision: m.snapshot().revision, templateId: 'document-role', parameters: { inheritModelFrom: 'writer' } }), { code: 'INVALID_PARAMETERS' });
});
test('internal symlink target retained; changed target refuses', t => {
  const { m, file, root } = fixture(t);
  fs.renameSync(file, path.join(root, 'actual.jsonc')); fs.symlinkSync('actual.jsonc', file);
  const p = m.preview({ revision: m.snapshot().revision, operations: [operation('vendor/new')] });
  m.save({ previewId: p.previewId }); assert.ok(fs.lstatSync(file).isSymbolicLink());
  const q = m.preview({ revision: m.snapshot().revision, operations: [operation('vendor/next')] });
  fs.unlinkSync(file); fs.symlinkSync('../outside.jsonc', file);
  assert.throws(() => m.save({ previewId: q.previewId }));
});
test('duplicate/malformed JSONC rejected without write', t => {
  const { m, file } = fixture(t);
  for (const text of ['{"a":1,"a":2}', '{bad']) {
    fs.writeFileSync(file, text);
    const snap = m.snapshot(); assert.equal(snap.resources.length, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
});
