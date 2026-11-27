import { NativeError } from './generator.mjs';
import { composeTemplate } from './templates.mjs';
const fail = code => { throw new NativeError(code); };
const own = (o, k) => o && Object.hasOwn(o, k);
const object = o => o !== null && typeof o === 'object' && !Array.isArray(o);
const exact = (o, allowed, required = allowed) => object(o) && Object.keys(o).every(k => allowed.includes(k)) && required.every(k => own(o, k));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const cell = value => ({ exists: value !== undefined, value: value ?? null });
const names = ['claude', 'antigravity'];
const fields = ['command', 'args', 'cwd', 'wrapperModel', 'timeoutMs', 'permissionMode'];
const envKeys = ['ANTHROPIC_MODEL', 'CLAUDE_CODE_DISABLE_CLAUDE_MDS', 'CLAUDE_CODE_DISABLE_BUNDLED_SKILLS', 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS', 'CLAUDE_CODE_EFFORT_LEVEL'];
export const behaviorEnvKeys = envKeys.slice(1, 4);
const defaults = { args: [], timeoutMs: 0, permissionMode: 'ask' };
const suggestion = name => ({ command: name === 'claude' ? 'claude-agent-acp' : 'agy', args: name === 'claude' ? [] : ['acp'] });

export const acpSettings = {
  acpSnapshot(revision) {
    const snap = this.currentSnapshot(revision), config = snap.raw.get('config');
    return names.map(id => {
      const group = config?.object.acpAgents, entry = group?.[id];
      const members = config?.object.disabled_agents === undefined ? ['observer'] : config.object.disabled_agents;
      const validMembers = Array.isArray(members) && members.every(v => typeof v === 'string');
      const validAncestors = config && (group === undefined || object(group)) && (entry === undefined || object(entry)) &&
        (entry?.env === undefined || object(entry.env));
      const settings = {};
      for (const field of fields) {
        const present = Boolean(object(entry) && own(entry, field));
        let value = present ? entry[field] : defaults[field] ?? null, editable = Boolean(validAncestors), reason = null;
        if (present) {
          try { this.checkNativeValue(this.target(config, ['acpAgents', id, field], 'ordinary'), value); }
          catch { value = null; editable = false; reason = 'Protected or invalid native value.'; }
        }
        settings[field] = { present, value, editable, reason };
      }
      let contentStatus = 'blocked';
      try { if (object(entry) && typeof entry.command === 'string' && entry.command.length) contentStatus = this.contentPlan(snap, `${id}-acp-guidance`, false).status; } catch {}
      return { id, exists: entry !== undefined, editable: Boolean(validAncestors), reason: validAncestors ? null : 'Invalid or unavailable native ACP parent.',
        enabled: validMembers ? !members.includes(id) : null, membershipEditable: Boolean(validAncestors && validMembers),
        membershipReason: validMembers ? null : 'Invalid disabled_agents membership; no enabled state inferred.', settings,
        env: envKeys.map(key => {
          const present = Boolean(object(entry?.env) && own(entry.env, key));
          const canonical = present && ['1', '0'].includes(entry.env[key]);
          const supported = id === 'claude' && behaviorEnvKeys.includes(key);
          return { key, present, value: supported && canonical ? entry.env[key] : null,
            editable: Boolean(validAncestors && entry !== undefined && supported && (!present || canonical)),
            reason: !supported ? 'Dynamic ACP model/effort domain or unsupported agent; existing value preserved.' :
              present && !canonical ? 'Noncanonical existing value protected; no implicit normalization.' :
              !present ? 'No local override; inherited process environment is unknown.' : null };
        }),
        contentStatus, suggestion: suggestion(id), semantics: {
          wrapperModel: 'Wrapper LLM only; not the ACP inner model.', timeoutMs: '0 means unlimited.', cwd: 'Absent uses session directory.',
          permissionMode: 'Inner permission handling, not enabled; host spawn permission still applies.',
        } };
    });
  },
  acpGuards(config, id) {
    return [['acpAgents'], ['acpAgents', id], ['acpAgents', id, 'env']].map(field => {
      const target = this.target(config, field, 'shape');
      const expected = this.nativeCell(target);
      if (expected.value === 'invalid') fail('INVALID_CONFIG');
      return { target, expected };
    });
  },
  acpIntent(body) {
    if (!exact(body, ['revision', 'intent'])) fail('INVALID_REQUEST');
    const snap = this.currentSnapshot(body.revision), config = snap.raw.get('config'), intent = body.intent;
    if (!config || !exact(intent, ['kind', 'agentId', 'settings', 'enabled', 'behaviorEnv'], ['kind', 'agentId']) || !names.includes(intent.agentId) || !['acp-create', 'acp-settings'].includes(intent.kind)) fail('INVALID_REQUEST');
    const id = intent.agentId, guards = this.acpGuards(config, id), entry = config.object.acpAgents?.[id];
    const supplied = intent.settings ?? {};
    if (!exact(supplied, fields, []) || intent.kind === 'acp-create' && own(intent, 'enabled')) fail('INVALID_REQUEST');
    if (own(intent, 'behaviorEnv') && (intent.kind !== 'acp-settings' || id !== 'claude' || !exact(intent.behaviorEnv, behaviorEnvKeys, []))) fail('PROTECTED_FIELD');
    const mutations = [];
    const add = (field, value, category = 'ordinary', beforeOverride) => {
      const target = this.target(config, field, category);
      const before = beforeOverride ?? (field.length === 3 ? entry?.[field[2]] : undefined);
      if (same(before, value)) return;
      if (value !== undefined) this.checkNativeValue(target, value);
      mutations.push({ target, before: cell(before), after: cell(value) });
    };
    if (intent.kind === 'acp-create' && entry === undefined) {
      const value = { ...suggestion(id), timeoutMs: 0, permissionMode: 'ask', ...supplied };
      for (const key of Object.keys(value)) if (value[key] === null) delete value[key];
      const composed = composeTemplate(`${id}-acp-guidance`, { config: {} });
      for (const c of composed.changes) if (c.kind === 'field') value[c.path[2]] = c.value;
      add(['acpAgents', id], value, 'acp-entry');
    } else {
      if (entry === undefined) fail('MISSING_TRANSPORT');
      const values = intent.kind === 'acp-create' ? { ...suggestion(id), timeoutMs: 0, permissionMode: 'ask', ...supplied } : supplied;
      for (const [field, value] of Object.entries(values)) {
        if (intent.kind === 'acp-create' && own(entry, field)) continue;
        if (value === null && !['cwd', 'wrapperModel'].includes(field)) fail('INVALID_VALUE');
        add(['acpAgents', id, field], value === null ? undefined : value);
      }
      if (own(intent, 'enabled')) {
        if (typeof intent.enabled !== 'boolean') fail('INVALID_VALUE');
        const target = this.target(config, ['disabled_agents', id], 'membership'), before = this.nativeCell(target).value;
        add(target.field, !intent.enabled, 'membership', before);
      }
      for (const [key, value] of Object.entries(intent.behaviorEnv ?? {})) {
        const before = entry.env?.[key];
        if (before !== undefined && !['1', '0'].includes(before) || !['1', '0', null].includes(value)) fail('PROTECTED_FIELD');
        add(['acpAgents', id, 'env', key], value === null ? undefined : value, 'behavior-env', before);
      }
    }
    if (!mutations.length) fail('NO_CHANGES');
    const delta = this.delta(mutations, intent.kind === 'acp-create' ? 'Create or complete ACP entry' : 'ACP runtime settings');
    delta.guards.push(...guards); this.validateAcpEntries(delta);
    return this.registerPreview(delta, this.safeChanges(mutations));
  },
};
