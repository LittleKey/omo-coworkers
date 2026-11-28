import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createService } from '../openchamber/service/main.mjs';

test('v4 HTTP preserves ACP finite settings, independent guard, and risk consent', async () => {
  const base = path.resolve('.opencode/work/workbench-fixtures');
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const root = fs.mkdtempSync(path.join(base, 'acp-http-'));
  const dataDir = fs.mkdtempSync(path.join(base, 'acp-private-'));
  const file = path.join(root, 'oh-my-opencode-slim.jsonc');
  fs.writeFileSync(file, '{"acpAgents":{"claude":{"command":"personal","permissionMode":"reject","timeoutMs":2147483647,"env":{"TOKEN":"fixture-secret"}}}}', { mode: 0o600 });
  const token = 'a'.repeat(48);
  const server = createService({ root, dataDir, token, catalog: { get: async () => ({models:[]}), dispose() {} } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const call = async (route, body, method = body ? 'POST' : 'GET') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method, headers: {authorization:['Bearer',token].join(' '),'content-type':'application/json'},
      ...(body ? {body:JSON.stringify(body)} : {}) });
    return { status:response.status, body:await response.json() };
  };
  try {
    const snapshot = (await call('/workbench')).body;
    assert.equal(snapshot.draft.roles.claude.permissionMode, 'reject');
    assert.equal(snapshot.draft.roles.claude.timeoutMs, 2147483647);
    assert.equal(JSON.stringify(snapshot).includes('fixture-secret'), false);
    const draft = snapshot.draft;
    draft.settings.allowGlobalWrites = true;
    Object.assign(draft.roles.claude, { args:['new'],cwd:'relative',permissionMode:'ask',
      behaviorEnv:{CLAUDE_CODE_DISABLE_CLAUDE_MDS:'1'},requestedVariant:'unsupported-intent' });
    assert.equal((await call('/workbench/draft', {expectedRevision:0,mutationId:'http_save_1',draft},'PATCH')).status,200);
    const preview = (await call('/workbench/preview',{revision:1,mode:'publish'})).body;
    assert.ok(preview.requiredConfirmations.includes('acpExecution'));
    assert.equal(JSON.stringify(preview).includes('fixture-secret'),false);
    const request = { operationId:'http_operation_1',previewId:preview.previewId,revision:1,
      diffDigest:preview.diffDigest,targetId:preview.writeTarget.targetId,confirmations:[] };
    assert.equal((await call('/workbench/operations',request)).status,409);
    request.confirmations=preview.requiredConfirmations;
    const applied=await call('/workbench/operations',request);
    assert.equal(applied.body.operation.state,'applied');
    assert.equal(applied.body.operation.runtime,'pending');
    const native=JSON.parse(fs.readFileSync(file));
    assert.equal(native.acpAgents.claude.env.TOKEN,'fixture-secret');
    assert.equal(native.acpAgents.claude.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS,'1');
    assert.equal(native.acpAgents.claude.requestedVariant,undefined);
    assert.deepEqual(native.acpAgents.claude.args,['new']);
    for (const route of ['/undo-preview','/recover','/intent-preview'])
      assert.equal((await call(route,{})).status,410);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
