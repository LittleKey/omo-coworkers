import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as realFs from 'node:fs/promises';
import path from 'node:path';
import { createModelCatalog } from '../openchamber/service/model-catalog.mjs';

const type = 'rpc.omo-coworkers.catalog.v1.snapshot';
const payload = (sequence = 1, publisherInstanceId = 'one') => ({
  version: 1, publisherInstanceId, sequence, publishedAt: 123,
  catalogRevision: 'a'.repeat(64),
  models: [{ providerID: 'provider', id: 'opaque/model/with/slashes',
    name: '模型', variants: ['fast'] }],
});
const envelope = (data = payload(), directory = '/selected') => ({
  id: 'event', created: 123, type, location: { directory }, data,
});
function harness(extra = {}) {
  const streams = [], calls = [], timers = new Map();
  let timerId = 0;
  const catalog = createModelCatalog({
    context: '/selected', env: {}, opencodeUrl: 'https://host.invalid',
    token: 'test-memory-only', schedule(fn) { timers.set(++timerId, fn); return timerId; },
    cancel(id) { timers.delete(id); },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const stream = new ReadableStream({ start(c) {
        streams.push(c);
        options.signal.addEventListener('abort', () => { try { c.close(); } catch {} });
      } });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    }, ...extra,
  });
  return { rawCatalog: catalog,
    catalog: { ...catalog, get: (options = {}) => catalog.get({ directory: '/selected', ...options }) },
    calls, streams, timers,
    async send(e, index = streams.length - 1) {
      const bytes = new TextEncoder().encode(`event: ${type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`);
      // One-byte chunks split multibyte UTF-8 as well as CRLF boundaries.
      for (const b of bytes) streams[index].enqueue(Uint8Array.of(b));
      await turn();
    } };
}
const turn = () => new Promise(resolve => setImmediate(resolve));

test('authorized subscription dedupes and accepts only exact location/type and strict payload', async () => {
  const h = harness();
  try {
    const [a, b] = await Promise.all([h.catalog.get(), h.catalog.get()]);
    assert.equal(a.status, 'waiting'); assert.equal(b.status, 'waiting');
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].url,
      `https://host.invalid/api/event?types=${type}`);
    assert.equal(h.calls[0].options.headers.Authorization, 'Bearer test-memory-only');
    await h.send(envelope(payload(), '/other'));
    await h.send({ ...envelope(), type: 'other' });
    await h.send(envelope({ ...payload(), secret: 'rejected' }));
    await h.send(envelope({ ...payload(), models: [{ providerID: 'p', modelID: 'alias', variants: [] }] }));
    assert.equal((await h.catalog.get()).status, 'waiting');
    await h.send(envelope());
    const live = await h.catalog.get();
    assert.equal(live.status, 'live');
    assert.equal(live.models[0].id, 'opaque/model/with/slashes');
    assert.equal(live.models[0].name, '模型');
    assert.equal(live.catalogContext.publisherIdentity, 'unattested');
    assert.equal(live.runtimeBinding.configRoot, 'unverified');
    await h.send(envelope({ ...payload(), models: [] }));
    assert.equal((await h.catalog.get()).models.length, 1, 'duplicate sequence ignored');
    await h.send(envelope(payload(2, 'two')));
    assert.equal((await h.catalog.get()).status, 'ambiguous');
    await h.send(envelope(payload(3)));
    assert.equal((await h.catalog.get()).status, 'ambiguous');
  } finally { await h.catalog.dispose(); }
  assert.equal(h.timers.size, 0);
  assert.equal(h.calls[0].options.signal.aborted, true);
});

test('refresh/disconnect invalidate unknown-target catalog eligibility and respect backoff', async () => {
  const h = harness();
  try {
    await h.catalog.get(); await h.send(envelope());
    const [refreshed] = await Promise.all([
      h.catalog.get({ refresh: true }), h.catalog.get({ refresh: true }),
    ]);
    assert.equal(refreshed.status, 'waiting');
    assert.equal(refreshed.models.length, 0);
    assert.equal(refreshed.refresh.upstreamForced, false);
    assert.equal(h.calls.length, 2);
    await h.send(envelope(payload(1, 'new')));
    assert.equal((await h.catalog.get()).status, 'live');
    h.streams.at(-1).error(new Error('do-not-return-secret'));
    await turn();
    const stale = await h.catalog.get();
    assert.equal(stale.status, 'unavailable');
    assert.equal(stale.models.length, 0);
    assert.equal(JSON.stringify(stale).includes('do-not-return-secret'), false);
    assert.equal(h.timers.size, 1);
    await h.catalog.get(); await h.catalog.get();
    assert.equal(h.calls.length, 2, 'reads must not bypass reconnect backoff');
  } finally { await h.catalog.dispose(); }
});

// Virtual filesystem: disk isolation tests create no HOME/cache/tmp artifacts.
function memoryDisk({ unsafeRoot = false } = {}) {
  const files = new Map(), modes = [];
  const root = '/private-service';
  const stat = (file, value) => ({
    uid: process.getuid?.(), mode: value?.mode ?? 0o700, size: Buffer.byteLength(value?.raw ?? ''),
    ino: 1, dev: 1, mtimeMs: 1,
    isDirectory: () => file === '/' || file === root,
    isFile: () => files.has(file),
    isSymbolicLink: () => unsafeRoot && file === root,
  });
  return { files, modes, root, fs: {
    async lstat(file) {
      if (file === '/' || file === root || files.has(file)) return stat(file, files.get(file));
      throw Object.assign(new Error(), { code: 'ENOENT' });
    },
    async open(file, flags, mode) {
      if (mode !== undefined) { modes.push(mode); files.set(file, { raw: '', mode }); }
      if (!files.has(file)) throw new Error('missing');
      return {
        stat: async () => stat(file, files.get(file)),
        readFile: async () => files.get(file).raw,
        writeFile: async raw => { files.get(file).raw = raw; },
        sync: async () => {}, close: async () => {},
      };
    },
    async rename(a, b) { files.set(b, files.get(a)); files.delete(a); },
    async readdir() { return [...files.keys()].map(f => f.slice(root.length + 1)); },
    async unlink(file) { files.delete(file); },
  } };
}

test('private cache is atomic 0600, ineligible on reload, and never includes authentication', async () => {
  const disk = memoryDisk();
  const h = harness({ fs: disk.fs, dataDir: disk.root });
  await h.catalog.get(); await h.send(envelope()); await h.catalog.dispose();
  assert.deepEqual(disk.modes, [0o600]);
  assert.equal(disk.files.size, 1);
  const raw = [...disk.files.values()][0].raw;
  assert.equal(raw.includes('test-memory-only'), false);
  assert.equal(raw.includes('/selected'), false);
  const reload = harness({ fs: disk.fs, dataDir: disk.root, token: undefined });
  try {
    const cached = await reload.catalog.get();
    assert.equal(cached.status, 'unavailable'); assert.equal(cached.models.length, 0);
    assert.equal(cached.catalogContext.locationMatch, false);
  } finally { await reload.catalog.dispose(); }
});

test('symlink root and permissive cached file are rejected without losing live data', async () => {
  const unsafe = memoryDisk({ unsafeRoot: true });
  const h = harness({ fs: unsafe.fs, dataDir: unsafe.root });
  await h.catalog.get(); await h.send(envelope());
  assert.equal((await h.catalog.get()).status, 'live');
  await h.catalog.dispose(); assert.equal(unsafe.files.size, 0);
  const disk = memoryDisk();
  const name = createHash('sha256').update('/selected').digest('hex');
  disk.files.set(`${disk.root}/catalog-${name}.json`, { raw: JSON.stringify(payload()), mode: 0o644 });
  const reload = harness({ fs: disk.fs, dataDir: disk.root, token: undefined });
  try { assert.equal((await reload.catalog.get()).models.length, 0); }
  finally { await reload.catalog.dispose(); }
});

test('403 stops reconnects and refresh; missing authorization is unavailable', async () => {
  let count = 0;
  const h = harness({ fetchImpl: async () => { count++; return new Response(null, { status: 403 }); } });
  try {
    await h.catalog.get(); await turn();
    assert.equal((await h.catalog.get({ refresh: true })).status, 'forbidden');
    assert.equal(count, 1); assert.equal(h.timers.size, 0);
  } finally { await h.catalog.dispose(); }
  const missing = harness({ token: undefined });
  try { assert.equal((await missing.catalog.get()).status, 'unavailable'); }
  finally { await missing.catalog.dispose(); }
});

test('A/B requests interleave independently; missing directory never inherits mutable selection', async () => {
  const h = harness();
  try {
    await h.catalog.get(); await h.send(envelope());
    h.catalog.setContext('/other');
    const other = await h.catalog.get({ directory: '/other' });
    assert.equal(other.models.length, 0);
    assert.equal(h.calls[0].options.signal.aborted, false);
    await h.send(envelope(payload(), '/other'));
    assert.equal((await h.catalog.get({ directory: '/other' })).status, 'live');
    assert.equal((await h.catalog.get()).catalogContext.requestedDirectory, '/selected');
    assert.equal((await h.catalog.get()).status, 'live');
    h.catalog.setContext(null);
    assert.equal((await h.rawCatalog.get()).status, 'unbound');
  } finally { await h.catalog.dispose(); }
});

test('oversized event closes epoch and removes unknown-target picker eligibility', async () => {
  const h = harness();
  try {
    await h.catalog.get(); await h.send(envelope());
    h.streams[0].enqueue(new TextEncoder().encode('data: ' + 'x'.repeat(1024 * 1024)));
    await turn();
    const result = await h.catalog.get();
    assert.equal(result.status, 'unavailable'); assert.equal(result.models.length, 0);
    assert.equal(h.calls[0].options.signal.aborted, true);
  } finally { await h.catalog.dispose(); }
});

test('actual wire optional metadata is ignored; receipt and publisher times remain distinct', async () => {
  const h = harness({ now: () => 987654 });
  try {
    await h.catalog.get();
    await h.send({ ...envelope(), metadata: { trace: 'wire-only-not-cached' } });
    const result = await h.catalog.get();
    assert.equal(result.status, 'live');
    assert.equal(result.fetchedAt, 987654);
    assert.equal(result.receivedAt, 987654);
    assert.equal(result.publishedAt, 123);
    assert.equal(JSON.stringify(result).includes('wire-only-not-cached'), false);
  } finally { await h.catalog.dispose(); }
});

test('healthy stream without publisher snapshots expires by receipt clock, not publisher clock', async () => {
  let clock = 1000;
  const h = harness({ now: () => clock });
  try {
    await h.catalog.get(); await h.send(envelope({ ...payload(), publishedAt: 999999999999 }));
    clock += 89999;
    assert.equal((await h.catalog.get()).status, 'live');
    h.streams[0].enqueue(new TextEncoder().encode(': heartbeat\n\n'));
    await turn(); clock++;
    const stale = await h.catalog.get();
    assert.equal(stale.status, 'stale');
    assert.equal(stale.catalogContext.locationMatch, false);
    assert.equal(stale.models.length, 1, 'same-stream stale references retained');
    assert.equal(h.calls.length, 1);
    await h.send(envelope(payload(2)));
    assert.equal((await h.catalog.get()).status, 'live');
  } finally { await h.catalog.dispose(); }
});

test('same directory across service generations and stream generations never reuses old picker data', async () => {
  const disk = memoryDisk();
  const first = harness({ fs: disk.fs, dataDir: disk.root });
  await first.catalog.get(); await first.send(envelope()); await first.catalog.dispose();
  const second = harness({ fs: disk.fs, dataDir: disk.root });
  try {
    const empty = await second.catalog.get();
    assert.equal(empty.models.length, 0);
    await second.send(envelope(payload(1, 'different-server')));
    assert.equal((await second.catalog.get()).status, 'live');
    second.streams[0].error(new Error('disconnected'));
    await turn();
    assert.equal((await second.catalog.get()).models.length, 0);
    const reconnect = [...second.timers.values()][0];
    reconnect(); await turn();
    assert.equal((await second.catalog.get()).models.length, 0);
    await second.send(envelope(payload(1, 'third-server')));
    assert.equal((await second.catalog.get()).status, 'live');
  } finally { await second.catalog.dispose(); }
});

test('directory subscriptions are bounded to sixteen with abort on eviction', async () => {
  const h = harness();
  try {
    for (let i = 0; i < 17; i++) await h.catalog.get({ directory: `/context-${i}` });
    assert.equal(h.calls.length, 17);
    assert.equal(h.calls.filter(c => !c.options.signal.aborted).length, 16);
    assert.equal(h.calls[0].options.signal.aborted, true);
  } finally { await h.catalog.dispose(); }
  assert.equal(h.calls.every(c => c.options.signal.aborted), true);
});

test('real private disk persists but restart never reuses unknown target; unsafe writes fail closed', async () => {
  const base = path.resolve('.opencode/work/workbench-fixtures/catalog');
  await realFs.mkdir(base, { recursive: true, mode: 0o700 });
  const root = await realFs.mkdtemp(path.join(base, 'case-'));
  const h = harness({ fs: realFs, dataDir: root, now: () => 987654 });
  try {
    await h.catalog.get();
    await h.send({ ...envelope(), metadata: { trace: 'wire-only-not-cached' } });
    await h.catalog.dispose();
    const names = await realFs.readdir(root);
    assert.equal(names.length, 1);
    const file = path.join(root, names[0]);
    assert.equal((await realFs.stat(file)).mode & 0o777, 0o600);
    const raw = await realFs.readFile(file, 'utf8');
    assert.equal(JSON.parse(raw).receivedAt, 987654);
    assert.equal(raw.includes('wire-only-not-cached'), false);
    assert.equal(raw.includes('test-memory-only'), false);
    const restart = harness({ fs: realFs, dataDir: root, token: undefined });
    try {
      const stale = await restart.catalog.get();
      assert.equal(stale.status, 'unavailable');
      assert.equal(stale.models.length, 0);
      assert.equal(stale.fetchedAt, null);
      assert.equal(stale.publishedAt, null);
    } finally { await restart.catalog.dispose(); }
    const linked = path.join(root, 'linked');
    await realFs.symlink(root, linked, 'dir');
    const symlinked = harness({ fs: realFs, dataDir: linked });
    try {
      await symlinked.catalog.get(); await symlinked.send(envelope(payload(2)));
    }
    finally { await symlinked.catalog.dispose(); }
    assert.equal(await realFs.readFile(file, 'utf8'), raw);
    // Make the existing positive cache root unsafe; loading must now reject it.
    await realFs.chmod(root, 0o777);
    const unsafe = harness({ fs: realFs, dataDir: root });
    try { await unsafe.catalog.get(); await unsafe.send(envelope(payload(3))); }
    finally { await unsafe.catalog.dispose(); await realFs.chmod(root, 0o700); }
    assert.equal(await realFs.readFile(file, 'utf8'), raw);
  } finally {
    await h.catalog.dispose();
    // Only this test's verified mkdtemp child is eligible for cleanup.
    assert.equal(path.dirname(root), base);
    assert.match(path.basename(root), /^case-/u);
    await realFs.rm(root, { recursive: true });
  }
});
