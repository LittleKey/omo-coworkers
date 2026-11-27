import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ConfigManager, exactKeys } from '../native-config/manager.mjs';
import { NativeError } from '../native-config/generator.mjs';
import { readBehaviorSettings, updateBehaviorSettings, behaviorContributions } from './behavior-settings.mjs';
import { createModelCatalog } from './model-catalog.mjs';

export function createService({ token, root, manager = new ConfigManager(root), catalog = createModelCatalog() }) {
  if (typeof token !== 'string' || token.length < 16) throw new NativeError('INVALID_TOKEN');
  const expected = Buffer.from(`Bearer ${token}`);
  const send = (res, status, value) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(value));
  };
  const retired = new Set(['GET /templates', 'POST /reveal', 'POST /preview', 'POST /template-preview', 'POST /user-templates', 'DELETE /user-templates']);
  const routes = new Set(['GET /models', 'GET /health', 'GET /snapshot', 'GET /status', 'GET /contributions', 'POST /intent-preview', 'PATCH /config', 'POST /undo-preview', 'POST /migration-preview', 'POST /recover', 'PATCH /settings']);
  const server = http.createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? '');
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      req.resume(); return send(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', resource: null, field: null, reason: 'Authentication required.', nextAction: 'Use the host service bridge.' } });
    }
    try {
      let route = `${req.method} ${req.url}`, refresh = false;
      if (req.method === 'GET' && req.url.startsWith('/models?')) {
        const query = new URLSearchParams(req.url.slice('/models?'.length));
        if ([...query.keys()].length !== 1 || query.get('refresh') !== 'true' || query.getAll('refresh').length !== 1) throw new NativeError('INVALID_REQUEST');
        route = 'GET /models'; refresh = true;
      }
      if (retired.has(route)) { req.resume(); return send(res, 410, { ok: false, error: { code: 'API_RETIRED', resource: null, field: null, reason: 'This editing API was retired.', nextAction: 'Upgrade to capability API v3.' } }); }
      if (!routes.has(route)) { req.resume(); return send(res, 404, { ok: false, error: { code: 'NOT_FOUND', resource: null, field: null, reason: 'Unknown manager action.', nextAction: 'Refresh the extension.' } }); }
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 63000) throw new NativeError('TOO_LARGE'); chunks.push(chunk); }
      if (req.method === 'GET' && size) throw new NativeError('INVALID_REQUEST');
      let body;
      if (req.method !== 'GET') {
        if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new NativeError('INVALID_REQUEST');
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new NativeError('INVALID_REQUEST'); }
      }
      let result;
      switch (route) {
        case 'GET /health': result = { ok: true, apiVersion: 3 }; break;
        case 'GET /models': result = { ok: true, ...await catalog.get({ refresh }) }; break;
        case 'GET /snapshot': case 'GET /status': result = manager.capabilitySnapshot(); break;
        case 'POST /intent-preview': result = manager.intentPreview(body); break;
        case 'PATCH /config': result = manager.save(body); break;
        case 'POST /undo-preview': result = manager.undoPreview(body); break;
        case 'POST /migration-preview': result = manager.migrationPreview(body); break;
        case 'POST /recover': result = manager.recover(body); break;
        case 'GET /contributions': result = { ok: true, contributions: behaviorContributions({ root }), settings: readBehaviorSettings({ root }), diagnostics: [{ code: 'DUPLICATE_OBSERVABILITY_UNKNOWN', resource: null, reason: 'Standalone plugin contributions are not observable from this service.', nextAction: 'Check host contributions before enabling guard.' }] }; break;
        case 'PATCH /settings':
          if (!exactKeys(body, ['revision', 'claudeGuardEnabled', 'confirmEnable'], ['revision', 'claudeGuardEnabled'])) throw new NativeError('INVALID_REQUEST');
          result = { ok: true, settings: updateBehaviorSettings({ root, ...body }), runtimeVerified: false }; break;
      }
      send(res, 200, result);
    } catch (err) {
      const known = new Set(['MIGRATION_REQUIRED', 'LEGACY_RECOVERY_REQUIRED', 'INVALID_REQUEST', 'TOO_LARGE', 'CONFIRMATION_REQUIRED', 'PROTECTED_FIELD', 'INVALID_VALUE', 'REVEAL_REQUIRED', 'INVALID_RESOURCE', 'STALE_REVISION', 'STALE_PREVIEW', 'CONFLICT', 'CAPACITY', 'LOCKED', 'BUSY', 'UNSAFE_PATH', 'RECOVERY_REQUIRED', 'NO_CHANGES', 'INVALID_JSONC', 'AMBIGUOUS_KEYS', 'UNKNOWN_TEMPLATE', 'INVALID_CONFIG', 'INVALID_PARAMETERS', 'PAYLOAD_CHANGED']);
      for (const code of ['READ_ONLY', 'INLINE_CONFIRMATION_REQUIRED', 'MISSING_TRANSPORT']) known.add(code);
      const code = known.has(err.code) ? err.code : 'IO_FAILURE';
      const diagnostic = manager.diagnostic(code, err.resource ?? null);
      send(res, code === 'INVALID_REQUEST' ? 400 : code === 'TOO_LARGE' ? 413 : code === 'IO_FAILURE' ? 500 : 409, {
        ok: false, error: { code, resource: err.resource ?? null, field: err.field ?? null, reason: code === 'CONFLICT' ? 'Only affected fields changed externally.' : diagnostic.reason, nextAction: code === 'BUSY' ? 'Inspect the dedicated behavior-settings lock locally; config recovery does not reclaim it.' : diagnostic.nextAction },
        ...(err.conflicts ? { conflicts: err.conflicts } : {}),
      });
    }
  });
  server.requestTimeout = 10000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000; server.maxHeadersCount = 32;
  return server;
}
export function defaultRoot(env) {
  if (!env.HOME || !path.isAbsolute(env.HOME) || env.XDG_CONFIG_HOME && !path.isAbsolute(env.XDG_CONFIG_HOME)) throw new NativeError('UNSAFE_PATH');
  return path.join(env.XDG_CONFIG_HOME || path.join(env.HOME, '.config'), 'opencode');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new NativeError('INVALID_PORT');
  createService({ token: process.env.OPENCHAMBER_SERVICE_TOKEN, root: defaultRoot(process.env) }).listen(port, '127.0.0.1');
}
