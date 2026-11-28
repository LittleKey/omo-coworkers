import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { NativeError } from '../native-config/generator.mjs';
import { Workbench } from '../native-config/workbench.mjs';
import { readBehaviorSettings, behaviorContributions } from './behavior-settings.mjs';
import { createModelCatalog } from './model-catalog.mjs';

export function createService({ token, root, dataDir = process.env.OPENCHAMBER_SERVICE_DATA_DIR,
  workbench = new Workbench({ root, directory: dataDir }),
  catalog = createModelCatalog({ dataDir, token }) }) {
  if (typeof token !== 'string' || token.length < 16) throw new NativeError('INVALID_TOKEN');
  const expected = Buffer.from(`Bearer ${token}`);
  const send = (res, status, value) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(value));
  };
  const retired = new Set(['GET /templates', 'POST /reveal', 'POST /preview', 'POST /template-preview', 'POST /user-templates', 'DELETE /user-templates',
    'GET /snapshot', 'GET /status', 'POST /intent-preview', 'PATCH /config', 'POST /undo-preview', 'POST /migration-preview', 'POST /recover', 'PATCH /settings']);
  const routes = new Set(['GET /models', 'GET /health', 'GET /contributions', 'GET /workbench', 'PATCH /workbench/draft',
    'POST /workbench/preview', 'POST /workbench/operations', 'POST /workbench/context', 'POST /workbench/import-native']);
  const server = http.createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? '');
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      req.resume(); return send(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', resource: null, field: null, reason: 'Authentication required.', nextAction: 'Use the host service bridge.' } });
    }
    let operationBody;
    try {
      let route = `${req.method} ${req.url}`, refresh = false, directory;
      if (req.method === 'GET' && req.url.startsWith('/models?')) {
        const query = new URLSearchParams(req.url.slice('/models?'.length));
        if ([...query.keys()].some(k => !['directory', 'refresh'].includes(k)) ||
          [...query.keys()].some(k => query.getAll(k).length !== 1) ||
          query.has('refresh') && query.get('refresh') !== 'true') throw new NativeError('INVALID_REQUEST');
        directory = query.get('directory') ?? undefined;
        if (directory !== undefined && (!path.isAbsolute(directory) || directory.length > 4096 || /[\u0000-\u001f\u007f]/u.test(directory))) throw new NativeError('INVALID_REQUEST');
        route = 'GET /models'; refresh = query.has('refresh');
      }
      if (req.method === 'GET' && /^\/workbench\/operations\/[A-Za-z0-9_-]{8,128}$/.test(req.url)) route = 'GET /workbench/operations/:id';
      if (req.method === 'POST' && /^\/workbench\/operations\/[A-Za-z0-9_-]{8,128}\/restore$/.test(req.url)) route = 'POST /workbench/operations/:id/restore';
      if (retired.has(route)) { req.resume(); return send(res, 410, { ok: false, error: { code: 'API_RETIRED', resource: null, field: null, reason: 'This editing API was retired.', nextAction: 'Use workbench API v4.' } }); }
      if (!routes.has(route) && !['GET /workbench/operations/:id', 'POST /workbench/operations/:id/restore'].includes(route)) { req.resume(); return send(res, 404, { ok: false, error: { code: 'NOT_FOUND', resource: null, field: null, reason: 'Unknown manager action.', nextAction: 'Refresh the extension.' } }); }
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
        case 'GET /health': result = { ok: true, apiVersion: 4 }; break;
        case 'GET /models': result = { ok: true, ...await catalog.get({ directory, refresh }) }; break;
        case 'GET /workbench': result = workbench.snapshot(); break;
        case 'PATCH /workbench/draft': result = workbench.save(body); break;
        case 'POST /workbench/preview': result = workbench.preview(body); break;
        case 'POST /workbench/operations': operationBody = body; result = workbench.operation(body); break;
        case 'POST /workbench/import-native': result = workbench.importNative(body); break;
        case 'GET /workbench/operations/:id': result = workbench.status(req.url.split('/').at(-1)); break;
        case 'POST /workbench/operations/:id/restore': result = workbench.restore(req.url.split('/').at(-2), body); break;
        case 'POST /workbench/context':
          if (!body || Array.isArray(body) || Object.keys(body).length !== 1 ||
            typeof body.directory !== 'string' || body.directory.length > 4096 ||
            !path.isAbsolute(body.directory) || /[\u0000-\u001f\u007f]/u.test(body.directory)) throw new NativeError('INVALID_REQUEST');
          result = { ok: true, ...await catalog.get({ directory: body.directory }) }; break;
        case 'GET /contributions': result = { ok: true, contributions: behaviorContributions({ root }), settings: readBehaviorSettings({ root }), diagnostics: [{ code: 'DUPLICATE_OBSERVABILITY_UNKNOWN', resource: null, reason: 'Standalone plugin contributions are not observable from this service.', nextAction: 'Check host contributions before enabling guard.' }] }; break;
      }
      send(res, 200, result);
    } catch (err) {
      const known = new Set(['MIGRATION_REQUIRED', 'LEGACY_RECOVERY_REQUIRED', 'INVALID_REQUEST', 'TOO_LARGE', 'CONFIRMATION_REQUIRED', 'PROTECTED_FIELD', 'INVALID_VALUE', 'REVEAL_REQUIRED', 'INVALID_RESOURCE', 'STALE_REVISION', 'STALE_PREVIEW', 'CONFLICT', 'CAPACITY', 'LOCKED', 'BUSY', 'UNSAFE_PATH', 'RECOVERY_REQUIRED', 'NO_CHANGES', 'INVALID_JSONC', 'AMBIGUOUS_KEYS', 'UNKNOWN_TEMPLATE', 'INVALID_CONFIG', 'INVALID_PARAMETERS', 'PAYLOAD_CHANGED']);
      for (const code of ['READ_ONLY', 'INLINE_CONFIRMATION_REQUIRED', 'MISSING_TRANSPORT']) known.add(code);
      for (const code of ['MUTATION_MISMATCH', 'OPERATION_MISMATCH', 'TARGET_UNVERIFIED', 'HOT_UNVERIFIED', 'NOT_FOUND', 'DRIFT', 'SHADOWED', 'COMPLEX_MODEL_SOURCE', 'PERSONAL_CONTENT_BLOCKED']) known.add(code);
      const code = known.has(err.code) ? err.code : 'IO_FAILURE';
      let disposition;
      if (operationBody && /^[A-Za-z0-9_-]{8,128}$/.test(operationBody.operationId) &&
        ['READ_ONLY', 'STALE_PREVIEW', 'CONFLICT', 'CONFIRMATION_REQUIRED', 'CAPACITY', 'RECOVERY_REQUIRED', 'INVALID_CONFIG', 'PERSONAL_CONTENT_BLOCKED', 'HOT_UNVERIFIED',
          'LOCKED', 'UNSAFE_PATH', 'LEGACY_RECOVERY_REQUIRED', 'COMPLEX_MODEL_SOURCE', 'INVALID_JSONC', 'AMBIGUOUS_KEYS', 'PAYLOAD_CHANGED'].includes(code)) {
        try {
          if (workbench.load(`operation-${operationBody.operationId}.json`) === null)
            disposition = { operationStarted: false };
        } catch { /* Cannot prove no durable operation. */ }
      }
      send(res, ['INVALID_REQUEST', 'INVALID_VALUE'].includes(code) ? 400 : code === 'NOT_FOUND' ? 404 : code === 'TOO_LARGE' ? 413 : code === 'IO_FAILURE' ? 500 : 409, {
        ok: false, error: { code, ...(disposition ? { disposition } : {}),
          resource: code === 'PERSONAL_CONTENT_BLOCKED' && workbench.native?.promptPaths.includes(err.resource) ? err.resource : null,
          field: code === 'PERSONAL_CONTENT_BLOCKED' && typeof err.field === 'string' &&
            /^(agents|acpAgents)\.[a-z-]+\.(prompt|appendPrompt|description|orchestratorPrompt)$/.test(err.field) ? err.field : null,
          reason: 'Workbench request could not be completed safely.',
          nextAction: code === 'RECOVERY_REQUIRED' ? 'Query the operation before attempting another write.' : 'Refresh state and review the requested action.' },
      });
    }
  });
  server.requestTimeout = 10000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000; server.maxHeadersCount = 32;
  server.on('close', () => catalog.dispose?.());
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
