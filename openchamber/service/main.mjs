import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { NativeStore } from '../native-config/transaction.mjs';
import { NativeError } from '../native-config/generator.mjs';
export const confirmations = ['candidateRootConfirmed', 'defaultManagedLocalHost', 'hostEnvironmentChecked', 'writerRuntimeDisabled', 'oldWriterStopped', 'workPaused', 'managedBeforeValuesContainNoSecrets'];
export const versions = { omo: '3.0.8', opencode: '2.4.2', openchamber: '2.8.0' };
const exact = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length === keys.length && Object.keys(o).every(k => keys.includes(k));
function confirm(body) {
  if (!exact(body, ['confirmations']) || !exact(body.confirmations, [...confirmations, 'versions']) || confirmations.some(k => body.confirmations[k] !== true)) throw new NativeError('CONFIRMATION_REQUIRED');
  if (!exact(body.confirmations.versions, Object.keys(versions)) || Object.entries(versions).some(([k, v]) => body.confirmations.versions[k] !== v)) throw new NativeError('UNSUPPORTED_VERSION');
}
export function createService({ token, root, store = new NativeStore(root) }) {
  if (typeof token !== 'string' || token.length < 16) throw new NativeError('INVALID_TOKEN');
  const expected = Buffer.from(`Bearer ${token}`);
  const send = (response, status, value) => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    response.end(JSON.stringify(value));
  };
  const server = http.createServer(async (request, response) => {
    const supplied = Buffer.from(request.headers.authorization ?? '');
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      request.resume(); return send(response, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'UNAUTHORIZED' } });
    }
    try {
      const route = `${request.method} ${request.url}`;
      if (!['GET /health', 'GET /status', 'POST /preview', 'POST /apply', 'POST /rollback-preview', 'POST /rollback', 'POST /recover'].includes(route)) {
        request.resume(); return send(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'NOT_FOUND' } });
      }
      let text = '', size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 16384) throw new NativeError('TOO_LARGE');
        text += chunk.toString('utf8');
      }
      if (request.method === 'GET' && size) throw new NativeError('INVALID_REQUEST');
      let body;
      if (request.method === 'POST') {
        if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new NativeError('INVALID_REQUEST');
        try { body = JSON.parse(text); } catch { throw new NativeError('INVALID_REQUEST'); }
      }
      if (route === 'GET /health') return send(response, 200, { ok: true, apiVersion: 1 });
      if (route === 'GET /status') return send(response, 200, {
        ok: true, apiVersion: 1, candidateRoot: root, requiredConfirmations: confirmations,
        supportedVersions: versions, ...store.status(),
      });
      if (route === 'POST /recover') {
        confirm(body);
        store.recover();
        return send(response, 200, { ok: true, state: store.status().state, runtimeVerified: false });
      }
      if (route.endsWith('/preview') || route.endsWith('/rollback-preview')) {
        confirm(body);
        return send(response, 200, store.preview(route.endsWith('/rollback-preview') ? 'rollback' : 'apply'));
      }
      if (!exact(body, ['previewId']) || typeof body.previewId !== 'string' || !/^[a-f0-9]{32}$/.test(body.previewId)) throw new NativeError('INVALID_REQUEST');
      return send(response, 200, store.apply(body.previewId, route.endsWith('/rollback') ? 'rollback' : 'apply'));
    } catch (error) {
      const known = new Set(['INVALID_REQUEST', 'TOO_LARGE', 'CONFIRMATION_REQUIRED', 'UNSUPPORTED_VERSION', 'BLOCKED', 'DRIFT', 'STALE_PREVIEW', 'LOCKED', 'UNSAFE_PATH', 'RECOVERY_REQUIRED', 'SHADOWED', 'MISSING_MODEL', 'MISSING_TRANSPORT', 'INVALID_JSONC', 'AMBIGUOUS_KEYS', 'INVALID_OVERRIDES', 'INVALID_MANAGED_VALUE', 'PAYLOAD_CHANGED']);
      const code = known.has(error.code) ? error.code : 'IO_FAILURE';
      const status = code === 'INVALID_REQUEST' ? 400 : code === 'TOO_LARGE' ? 413 : code === 'IO_FAILURE' ? 500 : 409;
      send(response, status, { ok: false, error: { code, message: code } });
    }
  });
  server.requestTimeout = 10000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000; server.maxHeadersCount = 32;
  return server;
}
export function defaultRoot(env) {
  if (!env.HOME || !path.isAbsolute(env.HOME) || (env.XDG_CONFIG_HOME && !path.isAbsolute(env.XDG_CONFIG_HOME))) throw new NativeError('BLOCKED');
  // OPENCODE_CONFIG_DIR here is NOT evidence about the managed child process.
  return path.join(env.XDG_CONFIG_HOME || path.join(env.HOME, '.config'), 'opencode');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new NativeError('INVALID_PORT');
  createService({ token: process.env.OPENCHAMBER_SERVICE_TOKEN, root: defaultRoot(process.env) }).listen(port, '127.0.0.1');
}
