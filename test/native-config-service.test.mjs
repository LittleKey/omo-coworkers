import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createService, defaultRoot } from '../openchamber/service/main.mjs';
import { ConfigManager } from '../openchamber/native-config/manager.mjs';

function fixture(t) {
  const base = path.resolve('.opencode/work/validation');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'service-api2-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'oh-my-opencode-slim.jsonc');
  fs.writeFileSync(file, '{"agents":{"writer":{"model":"test/old"}}}', { mode: 0o600 });
  return { root, file, manager: new ConfigManager(root) };
}
async function serve(t, root, manager) {
  const token = 'a'.repeat(48), server = createService({ token, root, manager });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return (route, body, { auth = true, method = body === undefined ? 'GET' : 'POST' } = {}) => fetch(`http://127.0.0.1:${server.address().port}${route}`, {
    method, headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function diskSnapshot(directory) {
  return Object.fromEntries(fs.readdirSync(directory).sort().map(name => {
    const full = path.join(directory, name), stat = fs.lstatSync(full);
    return [name, stat.isDirectory() ? diskSnapshot(full) : { bytes: fs.readFileSync(full).toString('base64'), mode: stat.mode, ino: stat.ino, mtime: stat.mtimeMs }];
  }));
}
const op = value => ({ resourceId: 'config', field: ['agents', 'writer', 'model'], action: 'set', value });
test('API2 finite authenticated routes; startup/status/preview read-only; no arbitrary bytes', async t => {
  const { root, manager } = fixture(t), before = diskSnapshot(root);
  const request = await serve(t, root, manager);
  assert.deepEqual(diskSnapshot(root), before);
  for (const route of ['/health', '/status', '/snapshot', '/templates', '/contributions']) assert.equal((await request(route, undefined, { auth: false })).status, 401);
  assert.equal((await request('/health')).status, 200);
  const snap = await (await request('/status')).json();
  assert.equal(snap.runtimeVerified, false);
  assert.equal((await request('/arbitrary')).status, 404);
  assert.equal((await request('/preview', {})).status, 400);
  const preview = await (await request('/preview', { revision: snap.revision, operations: [op('test/new')] })).json();
  assert.ok(preview.previewId);
  assert.deepEqual(diskSnapshot(root), before);
  assert.equal((await request('/preview', { revision: snap.revision, operations: [op('test/new')], path: '/escape' })).status, 400);
  assert.equal((await request('/config', { previewId: preview.previewId, bytes: 'bad' }, { method: 'PATCH' })).status, 400);
  assert.equal((await request('/config', { huge: 'x'.repeat(64000) }, { method: 'PATCH' })).status, 413);
  assert.deepEqual(diskSnapshot(root), before);
  assert.equal((await request('/config', { previewId: preview.previewId }, { method: 'PATCH' })).status, 200);
  assert.equal((await request('/apply', {})).status, 404);
});
test('default candidate ignores service OPENCODE_CONFIG_DIR; invalid home fails closed', () => {
  assert.equal(defaultRoot({ HOME: '/isolated', OPENCODE_CONFIG_DIR: '/not-evidence' }), '/isolated/.config/opencode');
  assert.throws(() => defaultRoot({ HOME: 'relative' }));
  assert.throws(() => defaultRoot({ HOME: '/isolated', XDG_CONFIG_HOME: 'relative' }));
});
test('pending WAL reads/previews never recover; only confirmed recovery mutates and managed drift refuses', async t => {
  const { root, file, manager } = fixture(t);
  const snap = manager.snapshot(), p = manager.preview({ revision: snap.revision, operations: [op('test/new')] });
  manager.files.inject = event => { if (event === 'after-file') throw Error('private interruption'); };
  assert.throws(() => manager.save({ previewId: p.previewId }), /RECOVERY_REQUIRED/);
  manager.files.inject = () => {};
  const request = await serve(t, root, manager), before = diskSnapshot(root);
  const status = await (await request('/status')).json();
  assert.ok(status.diagnostics.some(d => d.code === 'RECOVERY_REQUIRED'));
  // API2 allows read-only inspection/preview while WAL exists, but saving is blocked.
  const inspection = await (await request('/preview', { revision: status.revision, operations: [op('test/next')] })).json();
  assert.ok(inspection.previewId);
  assert.equal((await request('/config', { previewId: inspection.previewId }, { method: 'PATCH' })).status, 409);
  assert.deepEqual(diskSnapshot(root), before);
  assert.equal((await request('/recover', {})).status, 409);
  assert.deepEqual(diskSnapshot(root), before);
  const original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, original.replace('test/new', 'test/manual'));
  const drifted = diskSnapshot(root);
  assert.equal((await request('/recover', { confirm: true })).status, 409);
  assert.deepEqual(diskSnapshot(root), drifted);
  fs.writeFileSync(file, original);
  const recovered = await request('/recover', { confirm: true });
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).runtimeVerified, false);
  assert.match(fs.readFileSync(file, 'utf8'), /test\/old/);
  assert.ok(!fs.existsSync(path.join(root, '.omo-coworkers/manager-journal.json')));
  const lock = path.join(root, '.omo-coworkers/lock');
  const child = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
  assert.equal(child.status, 0);
  fs.writeFileSync(lock, JSON.stringify({ pid: Number(child.stdout.trim()) }), { mode: 0o600 });
  const locked = diskSnapshot(root);
  assert.ok((await (await request('/status')).json()).diagnostics.some(d => d.code === 'RECOVERY_REQUIRED'));
  assert.deepEqual(diskSnapshot(root), locked);
  assert.equal((await request('/recover', {})).status, 409);
  assert.equal((await request('/recover', { confirm: true })).status, 200);
  assert.equal(fs.existsSync(lock), false);
  for (const owner of [{ pid: process.pid }, { pid: -1 }, { unexpected: true }]) {
    fs.writeFileSync(lock, JSON.stringify(owner), { mode: 0o600 });
    const unchanged = diskSnapshot(root);
    assert.equal((await request('/recover', { confirm: true })).status, 409);
    assert.deepEqual(diskSnapshot(root), unchanged);
    fs.unlinkSync(lock);
  }
});
