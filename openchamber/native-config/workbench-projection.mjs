import { parse, edit, NativeError } from './generator.mjs';
import { validateDraft, roleIds, initialDraft } from './workbench-state.mjs';
import { modelSource } from './workbench-sources.mjs';
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = code => { throw new NativeError(code); };
const at = (v, keys) => keys.reduce((value, key) => value?.[key], v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function importNativeDraft(text, guardEnabled = false) {
  const native = parse(text), draft = initialDraft();
  if (native.disabled_agents !== undefined && (!Array.isArray(native.disabled_agents) ||
    native.disabled_agents.some(v => typeof v !== 'string'))) fail('INVALID_CONFIG');
  for (const id of roleIds) {
    const acp = ['claude', 'antigravity'].includes(id), group = acp ? native.acpAgents : native.agents;
    if (group !== undefined && !object(group)) fail('INVALID_CONFIG');
    const entry = group?.[id], role = draft.roles[id];
    if (entry !== undefined && !object(entry)) fail('INVALID_CONFIG');
    for (const key of acp ? ['wrapperModel', 'command', 'args', 'cwd', 'permissionMode', 'timeoutMs'] : ['model', 'variant']) {
      const value = acp ? entry?.[key] : modelSource(native, id, key).value;
      if (value !== undefined) role[key] = structuredClone(value);
    }
    if (!acp && modelSource(native, id, 'model').value !== undefined &&
      modelSource(native, id, 'variant').value === undefined) delete role.variant;
    if (id === 'claude' && entry?.env !== undefined) {
      if (!object(entry.env)) fail('INVALID_CONFIG');
      role.behaviorEnv = {};
      for (const key of ['CLAUDE_CODE_DISABLE_CLAUDE_MDS', 'CLAUDE_CODE_DISABLE_BUNDLED_SKILLS', 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS'])
        if (Object.hasOwn(entry.env, key)) role.behaviorEnv[key] = entry.env[key];
    }
    role.enabled = !(native.disabled_agents ?? ['observer']).includes(id);
  }
  draft.settings.claudeGuardEnabled = guardEnabled;
  return validateDraft(draft);
}

// Finite owned leaves only. No prompt paths, provider settings, arbitrary env,
// council preset seats, or caller-supplied target paths enter this projection.
export function projectDraft(text, draft) {
  validateDraft(draft);
  // Validate pre-existing owned leaf domains before taking ownership; unknown
  // unmanaged siblings stay opaque and are never imported or rewritten.
  importNativeDraft(text);
  const native = parse(text);
  if (native.agents !== undefined && !object(native.agents) ||
      native.acpAgents !== undefined && !object(native.acpAgents) ||
      native.disabled_agents !== undefined && (!Array.isArray(native.disabled_agents) ||
        native.disabled_agents.some(v => typeof v !== 'string'))) fail('INVALID_CONFIG');
  const changes = [];
  const entries = [];
  let output = text;
  const set = (keys, after) => {
    const before = at(native, keys);
    if (same(before, after)) return;
    changes.push({ field: keys.join('.'), before: before ?? null, after: after ?? null, classification: 'cold' });
    entries.push({ keys, exists: before !== undefined, value: before ?? null });
    output = edit(output, keys, after);
  };
  for (const id of roleIds) {
    const role = draft.roles[id], isAcp = ['claude', 'antigravity'].includes(id);
    const group = isAcp ? 'acpAgents' : 'agents';
    if (native[group]?.[id] !== undefined && !object(native[group][id])) fail('INVALID_CONFIG');
    if (!isAcp) {
      if (!role.model) fail('INVALID_CONFIG');
      const model = modelSource(native, id, 'model'), variant = modelSource(native, id, 'variant');
      set(model.keys, role.model);
      if (role.variant) set(variant.keys, role.variant);
      else {
        // Fully materialized workbench "default" must not uncover a hidden
        // inherited variant when the direct override is removed.
        set(variant.direct, undefined);
        if (variant.inheritedPath) set(variant.inheritedPath, undefined);
      }
    } else {
      if (!role.command?.trim() || !role.wrapperModel ||
        !/^[^/\s]+\/[^\s]+$/u.test(role.wrapperModel) ||
        role.cwd !== undefined && !role.cwd.trim()) fail('INVALID_CONFIG');
      for (const key of ['wrapperModel', 'command', 'args', 'cwd', 'permissionMode', 'timeoutMs'])
        set([group, id, key], role[key]);
      if (native[group]?.[id]?.env !== undefined && !object(native[group][id].env)) fail('INVALID_CONFIG');
      for (const key of ['CLAUDE_CODE_DISABLE_CLAUDE_MDS', 'CLAUDE_CODE_DISABLE_BUNDLED_SKILLS', 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS']) {
        if (id === 'claude') {
          const current = native[group]?.[id]?.env?.[key];
          if (current !== undefined && !['0', '1'].includes(current)) fail('INVALID_CONFIG');
          set([group, id, 'env', key], role.behaviorEnv?.[key]);
        }
      }
    }
  }
  const members = new Set(native.disabled_agents ?? ['observer']);
  for (const id of roleIds) {
    if (draft.roles[id].enabled) members.delete(id);
    else members.add(id);
  }
  set(['disabled_agents'], [...members]);
  return { text: output, changes, entries };
}
