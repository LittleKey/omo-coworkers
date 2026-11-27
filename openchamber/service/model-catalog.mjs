import { execFile } from 'node:child_process';

const TTL = 60_000;
const TIMEOUT = 5_000;
const MAX_BYTES = 1024 * 1024;
const failure = (code) => Object.assign(new Error(code), { catalogCode: code });

function runDefault(args) {
  return new Promise((resolve, reject) => {
    execFile('opencode', args, {
      shell: false, timeout: TIMEOUT, maxBuffer: MAX_BYTES, encoding: 'utf8',
      killSignal: 'SIGKILL',
    }, (error, stdout) => {
      if (error) reject(failure(error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        ? 'output-limit' : error.killed ? 'timeout' : 'cli-failed'));
      else resolve(stdout);
    });
  });
}

const component = (value) => typeof value === 'string'
  && value.length > 0 && value.length <= 1024 && !/[\s\u0000-\u001f\u007f]/u.test(value);
const modelId = (value) => component(value) && /^[^/]+\/.+$/u.test(value);

export function createModelCatalog({ runCli = runDefault, now = Date.now, context = null } = {}) {
  const caches = new Map();
  const flights = new Map();
  async function command(args, currentContext) {
    let timer;
    try {
      const output = await Promise.race([
        Promise.resolve().then(() => runCli(args, {
          timeoutMs: TIMEOUT, maxBytes: MAX_BYTES, context: currentContext,
        })),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(failure('timeout')), TIMEOUT);
        }),
      ]);
      if (typeof output !== 'string') throw failure('malformed-output');
      if (Buffer.byteLength(output) > MAX_BYTES) throw failure('output-limit');
      return output;
    } finally {
      clearTimeout(timer);
    }
  }
  const diagnostic = (phase, error) => `${phase}:${[
    'timeout', 'output-limit', 'malformed-output',
  ].includes(error?.catalogCode) ? error.catalogCode : 'cli-failed'}`;

  async function load(key) {
    const diagnostics = [];
    let catalog = [];
    const variants = Object.create(null);
    try {
      const output = await command(['models'], key);
      catalog = [...new Set(output.split(/\r?\n/u).map((s) => s.trim())
        .filter((s) => !s.startsWith('#') && modelId(s)))];
      if (!catalog.length) throw failure('malformed-output');
    } catch (error) {
      diagnostics.push(diagnostic('models', error));
    }
    if (catalog.length) {
      try {
        let parsed;
        try { parsed = JSON.parse(await command(['api', 'GET', '/api/model'], key)); }
        catch (error) {
          if (error instanceof SyntaxError) throw failure('malformed-output');
          throw error;
        }
        if (!Array.isArray(parsed?.data)) throw failure('malformed-output');
        const listed = new Set(catalog);
        for (const entry of parsed.data) {
          if (!component(entry?.providerID) || entry.providerID.includes('/')
            || !component(entry?.modelID)) continue;
          const id = `${entry.providerID}/${entry.modelID}`;
          if (!listed.has(id) || !Array.isArray(entry.variants)) continue;
          const ids = entry.variants.map((variant) => variant?.id).filter(component);
          if (ids.length) variants[id] = [...new Set([...(variants[id] || []), ...ids])];
        }
      } catch (error) {
        diagnostics.push(diagnostic('variants', error));
      }
    }
    const value = {
      catalog, variants, checkedAt: new Date(now()).toISOString(),
      provenance: 'unverified', context: { kind: 'host-cli', verified: false },
      cache: { hit: false, ttlMs: TTL }, diagnostics,
    };
    if (!diagnostics.length) {
      caches.delete(key);
      caches.set(key, { value, at: now() });
      while (caches.size > 16) caches.delete(caches.keys().next().value);
    } else caches.delete(key);
    return value;
  }
  return {
    async get({ refresh = false } = {}) {
      const key = typeof context === 'function' ? context() : context;
      // A refresh in progress takes precedence over an older cached snapshot.
      if (flights.has(key)) return structuredClone(await flights.get(key));
      const cached = caches.get(key);
      const age = cached ? now() - cached.at : Infinity;
      if (!refresh && cached && age >= 0 && age < TTL) {
        return { ...structuredClone(cached.value), cache: { hit: true, ttlMs: TTL } };
      }
      const pending = load(key).finally(() => flights.delete(key));
      flights.set(key, pending);
      return structuredClone(await pending);
    },
  };
}
