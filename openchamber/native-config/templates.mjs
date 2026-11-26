import { payload, parse } from './generator.mjs';

const collaborators = ['orchestrator', 'oracle', 'explorer', 'designer', 'fixer'];
const modelInheritanceSources = ['session', 'orchestrator'];
const definitions = [
  ['document-role', 'Document collaboration role', 'document-writer'],
  ['lark-role', 'Lark platform operation role', 'lark-operator'],
  ['collaboration', 'Per-agent collaboration guidance', null],
  ['claude-acp-guidance', 'Claude ACP routing and wrapper guidance', 'claude'],
  ['antigravity-acp-guidance', 'Antigravity ACP routing and wrapper guidance', 'antigravity'],
];
const fail = code => { throw Object.assign(new Error(code), { code }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => object(value) && Object.hasOwn(value, key);
const get = (value, path) => path.reduce((node, key) => own(node, key) ? node[key] : undefined, value);
const presetAgent = (config, name) => {
  const preset = get(config, ['presets', config.preset]);
  return get(preset, ['agents', name]) ?? get(preset, [name]);
};
const isRole = id => id === 'document-role' || id === 'lark-role';
const isACP = id => id.endsWith('-acp-guidance');

export function listTemplates() {
  const { manifest } = payload();
  return definitions.map(([id, description, agent]) => ({
    id, version: manifest.version, description,
    dependencies: isRole(id) ? [{ code: 'MISSING_MODEL', agent }]
      : isACP(id) ? [{ code: 'MISSING_TRANSPORT', agent }] : [],
    parameters: id === 'collaboration'
      ? { agents: { type: 'array', choices: [...collaborators], default: [...collaborators] } }
      : isRole(id) ? { inheritModelFrom: { type: 'string', choices: [...modelInheritanceSources], optional: true } } : {},
  }));
}

// Only bundled immutable sources are read. Callers own resource resolution,
// user choices, three-way comparisons and all filesystem writes.
export function composeTemplate(id, { config = {}, parameters = {}, promptContents = {} } = {}) {
  const definition = definitions.find(entry => entry[0] === id);
  if (!definition) fail('UNKNOWN_TEMPLATE');
  try {
    config = typeof config === 'string' ? parse(config) : parse(JSON.stringify(config));
  } catch { fail('INVALID_CONFIG'); }
  if (!object(parameters) || !object(promptContents) ||
      Object.values(promptContents).some(value => typeof value !== 'string')) fail('INVALID_PARAMETERS');
  const allowed = id === 'collaboration' ? ['agents'] : isRole(id) ? ['inheritModelFrom'] : [];
  if (Object.keys(parameters).some(key => !allowed.includes(key))) fail('INVALID_PARAMETERS');
  const selected = parameters.agents ?? collaborators;
  if (id === 'collaboration' && (!Array.isArray(selected) || !selected.length ||
      selected.some(name => !collaborators.includes(name)) || new Set(selected).size !== selected.length)) fail('INVALID_PARAMETERS');
  const inherit = parameters.inheritModelFrom;
  if (inherit !== undefined && !modelInheritanceSources.includes(inherit)) fail('INVALID_PARAMETERS');
  const data = payload();
  const result = { id, version: data.manifest.version, description: definition[1], changes: [], warnings: [] };
  const warn = (code, identity) => result.warnings.push({ code, ...identity });
  function field(path, value) {
    const before = get(config, path);
    const blocked = path.slice(0, -1).some((_, index) => {
      const ancestor = get(config, path.slice(0, index + 1));
      return ancestor !== undefined && !object(ancestor);
    });
    const status = blocked ? 'customized' : before === undefined ? 'create' : before === value ? 'matching' : 'customized';
    result.changes.push({ kind: 'field', path: [...path], value, status });
    if (status === 'customized') warn('PERSONAL_VALUE_PRESERVED', { field: [...path] });
  }
  function prompt(name, agent) {
    const source = data.prompts.find(entry => entry.path.split('/').at(-1) === `${name}.md`);
    if (!source) fail('PAYLOAD_CHANGED');
    const direct = get(config, ['agents', agent]);
    const preset = presetAgent(config, agent);
    const overridden = [direct, preset].some(entry =>
      own(entry, 'prompt') || own(entry, 'appendPrompt'));
    const before = own(promptContents, name) ? promptContents[name] : undefined;
    const status = overridden ? 'customized' : before === undefined ? 'create' : before === source.text ? 'matching' : 'customized';
    result.changes.push({ kind: 'prompt', name, value: source.text, status });
    if (overridden) warn('PROMPT_OVERRIDE_PRESENT', { name });
    if (status === 'customized') warn('PERSONAL_VALUE_PRESERVED', { name });
  }
  if (id === 'collaboration') {
    for (const name of selected) prompt(`${name}_append`, name);
  } else {
    const agent = definition[2];
    const root = isACP(id) ? 'acpAgents' : 'agents';
    for (const leaf of data.leaves.filter(entry => entry.path[0] === root && entry.path[1] === agent)) {
      field(leaf.path, leaf.value);
    }
    if (isRole(id)) {
      const current = get(config, ['agents', agent]);
      const preset = presetAgent(config, agent);
      const selectedPreset = get(config, ['presets', config.preset]);
      // Do not approximate native parent-preset resolution. Even empty/invalid
      // extends declarations (or an unresolved selector) require manual choice.
      const unresolvedPreset = own(config, 'preset') &&
        (!object(selectedPreset) || own(selectedPreset, 'extends'));
      const modelSet = [current, preset].some(entry =>
        ['model', 'inheritModelFrom'].some(key => typeof entry?.[key] === 'string' && entry[key].trim()));
      if (inherit !== undefined && unresolvedPreset) {
        warn('PRESET_MODEL_INHERITANCE_UNRESOLVED', {
          field: typeof config.preset === 'string' ? ['presets', config.preset, 'extends'] : ['preset'],
        });
      } else if (!modelSet && inherit !== undefined) {
        // Never replace even an invalid but explicitly supplied personal value.
        if (!own(current, 'model') && !own(current, 'inheritModelFrom') &&
            !own(preset, 'model') && !own(preset, 'inheritModelFrom')) field(['agents', agent, 'inheritModelFrom'], inherit);
        else warn('MISSING_MODEL', { field: ['agents', agent] });
      } else if (!modelSet) warn('MISSING_MODEL', { field: ['agents', agent] });
      prompt(agent, agent);
    } else if (typeof get(config, ['acpAgents', agent, 'command']) !== 'string' ||
               !get(config, ['acpAgents', agent, 'command']).trim()) {
      warn('MISSING_TRANSPORT', { field: ['acpAgents', agent, 'command'] });
    }
  }
  return result;
}
