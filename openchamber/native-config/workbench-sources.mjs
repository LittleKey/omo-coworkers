import { NativeError } from './generator.mjs';
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (v, k) => object(v) && Object.hasOwn(v, k);
const get = (v, keys) => keys.reduce((value, key) => value?.[key], v);
const fail = () => { throw new NativeError('COMPLEX_MODEL_SOURCE'); };

// Same native direct-over-selected precedence as capabilities.mjs, but all
// twelve workbench roles share it. Unselected presets/council seats are opaque.
export function modelSource(config, id, key) {
  if (config.agents !== undefined && !object(config.agents)) fail();
  const direct = ['agents', id, key], directEntry = config.agents?.[id];
  if (directEntry !== undefined && !object(directEntry)) fail();
  let inheritedPath;
  if (config.preset !== undefined) {
    if (typeof config.preset !== 'string' || !object(config.presets)) fail();
    const selected = config.presets[config.preset];
    if (!object(selected) || own(selected, 'extends') ||
      selected.agents !== undefined && !object(selected.agents)) fail();
    const nested = selected.agents?.[id], flat = selected[id];
    if (nested !== undefined && !object(nested) || flat !== undefined && !object(flat) ||
      nested !== undefined && flat !== undefined) fail();
    inheritedPath = nested !== undefined ?
      ['presets', config.preset, 'agents', id, key] : ['presets', config.preset, id, key];
    const inheritedEntry = nested ?? flat;
    if (inheritedEntry?.inheritModelFrom !== undefined) fail();
  } else if (config.presets !== undefined && !object(config.presets)) fail();
  if (directEntry?.inheritModelFrom !== undefined) fail();
  const directValue = get(config, direct), inheritedValue = inheritedPath ? get(config, inheritedPath) : undefined;
  for (const value of [directValue, inheritedValue])
    if (value !== undefined && typeof value !== 'string') fail();
  const keys = directValue !== undefined ? direct :
    inheritedValue !== undefined ? inheritedPath : direct;
  return { keys, value: directValue ?? inheritedValue, direct, inheritedPath };
}
