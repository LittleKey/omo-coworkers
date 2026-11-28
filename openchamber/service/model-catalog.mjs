import * as disk from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const TYPE = 'rpc.omo-coworkers.catalog.v1.snapshot';
const MAX = 1024 * 1024;
const text = (s, n = 1024) => typeof s === 'string' && s.length > 0
  && s.length <= n && !/[\u0000-\u001f\u007f]/u.test(s);
const keys = (o, allowed) => o && typeof o === 'object' && !Array.isArray(o)
  && Object.keys(o).every(k => allowed.includes(k));

function snapshot(p) {
  if (!keys(p, ['version', 'publisherInstanceId', 'sequence', 'publishedAt', 'catalogRevision', 'models'])
    || p.version !== 1 || !text(p.publisherInstanceId, 128)
    || !Number.isSafeInteger(p.sequence) || p.sequence < 1
    || !Number.isSafeInteger(p.publishedAt) || p.publishedAt < 0
    || !/^[a-f0-9]{64}$/u.test(p.catalogRevision) || !Array.isArray(p.models)
    || p.models.length > 4096) return false;
  const seen = new Set();
  return p.models.every(m => {
    if (!keys(m, ['providerID', 'id', 'name', 'variants']) || !text(m.providerID)
      || !text(m.id) || (m.name !== undefined && !text(m.name))
      || !Array.isArray(m.variants) || m.variants.length > 128
      || !m.variants.every(v => text(v))) return false;
    const key = JSON.stringify([m.providerID, m.id]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function createContextCatalog({
  dataDir, env = process.env, opencodeUrl = env.OPENCHAMBER_OPENCODE_URL,
  token = env.OPENCHAMBER_SERVICE_TOKEN, fetchImpl = globalThis.fetch,
  fs = disk, now = Date.now, schedule = setTimeout, cancel = clearTimeout,
  context = null,
} = {}) {
  let directory = text(context, 4096) && path.isAbsolute(context) ? context : null;
  let epoch = 0, controller, timer, disposed = false, active = false;
  let status = directory ? 'waiting' : 'unbound', error = null, attempts = 0;
  let publisher = null, sequence = 0, forbidden = false;
  const caches = new Map();
  const pendingWrites = new Map();
  let writes = Promise.resolve();
  let writing = false, refreshPending = false;
  const uid = process.getuid?.();
  const safe = s => !s.isSymbolicLink() && (uid === undefined || s.uid === uid)
    && (s.mode & 0o022) === 0;
  async function cacheRoot() {
    if (!dataDir || !path.isAbsolute(dataDir)) throw new Error('cache');
    const root = path.resolve(dataDir);
    let current = path.parse(root).root;
    let privateAncestor = false;
    for (const part of root.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      const s = await fs.lstat(current);
      // An owner-only ancestor also protects otherwise group-writable repo
      // parents (e.g. ~/github) from traversal by other users.
      if (!s.isDirectory() || s.isSymbolicLink()
        || (!privateAncestor && (s.mode & 0o022))) throw new Error('cache');
      if (s.uid === uid && (s.mode & 0o077) === 0) privateAncestor = true;
    }
    if (!safe(await fs.lstat(root))) throw new Error('cache');
    return root;
  }
  const filename = d => `catalog-${createHash('sha256').update(d).digest('hex')}.json`;
  function remember(d, p) {
    caches.delete(d); caches.set(d, p);
    while (caches.size > 16) caches.delete(caches.keys().next().value);
  }
  function persist(d, p) {
    pendingWrites.delete(d); pendingWrites.set(d, p);
    while (pendingWrites.size > 16) pendingWrites.delete(pendingWrites.keys().next().value);
    if (writing) return;
    writing = true;
    writes = (async () => {
      while (!disposed && pendingWrites.size) {
        const [d, p] = pendingWrites.entries().next().value;
        pendingWrites.delete(d);
        let temp;
        try {
          const root = await cacheRoot();
          const target = path.join(root, filename(d));
          try {
            const s = await fs.lstat(target);
            if (!safe(s) || !s.isFile() || (s.mode & 0o077)) continue;
          } catch (e) { if (e.code !== 'ENOENT') continue; }
          temp = path.join(root, `.catalog-${randomUUID()}.tmp`);
          const h = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT
            | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          const { receivedAt, ...publicSnapshot } = p;
          try {
            await h.writeFile(JSON.stringify({ receivedAt, snapshot: publicSnapshot }));
            await h.sync();
          }
          finally { await h.close(); }
          await fs.rename(temp, target); temp = null;
          // Bound persistent contexts as well as memory, using only our fixed names.
          const names = (await fs.readdir(root)).filter(n => /^catalog-[a-f0-9]{64}\.json$/u.test(n));
          const files = [];
          for (const n of names) {
            const s = await fs.lstat(path.join(root, n));
            if (safe(s) && s.isFile()) files.push({ n, time: s.mtimeMs });
          }
          files.sort((a, b) => b.time - a.time);
          for (const f of files.slice(16)) await fs.unlink(path.join(root, f.n));
        } catch { /* Preserve the previous good cache. */ }
        finally { if (temp) await fs.unlink(temp).catch(() => {}); }
      }
    })().finally(() => { writing = false; });
  }
  function invalidate() {
    // A new host stream may represent a different upstream instance.
    caches.clear();
    epoch++; controller?.abort(); controller = undefined;
    cancel(timer); timer = undefined; active = false;
    publisher = null; sequence = 0;
    status = directory ? (caches.has(directory) ? 'stale' : 'waiting') : 'unbound';
  }
  function accept(raw, d) {
    let e;
    try { e = JSON.parse(raw); } catch { return; }
    if (!keys(e, ['id', 'created', 'type', 'location', 'data', 'metadata'])
      || !text(e.id) || !Number.isFinite(e.created) || e.type !== TYPE
      || (e.metadata !== undefined && (!e.metadata || typeof e.metadata !== 'object'
        || Array.isArray(e.metadata)))
      || !keys(e.location, ['directory']) || e.location.directory !== d
      || !snapshot(e.data)) return;
    const p = e.data;
    if (publisher && publisher !== p.publisherInstanceId) {
      status = 'ambiguous'; error = 'MULTIPLE_PUBLISHERS'; return;
    }
    if (status === 'ambiguous') return;
    publisher = p.publisherInstanceId;
    const previous = caches.get(d);
    if (p.sequence <= sequence || (previous?.publisherInstanceId === publisher
      && p.sequence <= previous.sequence)) return;
    sequence = p.sequence; attempts = 0;
    // Only the public payload and service receipt time cross the cache boundary.
    // Optional wire metadata is bounded by MAX and otherwise ignored.
    const cached = { ...p, receivedAt: now() };
    remember(d, cached); status = 'live'; error = null; persist(d, cached);
  }
  async function connect() {
    if (disposed || active || timer !== undefined || forbidden || !directory) return;
    let url;
    try {
      url = new URL(opencodeUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
        || url.search || url.hash || !text(token, 16384)) throw new Error();
      url.pathname = '/api/event'; url.searchParams.set('types', TYPE);
    } catch { status = caches.has(directory) ? 'stale' : 'unavailable'; error = 'UNAVAILABLE'; return; }
    active = true;
    const generation = epoch, d = directory;
    const abort = new AbortController(); controller = abort;
    try {
      const response = await fetchImpl(url.href, {
        method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
        signal: abort.signal, redirect: 'error',
      });
      if (generation !== epoch || disposed) return;
      if (response.status === 403 || response.status === 401) {
        caches.clear();
        forbidden = true; status = 'forbidden'; error = 'FORBIDDEN';
        await response.body?.cancel(); return;
      }
      if (!response.ok || !response.body
        || !response.headers.get('content-type')?.startsWith('text/event-stream')) throw new Error();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let line = '', data = [], event = '', bytes = 0, cr = false;
      const finishLine = () => {
        if (!line) {
          if (data.length && (!event || event === TYPE)) accept(data.join('\n'), d);
          data = []; event = ''; bytes = 0;
        } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /u, ''));
        else if (line.startsWith('event:')) event = line.slice(6).replace(/^ /u, '');
        line = '';
      };
      for await (const chunk of response.body) {
        if (disposed || generation !== epoch) return;
        const decoded = decoder.decode(chunk, { stream: true });
        for (const c of decoded) {
          if (cr && c === '\n') { cr = false; continue; }
          cr = false;
          bytes += Buffer.byteLength(c);
          if (bytes > MAX) throw new Error();
          if (c === '\r' || c === '\n') { finishLine(); cr = c === '\r'; }
          else line += c;
        }
      }
      decoder.decode();
      throw new Error();
    } catch {
      if (generation === epoch && !disposed && !forbidden) {
        caches.clear();
        if (status !== 'ambiguous') status = 'unavailable';
        error = 'STREAM_UNAVAILABLE';
      }
    } finally {
      abort.abort();
      if (generation === epoch) {
        active = false;
        if (!disposed && !forbidden) {
          timer = schedule(() => {
            invalidate(); void connect();
          }, Math.min(30_000, 1000 * 2 ** Math.min(attempts++, 5)));
          timer?.unref?.();
        }
      }
    }
  }
  return {
    setContext(d) {
      const next = text(d, 4096) && path.isAbsolute(d) ? d : null;
      if (next === directory) return;
      directory = next; invalidate(); error = null;
    },
    async get({ refresh = false } = {}) {
      // Unknown target identity means persisted snapshots are never eligible
      // for picker reuse, including same-directory process restarts.
      if (refresh && !forbidden && !disposed && !refreshPending
        && !(active && status === 'waiting')) {
        refreshPending = true;
        invalidate();
        // Coalesce callers sharing the same request turn.
        queueMicrotask(() => { refreshPending = false; });
      }
      if (!disposed) void connect();
      const p = caches.get(directory);
      if (status === 'live' && p && (now() - p.receivedAt >= 90_000
        || now() < p.receivedAt)) status = 'stale';
      return structuredClone({
        ok: true, models: p?.models ?? [], status,
        source: 'public-plugin-snapshot', fetchedAt: p?.receivedAt ?? null,
        receivedAt: p?.receivedAt ?? null, publishedAt: p?.publishedAt ?? null,
        binding: { state: 'unbound', transport: 'authorized-sse',
          location: 'unverified', nativeTarget: 'unverified' },
        catalogContext: { requestedDirectory: directory, selectionSource: 'panel-claim',
          transport: 'host-proxy', locationMatch: status === 'live',
          publisherIdentity: 'unattested' },
        runtimeBinding: { configRoot: 'unverified', applied: 'unverified' },
        refresh: { kind: 'reconnect', upstreamForced: false },
        error: error ? { code: error } : null,
      });
    },
    async dispose() {
      disposed = true; pendingWrites.clear(); invalidate(); await writes;
    },
  };
}

// Service instances are shared across pages. Never use mutable selection as
// request authority; each explicit directory gets an independent bounded lane.
export function createModelCatalog(options = {}) {
  const contexts = new Map();
  let disposed = false;
  let acquisition = Promise.resolve();
  return {
    setContext() { /* Compatibility only: get must always name its context. */ },
    async get({ directory, refresh = false } = {}) {
      const valid = text(directory, 4096) && path.isAbsolute(directory);
      if (!valid || disposed) {
        const empty = createContextCatalog({ ...options, context: null });
        await empty.dispose();
        return empty.get();
      }
      const pending = acquisition.then(async () => {
        if (disposed) return null;
        let lane = contexts.get(directory);
        if (!lane) {
          if (contexts.size >= 16) {
            const oldest = contexts.keys().next().value;
            await contexts.get(oldest).dispose(); contexts.delete(oldest);
          }
          if (disposed) return null;
          lane = createContextCatalog({ ...options, context: directory });
        }
        contexts.delete(directory); contexts.set(directory, lane);
        return lane;
      });
      acquisition = pending.then(() => {}, () => {});
      const lane = await pending;
      if (!lane) {
        const empty = createContextCatalog({ ...options, context: null });
        await empty.dispose();
        return empty.get();
      }
      return lane.get({ refresh });
    },
    async dispose() {
      disposed = true;
      await acquisition;
      await Promise.all([...contexts.values()].map(lane => lane.dispose()));
      contexts.clear();
    },
  };
}
