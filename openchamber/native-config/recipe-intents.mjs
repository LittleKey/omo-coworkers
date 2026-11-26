import { listTemplates, composeTemplate } from './templates.mjs';
import { NativeError } from './generator.mjs';
import path from 'node:path';
const fail = code => { throw new NativeError(code); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const get = (o, p) => p.reduce((v, k) => v && own(v, k) ? v[k] : undefined, o);
const keys = (o, allowed, required = allowed) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every(k => allowed.includes(k)) && required.every(k => own(o, k));
const cell = v => ({ exists: v !== undefined, value: v ?? null });

export const recipeIntents = {
  templates() {
    return { ok: true, templates: listTemplates(), userTemplates: this.userTemplates().map(t => ({ id: t.id, description: t.description, version: 'user-1', parameters: {}, dependencies: [] })) };
  },
  saveUserTemplate(body) {
    if (!keys(body, ['revision', 'id', 'description', 'selection', 'copyTemplateId', 'parameters'], ['revision', 'id', 'description'])) fail('INVALID_REQUEST');
    const snap = this.currentSnapshot(body.revision), config = snap.raw.get('config');
    if (!config) fail('STALE_REVISION');
    let value;
    if (body.copyTemplateId) {
      if (body.selection !== undefined || !listTemplates().some(t => t.id === body.copyTemplateId)) fail('INVALID_REQUEST');
      composeTemplate(body.copyTemplateId, { config: config.object, parameters: body.parameters ?? {} });
      value = { id: body.id, description: body.description, baseTemplateId: body.copyTemplateId, parameters: body.parameters ?? {} };
    } else {
      if (!Array.isArray(body.selection) || !body.selection.length || body.selection.length > 32 || body.parameters !== undefined) fail('INVALID_REQUEST');
      const changes = body.selection.map(s => {
        if (!keys(s, ['resourceId', 'field']) || s.resourceId !== 'config') fail('INVALID_REQUEST');
        const value = get(config.object, s.field);
        this.checkUserSelection(s.field, value);
        return { kind: 'field', path: s.field, value };
      });
      value = { id: body.id, description: body.description, changes };
    }
    this.checkUserTemplate(value);
    const before = cell(this.userTemplates().find(t => t.id === body.id));
    if (same(before, cell(value))) fail('NO_CHANGES');
    const mutation = { target: { kind: 'user-template', templateId: body.id }, before, after: cell(value) };
    const guards = [ { target: mutation.target, expected: before } ];
    if (value.changes) for (const c of value.changes) guards.push({ target: this.target(config, c.path, 'ordinary'), expected: cell(c.value) });
    return this.registerPreview(this.delta([mutation], 'Save user recipe', guards), this.safeChanges([mutation]));
  },
  deleteUserTemplate(body) {
    if (!keys(body, ['revision', 'id'])) fail('INVALID_REQUEST');
    this.currentSnapshot(body.revision);
    const before = cell(this.userTemplates().find(t => t.id === body.id));
    if (!before.exists) fail('NO_CHANGES');
    const m = { target: { kind: 'user-template', templateId: body.id }, before, after: cell(undefined) };
    return this.registerPreview(this.delta([m], 'Delete user recipe'), this.safeChanges([m]));
  },
  templatePreview(body) {
    if (!keys(body, ['revision', 'templateId', 'parameters', 'replace'], ['revision', 'templateId']) || body.replace !== undefined && (!Array.isArray(body.replace) || body.replace.length > 32)) fail('INVALID_REQUEST');
    for (const r of body.replace ?? []) if (!keys(r, ['resourceId', 'field']) || !Array.isArray(r.field)) fail('INVALID_REQUEST');
    const snap = this.currentSnapshot(body.revision), config = snap.raw.get('config');
    if (!config) fail('STALE_REVISION');
    const promptContents = {};
    for (const r of snap.raw.values()) if (r.kind === 'prompt' && r.object !== undefined) promptContents[path.basename(r.logical, '.md')] = r.object;
    const custom = this.userTemplates().find(t => t.id === body.templateId);
    const composed = custom?.baseTemplateId
      ? composeTemplate(custom.baseTemplateId, { config: config.object, parameters: { ...custom.parameters, ...body.parameters }, promptContents })
      : custom ? { changes: custom.changes, warnings: [] }
        : composeTemplate(body.templateId, { config: config.object, parameters: body.parameters ?? {}, promptContents });
    const operations = [], conflicts = [];
    for (const c of composed.changes) {
      let r = config, field = c.path;
      if (c.kind === 'prompt') {
        if (!this.recipePromptNames.includes(c.name)) fail('INVALID_RESOURCE');
        r = [...snap.raw.values()].find(v => v.logical === `oh-my-opencode-slim/${c.name}.md`);
        if (!r) {
          const resource = this.resource(`oh-my-opencode-slim/${c.name}.md`, 'prompt');
          r = { ...resource, ...this.readResource(resource) }; snap.raw.set(r.id, r);
        }
        field = [];
      }
      const current = r.kind === 'prompt' ? r.object : get(r.object, field);
      if (same(current, c.value)) continue;
      if (current !== undefined && !(body.replace ?? []).some(v => v.resourceId === r.id && same(v.field, field))) {
        conflicts.push({ resourceId: r.id, field }); continue;
      }
      operations.push({ resourceId: r.id, field, action: 'set', value: c.value });
    }
    if (conflicts.length) { const e = new NativeError('CONFLICT'); e.conflicts = conflicts; throw e; }
    if (!operations.length) fail('NO_CHANGES');
    // Dependency identities only: do not duplicate the composer's inheritance
    // decision. Guard the model inputs for roles it actually proposes inheriting.
    const dependencies = [];
    for (const c of composed.changes) if (c.kind === 'field' && c.path[0] === 'agents' && c.path[2] === 'inheritModelFrom') {
      const agent = c.path[1], preset = config.object.preset;
      const paths = [['preset'], ...['model', 'inheritModelFrom'].map(k => ['agents', agent, k])];
      if (typeof preset === 'string') {
        paths.push(['presets', preset, 'extends']);
        for (const k of ['model', 'inheritModelFrom']) {
          paths.push(['presets', preset, 'agents', agent, k], ['presets', preset, agent, k]);
        }
      }
      for (const field of paths) {
        const value = get(config.object, field);
        dependencies.push({ target: this.target(config, field, 'ordinary'), expected: cell(value) });
      }
    }
    const result = this.preview({ revision: body.revision, operations }, true, dependencies);
    result.warnings.push(...composed.warnings.filter(w => {
      if (w.code !== 'PERSONAL_VALUE_PRESERVED') return true;
      return !operations.some(op => w.field
        ? op.resourceId === config.id && same(op.field, w.field)
        : w.name && snap.raw.get(op.resourceId)?.logical === `oh-my-opencode-slim/${w.name}.md`);
    }).map(w => w.code));
    return result;
  },
};
