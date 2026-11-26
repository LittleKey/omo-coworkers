import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NativeStore, MAX_FILE_BYTES } from '../openchamber/native-config/transaction.mjs';
const base = path.resolve('.opencode/work/validation');
fs.mkdirSync(base, { recursive: true });
function fixture(t, options) {
  const root = fs.mkdtempSync(path.join(base, 'transaction-'));
  fs.chmodSync(root, 0o700);
  fs.writeFileSync(path.join(root, 'oh-my-opencode-slim.jsonc'), `{
 // personal comment
 "private":"{env:SECRET}",
 "agents":{"document-writer":{"model":"personal/writer"},"lark-operator":{"model":"personal/operator"}},
 "acpAgents":{"antigravity":{"command":"fake","permissionMode":"ask"},"claude":{"command":"fake"}}
}`, { mode: 0o600 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return new NativeStore(root, options);
}
test('cross-file apply/rollback races and read-to-rename edits never overwrite external text', t => {
  for (const rollback of [false, true]) for (const target of ['oh-my-opencode-slim/orchestrator_append.md', 'oh-my-opencode-slim.jsonc']) {
    const s = fixture(t);
    if (rollback) s.apply(s.preview().previewId);
    const preview = s.preview(rollback ? 'rollback' : 'apply');
    let fired = false;
    s.inject = (event, relative) => {
      const boundary = target.endsWith('.jsonc') ? event === 'rename' && relative === target : event === 'after-file' && relative.endsWith('.jsonc');
      if (!fired && boundary) {
        fired = true;
        fs.mkdirSync(path.dirname(path.join(s.root, target)), { recursive: true, mode: 0o700 });
        if (target.endsWith('.jsonc')) fs.appendFileSync(path.join(s.root, target), '\n// EXTERNAL');
        else fs.writeFileSync(path.join(s.root, target), 'EXTERNAL', { mode: 0o600 });
      }
    };
    assert.throws(() => s.apply(preview.previewId, rollback ? 'rollback' : 'apply'));
    assert.ok(fired);
    assert.match(fs.readFileSync(path.join(s.root, target), 'utf8'), /EXTERNAL/);
    s.inject = () => {};
    if (!target.endsWith('.jsonc')) {
      assert.throws(() => s.recover(), /DRIFT/);
      assert.equal(fs.readFileSync(path.join(s.root, target), 'utf8'), 'EXTERNAL');
    }
  }
});
test('serialized aggregate and UTF8/escaping overflow rejects before lock/WAL/native writes', t => {
  for (const body of ['x'.repeat(614400), '界'.repeat(204800), '\n'.repeat(614400)]) {
    const s = fixture(t);
    fs.mkdirSync(path.join(s.root, 'oh-my-opencode-slim'), { mode: 0o700 });
    for (const p of s.promptPaths) fs.writeFileSync(path.join(s.root, p), body, { mode: 0o600 });
    const preview = s.preview();
    assert.throws(() => s.apply(preview.previewId), /BLOCKED/);
    assert.equal(fs.existsSync(path.join(s.root, '.omo-coworkers')), false);
    for (const p of s.promptPaths) assert.equal(fs.readFileSync(path.join(s.root, p), 'utf8'), body);
  }
});
test('byte limit accepts exact boundary, rejects one byte over before write', t => {
  const s = fixture(t), relative = 'oh-my-opencode-slim/oracle_append.md';
  s.atomic(relative, '界'.repeat(Math.floor(MAX_FILE_BYTES / 3)) + 'x'.repeat(MAX_FILE_BYTES % 3));
  assert.equal(s.snapshot(relative).size, MAX_FILE_BYTES);
  const before = s.snapshot(relative);
  assert.throws(() => s.atomic(relative, 'x'.repeat(MAX_FILE_BYTES + 1)), /BLOCKED/);
  assert.deepEqual(s.snapshot(relative), before);
});
test('inverse capacity boundary: successful apply roundtrips; one byte over has zero writes', t => {
  for (const over of [false, true]) {
    const s = fixture(t), relative = s.promptPaths[0];
    fs.mkdirSync(path.dirname(path.join(s.root, relative)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(s.root, relative), '', { mode: 0o600 });
    const p = s.previews.get(s.preview().previewId);
    const record = { format: 1, id: p.id, configPath: p.input.configPath, entries: p.entries, version: s.data.manifest.version, payloadHash: p.payloadHash, phase: 'prepared', operation: 'apply' };
    // rollback committed adds three bytes over apply committed (operation name).
    const capacity = MAX_FILE_BYTES - Buffer.byteLength(JSON.stringify(record)) - 4;
    const original = '界'.repeat(Math.floor(capacity / 3)) + 'x'.repeat(capacity % 3 + Number(over));
    fs.writeFileSync(path.join(s.root, relative), original);
    let writes = 0;
    s.inject = event => { if (event === 'write') writes++; };
    if (over) {
      assert.throws(() => s.apply(s.preview().previewId), /BLOCKED/);
      assert.equal(writes, 0);
      assert.equal(fs.existsSync(path.join(s.root, '.omo-coworkers')), false);
    } else {
      s.apply(s.preview().previewId);
      // An upgrade retaining this original baseline must also remain reversible.
      const statePath = path.join(s.root, '.omo-coworkers/state.json');
      const state = JSON.parse(fs.readFileSync(statePath)); state.version = '5.9.0';
      fs.writeFileSync(statePath, JSON.stringify(state));
      s.apply(s.preview().previewId);
      const before = fs.readFileSync(statePath);
      fs.writeFileSync(path.join(s.root, '.omo-coworkers/overrides.jsonc'), JSON.stringify({ prompts: { [relative]: fs.readFileSync(path.join(s.root, relative), 'utf8') + 'x' } }), { mode: 0o600 });
      writes = 0;
      assert.throws(() => s.apply(s.preview().previewId), /BLOCKED/);
      assert.equal(writes, 0);
      assert.deepEqual(fs.readFileSync(statePath), before);
      fs.unlinkSync(path.join(s.root, '.omo-coworkers/overrides.jsonc'));
      s.apply(s.preview('rollback').previewId, 'rollback');
      assert.equal(fs.statSync(statePath).size, MAX_FILE_BYTES);
    }
    assert.equal(fs.readFileSync(path.join(s.root, relative), 'utf8'), original);
  }
});
test('format1 older content state upgrades then rolls back original baseline', t => {
  const s = fixture(t);
  const original = 'original-personal-prompt';
  fs.mkdirSync(path.join(s.root, 'oh-my-opencode-slim'), { mode: 0o700 });
  fs.writeFileSync(path.join(s.root, s.promptPaths[0]), original, { mode: 0o600 });
  s.apply(s.preview().previewId);
  const file = path.join(s.root, '.omo-coworkers/state.json');
  const state = JSON.parse(fs.readFileSync(file)); state.version = '5.9.0';
  fs.writeFileSync(file, JSON.stringify(state));
  s.apply(s.preview().previewId);
  assert.equal(JSON.parse(fs.readFileSync(file)).version, s.data.manifest.version);
  s.apply(s.preview('rollback').previewId, 'rollback');
  assert.equal(fs.readFileSync(path.join(s.root, s.promptPaths[0]), 'utf8'), original);
});
test('apply/rollback preserves unmanaged edits and stores only managed values', t => {
  const s = fixture(t), p = s.preview();
  assert.equal(s.apply(p.previewId).state, 'applied-pending-restart');
  assert.equal(s.status().diskDrift, false);
  const config = path.join(s.root, 'oh-my-opencode-slim.jsonc');
  fs.appendFileSync(config, '\n// later personal edit\n');
  const state = fs.readFileSync(path.join(s.root, '.omo-coworkers/state.json'), 'utf8');
  assert.ok(!state.includes('env:SECRET')); assert.ok(!state.includes('permissionMode'));
  const rollback = s.preview('rollback');
  assert.equal(s.apply(rollback.previewId, 'rollback').state, 'rolled-back-pending-restart');
  const restored = fs.readFileSync(config, 'utf8');
  assert.match(restored, /later personal edit/); assert.match(restored, /"permissionMode":"ask"/);
});
test('idempotent apply retains rollback baseline', t => {
  const s = fixture(t); s.apply(s.preview().previewId);
  const p = s.preview(); assert.equal(p.changes.length, 0); s.apply(p.previewId);
  s.apply(s.preview('rollback').previewId, 'rollback');
  assert.ok(!fs.existsSync(path.join(s.root, 'oh-my-opencode-slim/oracle_append.md')));
});
test('previews are expiring single use, bound to all disk input and identity', t => {
  let now = 1; const s = fixture(t, { now: () => now });
  const p = s.preview(); now += 300001; assert.throws(() => s.apply(p.previewId), /STALE_PREVIEW/);
  now = 1; const q = s.preview();
  fs.appendFileSync(path.join(s.root, 'oh-my-opencode-slim.jsonc'), '\n ');
  assert.throws(() => s.apply(q.previewId), /STALE_PREVIEW/);
  assert.throws(() => s.apply(q.previewId), /STALE_PREVIEW/);
});
test('path and independent lock safety', t => {
  const s = fixture(t); const p = s.preview();
  fs.mkdirSync(path.join(s.root, '.omo-coworkers'), { mode: 0o700 });
  fs.writeFileSync(path.join(s.root, '.omo-coworkers/lock'), 'locked', { mode: 0o600 });
  assert.throws(() => s.apply(p.previewId), /LOCKED/);
  fs.unlinkSync(path.join(s.root, '.omo-coworkers/lock'));
  const file = path.join(s.root, 'oh-my-opencode-slim.jsonc');
  fs.chmodSync(file, 0o666); assert.throws(() => s.preview(), /UNSAFE_PATH/);
  fs.chmodSync(file, 0o600);
  fs.linkSync(file, path.join(s.root, 'hardlink')); assert.throws(() => s.preview(), /UNSAFE_PATH/);
  fs.unlinkSync(path.join(s.root, 'hardlink'));
  fs.renameSync(file, file + '.original'); fs.symlinkSync(file + '.original', file);
  assert.throws(() => s.preview(), /UNSAFE_PATH/);
});
test('injected write/rename/commit failures never report success', t => {
  for (const event of ['write', 'rename', 'after-file', 'state-commit']) {
    let fired = false;
    const s = fixture(t, { inject: type => { if (type === event && !fired) { fired = true; throw new Error('injected'); } } });
    const p = s.preview();
    assert.throws(() => s.apply(p.previewId));
    assert.notEqual(s.status().state, 'applied-pending-restart');
  }
});
test('TOCTOU mutation after validation refuses before writes', t => {
  let s;
  s = fixture(t, { inject: type => { if (type === 'validated') fs.appendFileSync(path.join(s.root, 'oh-my-opencode-slim.jsonc'), '\n// race'); } });
  assert.throws(() => s.apply(s.preview().previewId), /STALE_PREVIEW/);
});
test('managed rollback drift refuses and crafted journal rejected', t => {
  const s = fixture(t); s.apply(s.preview().previewId);
  fs.appendFileSync(path.join(s.root, 'oh-my-opencode-slim/oracle_append.md'), 'drift');
  assert.throws(() => s.preview('rollback'), /DRIFT/);
  fs.writeFileSync(path.join(s.root, '.omo-coworkers/journal.json'), '{"format":1,"entries":[{"path":"../escape"}]}', { mode: 0o600 });
  assert.throws(() => s.recover(), /RECOVERY_REQUIRED/);
});
test('interrupted recovery remains blocked, then conditionally restores partial writes', t => {
  let failRecovery = true;
  const s = fixture(t, { inject: type => { if (failRecovery && type === 'after-file') throw new Error('interrupted'); } });
  assert.throws(() => s.apply(s.preview().previewId), /RECOVERY_REQUIRED/);
  assert.equal(s.status().state, 'recovery-required');
  failRecovery = false;
  assert.equal(s.recover().recovered, true);
  assert.equal(s.status().state, 'not-applied');
});
test('recovery refuses managed edits made after interrupted apply', t => {
  let fail = true;
  const s = fixture(t, { inject: type => { if (fail && type === 'after-file') throw new Error('interrupted'); } });
  assert.throws(() => s.apply(s.preview().previewId), /RECOVERY_REQUIRED/);
  fail = false;
  // Recovery has already restored config but failed its progress boundary.
  // An edit to a managed value must not be overwritten on the next recovery.
  const file = path.join(s.root, 'oh-my-opencode-slim.jsonc');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"model":"personal/writer"', '"model":"personal/writer","description":"manual"'));
  assert.throws(() => s.recover(), /DRIFT/);
  assert.equal(s.status().state, 'recovery-required');
});
test('concurrent store cannot acquire held independent lock', t => {
  const s = fixture(t), other = new NativeStore(s.root);
  const preview = other.preview();
  s.withLock(() => assert.throws(() => other.apply(preview.previewId), /LOCKED/));
});
test('every write/rename/post-rename/commit boundary fails without success claim and recovers', t => {
  const counts = {};
  const reference = fixture(t, { inject: event => { counts[event] = (counts[event] ?? 0) + 1; } });
  reference.apply(reference.preview().previewId);
  for (const event of ['write', 'rename', 'after-rename', 'after-file', 'state-commit'])
    for (let target = 1; target <= counts[event]; target++) {
      let count = 0, enabled = true;
      const s = fixture(t, { inject: type => { if (enabled && type === event && ++count === target) throw new Error('boundary-failure'); } });
      assert.throws(() => s.apply(s.preview().previewId), undefined, `${event}:${target}`);
      enabled = false;
      if (s.status().state === 'recovery-required') s.recover();
      assert.notEqual(s.status().state, 'recovery-required', `${event}:${target}`);
    }
});
test('already matching initial values are still drift protected', t => {
  const s = fixture(t);
  s.apply(s.preview().previewId);
  const statePath = path.join(s.root, '.omo-coworkers/state.json');
  fs.unlinkSync(statePath);
  s.apply(s.preview().previewId);
  fs.appendFileSync(path.join(s.root, 'oh-my-opencode-slim/oracle_append.md'), 'manual');
  assert.throws(() => s.preview(), /DRIFT/);
});
test('actual child exit leaves WAL/dead lock, new process store recovers without full backup', t => {
  const s = fixture(t);
  const module = fileURLToPath(new URL('../openchamber/native-config/transaction.mjs', import.meta.url));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { NativeStore } from ${JSON.stringify(new URL('file://' + module).href)};
    const store=new NativeStore(${JSON.stringify(s.root)}, {inject:(event,relative)=>{
      if(event==='rename' && relative==='oh-my-opencode-slim.jsonc') process.exit(77);
    }});
    store.apply(store.preview().previewId);
  `], { cwd: s.root, env: { PATH: process.env.PATH, HOME: s.root, TMPDIR: s.root }, timeout: 10000 });
  assert.equal(result.status, 77);
  const restarted = new NativeStore(s.root);
  assert.equal(restarted.status().state, 'recovery-required');
  assert.equal(restarted.recover().recovered, true);
  assert.equal(restarted.status().state, 'not-applied');
  assert.ok(!fs.readdirSync(s.root).some(name => /\.omo-[a-f0-9]{24}$/.test(name)));
});
