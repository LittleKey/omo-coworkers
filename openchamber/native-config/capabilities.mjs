import fs from 'node:fs';
import path from 'node:path';
import { composeTemplate, listTemplates } from './templates.mjs';
import { NativeError } from './generator.mjs';
const manifest = JSON.parse(fs.readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
const fail = code => { throw new NativeError(code); };
const own = (o, k) => o && Object.hasOwn(o, k);
const get = (o, p) => p.reduce((v, k) => v && own(v, k) ? v[k] : undefined, o);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const cell = value => ({ exists: value !== undefined, value: value ?? null });
const roleNames = { 'document-role': 'document-writer', 'lark-role': 'lark-operator' };
const exact = (o, allowed, required = allowed) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every(k => allowed.includes(k)) && required.every(k => own(o, k));

function source(config, agent, key) {
  const direct = ['agents', agent, key], preset = config.preset;
  let inherited, inheritedPath;
  if (preset !== undefined) {
    const selected = config.presets?.[preset];
    if (!selected || typeof selected !== 'object' || own(selected, 'extends')) return { value: typeof get(config, direct) === 'string' ? get(config, direct) : null, field: direct, source: 'unresolved', editable: false, reason: 'Complex or unresolved preset inheritance.', inheritedValue: null };
    inheritedPath = own(selected.agents, agent) ? ['presets', preset, 'agents', agent, key] : ['presets', preset, agent, key];
    inherited = get(config, inheritedPath);
  }
  const directValue = get(config, direct);
  const field = directValue !== undefined ? direct : inherited !== undefined ? inheritedPath : direct;
  const value = directValue ?? inherited;
  const inherit = get(config, ['agents', agent, 'inheritModelFrom']) ?? (preset !== undefined ? get(config, inheritedPath?.slice(0, -1).concat('inheritModelFrom') ?? []) : undefined);
  const complex = Array.isArray(value) || value !== undefined && typeof value !== 'string' || key === 'model' && inherit !== undefined;
  return { value: typeof value === 'string' ? value : null, source: field.join('.'), field, inheritedField: inheritedPath, editable: !complex, reason: complex ? 'Model chain or inherited model is read-only.' : null, inheritedValue: typeof inherited === 'string' && directValue !== undefined ? inherited : null };
}

export const capabilities = {
  capabilitySnapshot() {
    const snap = this.snapshot(), raw = this.currentSnapshot(snap.revision), config = raw.raw.get('config');
    const entries = [];
    for (const definition of listTemplates()) {
      const agent = roleNames[definition.id];
      let content = { status: 'blocked' };
      try { if (config) content = this.contentPlan(raw, definition.id, false); } catch {}
      const entry = { id: definition.id, title: definition.description, kind: agent ? 'role' : 'guidance', contentStatus: content.status,
        dependencies: manifest.capabilities[definition.id] };
      if (agent && config) {
        const members = config.object.disabled_agents ?? ['observer'];
        const model = source(config.object, agent, 'model'), variant = source(config.object, agent, 'variant');
        for (const setting of [model, variant]) {
          if (setting.value !== null) {
            try { this.checkNativeValue(this.target(config, setting.field, 'ordinary'), setting.value); }
            catch { setting.value = null; setting.editable = false; setting.reason = 'Protected native value.'; }
          }
          if (setting.inheritedValue !== null) {
            try { this.checkNativeValue(this.target(config, setting.inheritedField, 'ordinary'), setting.inheritedValue); }
            catch { setting.inheritedValue = null; setting.reason = 'Protected inherited native value.'; }
          }
        }
        delete model.field; delete variant.field; delete model.inheritedField; delete variant.inheritedField;
        entry.settings = { enabled: Array.isArray(members) && !members.includes(agent), model, variant };
      }
      entries.push(entry);
    }
    return { ok: true, revision: snap.revision, capabilities: entries, acpAgents: this.acpSnapshot(snap.revision), history: snap.history, diagnostics: snap.diagnostics, runtimeVerified: false };
  },
  contentPlan(snap, capabilityId, confirmed) {
    const config = snap.raw.get('config');
    if (!config) fail('INVALID_CONFIG');
    const promptContents = {};
    for (const r of snap.raw.values()) if (r.kind === 'prompt' && r.object !== undefined) promptContents[path.basename(r.logical, '.md')] = r.object;
    const composed = composeTemplate(capabilityId, { config: config.object, promptContents });
    const mutations = [], guards = [];
    let existing = false, inline = false;
    const add = (r, field, value, category = 'prompt') => {
      const before = r.kind === 'prompt' ? r.object : get(r.object, field);
      if (same(before, value)) return;
      if (before !== undefined) existing = true;
      mutations.push({ target: this.target(r, field, category), before: cell(before), after: cell(value) });
    };
    const agents = new Set();
    for (const c of composed.changes) {
      if (c.kind === 'field') { add(config, c.path, c.value); agents.add(`${c.path[0]}:${c.path[1]}`); }
      else {
        if (!this.recipePromptNames.includes(c.name)) fail('INVALID_RESOURCE');
        const opposite = c.name.endsWith('_append') ? c.name.slice(0, -7) : `${c.name}_append`;
        if ([...snap.raw.values()].some(r => r.kind === 'prompt' && (
          r.logical === `oh-my-opencode-slim/${opposite}.md` ||
          typeof config.object.preset === 'string' && r.logical.startsWith(`oh-my-opencode-slim/${config.object.preset}/`) &&
          [c.name, opposite].includes(path.basename(r.logical, '.md'))))) fail('READ_ONLY');
        const logical = `oh-my-opencode-slim/${c.name}.md`;
        let r = [...snap.raw.values()].find(r => r.logical === logical);
        if (!r) { const resource = this.resource(logical, 'prompt'); r = { ...resource, ...this.readResource(resource) }; }
        add(r, [], c.value);
        agents.add(`agents:${c.name.replace(/_append$/, '')}`);
      }
    }
    for (const identity of agents) {
      const [root, agent] = identity.split(':');
      const parents = [[root, agent]];
      if (root === 'agents' && typeof config.object.preset === 'string') {
        const selected = config.object.presets?.[config.object.preset];
        if (!selected || own(selected, 'extends')) fail('READ_ONLY');
        parents.push(['presets', config.object.preset, 'agents', agent], ['presets', config.object.preset, agent]);
      }
      for (const parent of parents) for (const key of ['prompt', 'appendPrompt']) {
        const field = [...parent, key], value = get(config.object, field);
        guards.push({ target: this.target(config, field, 'prompt'), expected: cell(value) });
        if (value === undefined || composed.changes.some(c => c.kind === 'field' && same(c.path, field))) continue;
        if (typeof value !== 'string') fail('INVALID_CONFIG');
        inline = true;
        if (confirmed) add(config, field, undefined);
      }
    }
    guards.push({ target: this.target(config, ['preset'], 'ordinary'), expected: cell(config.object.preset) });
    if (typeof config.object.preset === 'string') guards.push({ target: this.target(config, ['presets', config.object.preset, 'extends'], 'ordinary'), expected: cell(config.object.presets?.[config.object.preset]?.extends) });
    return { mutations, guards, inline, status: inline ? 'different' : !mutations.length ? 'matching' : existing ? 'different' : 'available' };
  },
  intentPreview(body) {
    if (!exact(body, ['revision', 'intent']) || !body.intent) fail('INVALID_REQUEST');
    const snap = this.currentSnapshot(body.revision), config = snap.raw.get('config'), intent = body.intent;
    if (!config) fail('INVALID_CONFIG');
    if (['acp-create', 'acp-settings'].includes(intent.kind)) return this.acpIntent(body);
    if (intent.kind === 'role-settings') {
      if (!exact(intent, ['kind', 'capabilityId', 'enabled', 'model', 'variant'], ['kind', 'capabilityId']) || !own(roleNames, intent.capabilityId) || !['enabled', 'model', 'variant'].some(k => own(intent, k))) fail('INVALID_REQUEST');
      const agent = roleNames[intent.capabilityId], mutations = [], guards = [];
      const add = (field, value, category = 'ordinary') => {
        const target = this.target(config, field, category);
        const before = category === 'membership' ? this.nativeCell(target).value : get(config.object, field);
        if (same(before, value)) return;
        if (value !== undefined) this.checkNativeValue(target, value);
        mutations.push({ target, before: cell(before), after: cell(value) });
      };
      if (own(intent, 'enabled')) {
        if (typeof intent.enabled !== 'boolean') fail('INVALID_VALUE');
        add(['disabled_agents', agent], !intent.enabled, 'membership');
      }
      if (own(intent, 'model') || own(intent, 'variant')) {
        const model = source(config.object, agent, 'model'), variant = source(config.object, agent, 'variant');
        if (!model.editable || !variant.editable) fail('READ_ONLY');
        if (own(intent, 'model') && (!own(intent, 'variant') || typeof intent.model !== 'string' || !intent.model.trim())) fail('INVALID_REQUEST');
        if (own(intent, 'variant') && intent.variant !== null && typeof intent.variant !== 'string') fail('INVALID_VALUE');
        if (own(intent, 'model')) add(model.field, intent.model);
        if (own(intent, 'variant')) add(variant.field, intent.variant === null ? undefined : intent.variant);
        const paths = [['preset'], ['agents', agent, 'model'], ['agents', agent, 'inheritModelFrom'], ['agents', agent, 'variant']];
        if (typeof config.object.preset === 'string') for (const field of ['model', 'variant', 'inheritModelFrom']) {
          paths.push(['presets', config.object.preset, 'agents', agent, field], ['presets', config.object.preset, agent, field]);
        }
        if (typeof config.object.preset === 'string') paths.push(['presets', config.object.preset, 'extends']);
        for (const field of paths) guards.push({ target: this.target(config, field, 'ordinary'), expected: cell(get(config.object, field)) });
        if (typeof config.object.preset === 'string') {
          const field = ['presets', config.object.preset, 'agents', agent];
          guards.push({ target: this.target(config, field, 'presence'), expected: cell(Boolean(own(get(config.object, field.slice(0, -1)), agent))) });
        }
      }
      if (!mutations.length) fail('NO_CHANGES');
      const delta = this.delta(mutations, 'Role settings'); delta.guards.push(...guards);
      return this.registerPreview(delta, this.safeChanges(mutations));
    }
    if (intent.kind === 'adopt-content') {
      if (!exact(intent, ['kind', 'capabilityId', 'confirmInlineReplacement'], ['kind', 'capabilityId']) || !listTemplates().some(t => t.id === intent.capabilityId) || own(intent, 'confirmInlineReplacement') && intent.confirmInlineReplacement !== true) fail('INVALID_REQUEST');
      const content = this.contentPlan(snap, intent.capabilityId, intent.confirmInlineReplacement === true);
      if (intent.capabilityId.endsWith('-acp-guidance')) {
        const id = intent.capabilityId.replace('-acp-guidance', ''), entry = config.object.acpAgents?.[id];
        if (!entry || typeof entry.command !== 'string' || !entry.command.length) fail('MISSING_TRANSPORT');
      }
      if (content.inline && intent.confirmInlineReplacement !== true) fail('INLINE_CONFIRMATION_REQUIRED');
      if (!content.mutations.length) fail('NO_CHANGES');
      const delta = this.delta(content.mutations, 'Adopt project content'); delta.guards.push(...content.guards);
      if (intent.capabilityId.endsWith('-acp-guidance')) {
        delta.guards.push(...this.acpGuards(config, intent.capabilityId.replace('-acp-guidance', '')));
        this.validateAcpEntries(delta);
      }
      return this.registerPreview(delta, this.safeChanges(content.mutations));
    }
    fail('INVALID_REQUEST');
  },
};
