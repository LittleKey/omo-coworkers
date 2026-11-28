import path from 'node:path';
import { composeTemplate, listTemplates } from './templates.mjs';
import { parse, edit, hash, NativeError } from './generator.mjs';
const get = (v, keys) => keys.reduce((value, key) => value?.[key], v);
const fail = (field = null, resource = null) => {
  throw Object.assign(new NativeError('PERSONAL_CONTENT_BLOCKED'), { field, resource });
};

// Reuse immutable compiler authority. No private prompt content is returned or
// persisted: only absent/current-exact frozen assets are adoptable in v4.
export function planContent(store, nativeText, projectedText) {
  const native = parse(nativeText), entries = [], changes = [], assets = [];
  let text = projectedText;
  const contents = {};
  for (const source of store.data.prompts) {
    const snapshot = store.snapshot(source.path);
    if (snapshot && snapshot.hash !== hash(source.text)) fail(null, source.path);
    if (snapshot) contents[path.basename(source.path, '.md')] = source.text;
    const name = path.basename(source.path, '.md');
    const opposite = name.endsWith('_append') ? name.slice(0, -7) : `${name}_append`;
    if (store.safe(`oh-my-opencode-slim/${opposite}.md`)) fail(null, source.path);
    if (typeof native.preset === 'string') {
      if (!/^[A-Za-z0-9_.-]{1,128}$/.test(native.preset) || ['.', '..'].includes(native.preset)) fail();
      const scoped = `oh-my-opencode-slim/${native.preset}/${name}.md`;
      const scopedSnapshot = store.snapshot(scoped);
      if (scopedSnapshot && scopedSnapshot.hash !== hash(source.text) ||
        store.safe(`oh-my-opencode-slim/${native.preset}/${opposite}.md`)) fail();
    }
    assets.push({ path: source.path, beforeHash: snapshot?.hash ?? null,
      afterHash: hash(source.text), payloadHash: store.data.hash });
    if (!snapshot) {
      changes.push({ field: source.path, before: null, after: 'maintained-content', classification: 'cold' });
    }
  }
  for (const definition of listTemplates()) {
    const composed = composeTemplate(definition.id, { config: native, promptContents: contents });
    for (const c of composed.changes) {
      if (c.kind === 'prompt') {
        const agent = c.name.replace(/_append$/, '');
        const selected = native.presets?.[native.preset];
        for (const parent of [native.agents?.[agent], selected?.agents?.[agent], selected?.[agent]])
          for (const key of ['prompt', 'appendPrompt'])
            if (parent?.[key] !== undefined && parent[key] !== c.value) fail(`agents.${agent}.${key}`);
      } else {
        const before = get(native, c.path);
        if (c.status === 'customized' || before !== undefined && before !== c.value) fail(c.path.join('.'));
        // Selected preset inline fields may override the maintained definition.
        if (c.path[0] === 'agents') {
          const selected = native.presets?.[native.preset];
          for (const parent of [selected?.agents?.[c.path[1]], selected?.[c.path[1]]])
            if (parent?.[c.path[2]] !== undefined && parent[c.path[2]] !== c.value) fail(c.path.join('.'));
        }
        if (before === undefined) {
          entries.push({ keys: c.path, exists: false, value: null });
          changes.push({ field: c.path.join('.'), before: null, after: 'maintained-content', classification: 'cold' });
          text = edit(text, c.path, c.value);
        }
      }
    }
  }
  return { text, entries, changes, assets };
}

export function assetText(store, asset) {
  const source = store.data.prompts.find(p => p.path === asset.path);
  if (!source || asset.payloadHash !== store.data.hash || hash(source.text) !== asset.afterHash)
    throw new NativeError('PAYLOAD_CHANGED');
  return source.text;
}

export function assetsMatch(store, assets) {
  return assets.every(a => store.snapshot(a.path)?.hash === a.afterHash);
}
