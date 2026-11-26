import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const jsonc = require('./vendor/jsonc-parser/main.js');
export const hash = text => crypto.createHash('sha256').update(text).digest('hex');
export class NativeError extends Error {
  constructor(code, message = code) { super(message); this.code = code; }
}
const fail = (code) => { throw new NativeError(code); };
const unsafe = new Set(['__proto__', 'prototype', 'constructor']);
export function parse(text) {
  const errors = [];
  const tree = jsonc.parseTree(text, errors, { allowTrailingComma: true });
  if (errors.length || tree?.type !== 'object') fail('INVALID_JSONC');
  function inspect(node) {
    if (node.type === 'object') {
      const keys = new Set();
      for (const property of node.children ?? []) {
        const key = property.children[0].value;
        if (unsafe.has(key) || keys.has(key)) fail('AMBIGUOUS_KEYS');
        keys.add(key);
      }
    }
    for (const child of node.children ?? []) inspect(child);
  }
  inspect(tree);
  return jsonc.getNodeValue(tree);
}
export function edit(text, path, value) {
  parse(text);
  // No formatting pass: the upstream editor otherwise reformats unrelated
  // properties sharing the insertion/removal line.
  const result = jsonc.applyEdits(text, jsonc.modify(text, path, value, {}));
  parse(result);
  return result;
}
const get = (object, path) => path.reduce((value, key) => value?.[key], object);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function payload() {
  const manifestText = fs.readFileSync(new URL('./manifest.json', import.meta.url), 'utf8');
  const manifest = parse(manifestText);
  const leafText = fs.readFileSync(new URL('./fragments/leaves.json', import.meta.url), 'utf8');
  const leaves = JSON.parse(leafText);
  const prompts = manifest.prompts.map(entry => {
    const text = fs.readFileSync(new URL(entry.source, new URL('./', import.meta.url)), 'utf8');
    if (hash(text) !== entry.sha256) fail('PAYLOAD_CHANGED');
    return { ...entry, text };
  });
  return { manifest, leaves, prompts, hash: hash(manifestText + leafText + prompts.map(p => p.text).join('')) };
}
// Pure compiler: callers own filesystem inspection, locking and transaction state.
export function generate({ config = '{}\n', prompts = {}, baseline = null, overrides = '{}', shadows = [] }) {
  const data = payload(), current = parse(config), personal = parse(overrides);
  // Resolving inherited presets is intentionally outside this compiler's
  // verified subset: do not silently miss an inherited inline/file override.
  if (current.preset && (!current.presets?.[current.preset] || current.presets[current.preset].extends)) fail('SHADOWED');
  if (Object.keys(personal).some(key => !['leaves', 'prompts', 'unmanaged'].includes(key))) fail('INVALID_OVERRIDES');
  if (shadows.length) fail('SHADOWED');
  const allowed = new Set([...data.leaves.map(l => l.path.join('.')), ...data.prompts.map(p => p.path)]);
  for (const key of Object.keys(personal.leaves ?? {})) if (!allowed.has(key) || !data.leaves.some(l => l.path.join('.') === key)) fail('INVALID_OVERRIDES');
  for (const key of Object.keys(personal.prompts ?? {})) if (!data.prompts.some(p => p.path === key)) fail('INVALID_OVERRIDES');
  if (personal.unmanaged !== undefined && (!Array.isArray(personal.unmanaged) || personal.unmanaged.some(k => !allowed.has(k)))) fail('INVALID_OVERRIDES');
  for (const name of ['document-writer', 'lark-operator']) {
    const agent = current.agents?.[name];
    const preset = current.presets?.[current.preset]?.agents?.[name] ?? current.presets?.[current.preset]?.[name];
    if (!(agent?.model || agent?.inheritModelFrom || preset?.model || preset?.inheritModelFrom)) fail('MISSING_MODEL');
  }
  for (const name of ['antigravity', 'claude']) if (typeof current.acpAgents?.[name]?.command !== 'string' || !current.acpAgents[name].command.trim()) fail('MISSING_TRANSPORT');
  const changes = [], managed = {};
  let output = config;
  function accept(key, before, after, kind, path) {
    if (personal.unmanaged?.includes(key)) return false;
    if (typeof after !== 'string' || !after.length) fail('INVALID_MANAGED_VALUE');
    if (baseline && Object.hasOwn(baseline, key) && !equal(before, baseline[key])) fail('DRIFT');
    managed[key] = after;
    if (!equal(before, after)) changes.push({ path: key, kind, action: before === undefined ? 'create' : 'update', beforeHash: before === undefined ? null : hash(before), afterHash: hash(after), before, after, leafPath: path });
    return true;
  }
  for (const leaf of data.leaves) {
    const key = leaf.path.join('.'), before = get(current, leaf.path);
    if (accept(key, before, personal.leaves?.[key] ?? leaf.value, 'leaf', leaf.path))
      output = edit(output, leaf.path, managed[key]);
  }
  const files = {};
  for (const prompt of data.prompts) {
    const name = prompt.path.split('/').at(-1).replace(/(_append)?\.md$/, '');
    for (const kind of ['prompt', 'appendPrompt'])
      if (current.agents?.[name]?.[kind] !== undefined || current.presets?.[current.preset]?.[name]?.[kind] !== undefined || current.presets?.[current.preset]?.agents?.[name]?.[kind] !== undefined) fail('SHADOWED');
    if (accept(prompt.path, prompts[prompt.path], personal.prompts?.[prompt.path] ?? prompt.text, 'prompt'))
      files[prompt.path] = managed[prompt.path];
  }
  return { config: output, files, changes, managed, payloadHash: data.hash };
}
