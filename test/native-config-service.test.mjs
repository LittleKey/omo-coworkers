import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createService, defaultRoot, confirmations, versions } from '../openchamber/service/main.mjs';
import { NativeStore } from '../openchamber/native-config/transaction.mjs';
test('finite authenticated API, explicit attestations, no startup writes', async t => {
  let calls = 0;
  const store = { status: () => ({ state: 'not-applied', runtimeVerified: false }), preview: kind => { calls++; return { ok: true, kind }; }, apply: () => { calls++; return { ok: true }; } };
  const token = 'a'.repeat(48), server = createService({ token, root: '/candidate/opencode', store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const request = (route, body, auth = true) => fetch(url + route, { method: body === undefined ? 'GET' : 'POST', headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal(calls, 0);
  assert.equal((await request('/health', undefined, false)).status, 401);
  assert.equal((await request('/health')).status, 200);
  assert.equal((await request('/status')).status, 200);
  assert.equal((await request('/arbitrary')).status, 404);
  assert.equal((await request('/preview', {})).status, 409);
  const confirmed = { confirmations: { ...Object.fromEntries(confirmations.map(k => [k, true])), versions } };
  assert.equal((await request('/preview', confirmed)).status, 200);
  assert.equal((await request('/preview', { ...confirmed, path: '/escape' })).status, 409);
  assert.equal((await request('/apply', { previewId: 'x', bytes: 'bad' })).status, 400);
  assert.equal((await request('/apply', { previewId: 'a'.repeat(32), huge: 'x'.repeat(17000) })).status, 413);
  assert.equal(calls, 1);
});
test('default candidate ignores service OPENCODE_CONFIG_DIR; invalid home fails closed', () => {
  assert.equal(defaultRoot({ HOME: '/isolated', OPENCODE_CONFIG_DIR: '/not-evidence' }), '/isolated/.config/opencode');
  assert.throws(() => defaultRoot({ HOME: 'relative' }));
});
test('journal blocks both previews without disk writes; only attested explicit recover mutates', async t => {
  const base = path.resolve('.opencode/work/validation');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'service-recovery-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'oh-my-opencode-slim.jsonc'), JSON.stringify({
    agents: { 'document-writer': { model: 'test/writer' }, 'lark-operator': { model: 'test/operator' } },
    acpAgents: { antigravity: { command: 'fake' }, claude: { command: 'fake' } },
  }), { mode: 0o600 });
  let interrupted = true;
  const store = new NativeStore(root, { inject: event => { if (interrupted && event === 'after-file') throw new Error('interrupted'); } });
  assert.throws(() => store.apply(store.preview().previewId), /RECOVERY_REQUIRED/);
  interrupted = false;
  function diskSnapshot(directory = root) {
    return Object.fromEntries(fs.readdirSync(directory).sort().map(name => {
      const full = path.join(directory, name), stat = fs.lstatSync(full);
      return [name, stat.isDirectory() ? diskSnapshot(full) : { bytes: fs.readFileSync(full).toString('base64'), mode: stat.mode, ino: stat.ino, mtime: stat.mtimeMs }];
    }));
  }
  const token = 'b'.repeat(48), server = createService({ token, root, store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = (route, body) => fetch(`http://127.0.0.1:${server.address().port}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const confirmed = { confirmations: { ...Object.fromEntries(confirmations.map(k => [k, true])), versions } };
  const before = diskSnapshot();
  assert.equal((await request('/status')).status, 200);
  assert.equal((await request('/preview', confirmed)).status, 409);
  assert.equal((await request('/rollback-preview', confirmed)).status, 409);
  assert.deepEqual(diskSnapshot(), before);
  assert.equal((await request('/recover', {})).status, 409);
  assert.deepEqual(diskSnapshot(), before);
  // A managed edit after the interrupted operation must block recovery too.
  const configPath = path.join(root, 'oh-my-opencode-slim.jsonc');
  const original = fs.readFileSync(configPath, 'utf8');
  fs.writeFileSync(configPath, original.replace('"model":"test/writer"', '"model":"test/writer","description":"manual"'));
  const drifted = diskSnapshot();
  assert.equal((await request('/recover', confirmed)).status, 409);
  assert.deepEqual(diskSnapshot(), drifted);
  fs.writeFileSync(configPath, original);
  const recovered = await request('/recover', confirmed);
  assert.equal(recovered.status, 200);
  assert.deepEqual(await recovered.json(), { ok: true, state: 'not-applied', runtimeVerified: false });
  assert.ok(!fs.existsSync(path.join(root, '.omo-coworkers/journal.json')));
  const lock = path.join(root, '.omo-coworkers/lock');
  const child = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
  assert.equal(child.status, 0);
  fs.writeFileSync(lock, JSON.stringify({ pid: Number(child.stdout.trim()) }), { mode: 0o600 });
  const locked = diskSnapshot();
  const deadStatus = await (await request('/status')).json();
  assert.equal(deadStatus.state, 'recovery-required');
  assert.equal((await request('/preview', confirmed)).status, 409);
  assert.deepEqual(diskSnapshot(), locked);
  assert.equal((await request('/recover', {})).status, 409);
  assert.equal((await request('/recover', confirmed)).status, 200);
  assert.equal(fs.existsSync(lock), false);
  for (const owner of [{ pid: process.pid }, { pid: -1 }, { unexpected: true }]) {
    fs.writeFileSync(lock, JSON.stringify(owner), { mode: 0o600 });
    const unchanged = diskSnapshot();
    assert.equal((await request('/recover', confirmed)).status, 409);
    assert.deepEqual(diskSnapshot(), unchanged);
    fs.unlinkSync(lock);
  }
});
