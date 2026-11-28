import { edit, NativeError } from './generator.mjs';
const ordinary = new Set(['explorer', 'oracle', 'designer', 'fixer', 'observer', 'document-writer', 'lark-operator']);

// Internal source-evidence classifier, not a browser assertion or runtime ACK.
// Production currently supplies no evidence: catalog snapshots cannot establish
// version, registration, effective root or project-overlay precedence.
export function classifyHot(projection, draft, evidence = null) {
  const reasons = [];
  if (evidence?.version !== '3.0.8') reasons.push('RUNTIME_VERSION_UNVERIFIED');
  if (evidence?.rootBound !== true) reasons.push('RUNTIME_ROOT_UNVERIFIED');
  if (evidence?.noProjectShadow !== true) reasons.push('PROJECT_SHADOW_UNVERIFIED');
  if (evidence?.gates?.liveConfigRefresh !== true ||
    !(evidence?.gates?.presetRouting === true || evidence?.gates?.sidebar === true))
    reasons.push('REFRESH_CONSUMER_UNVERIFIED');
  if (!Array.isArray(evidence?.registeredEnabled)) reasons.push('REGISTRATION_UNVERIFIED');
  const leaves = projection.entries.map((cell, index) => {
    const keys = cell.keys;
    const preset = keys[0] === 'presets';
    const id = preset ? keys[keys[2] === 'agents' ? 3 : 2] : keys[1];
    const field = keys.at(-1);
    const candidate = (preset || keys[0] === 'agents') &&
      ['model', 'variant'].includes(field) && ordinary.has(id) && draft.roles[id]?.enabled === true;
    const eligible = candidate && reasons.length === 0 && evidence.registeredEnabled.includes(id);
    return { index, candidate, eligible, state: eligible ? 'eligible' : 'cold' };
  });
  return { state: reasons.length ? 'unverified' : 'eligible', reasons, leaves };
}

export function hotProjection(text, projection, draft, evidence) {
  const classified = classifyHot(projection, draft, evidence);
  // Mixed batches are never silently truncated. Cold settings/content/roster
  // changes require whole publish, rather than leaking through a hot action.
  if (!projection.entries.length || classified.leaves.some(v => !v.eligible))
    throw new NativeError('HOT_UNVERIFIED');
  let output = text;
  for (let i = 0; i < projection.entries.length; i++) {
    const cell = projection.entries[i];
    output = edit(output, cell.keys, projection.changes[i].after ?? undefined);
  }
  return { ...projection, text: output,
    changes: projection.changes.map(c => ({ ...c, classification: 'hot', runtime: 'pending' })) };
}
