import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { generate } from '../openchamber/native-config/generator.mjs';
test('installed OMO 3.0.8 native schema loader and prompt reader accept exact generated content', t => {
  const installed = process.env.OMO_SLIM_PACKAGE_ROOT;
  if (!installed) return t.skip('OMO_SLIM_PACKAGE_ROOT must explicitly select installed 3.0.8');
  assert.equal(JSON.parse(fs.readFileSync(path.join(installed, 'package.json'))).version, '3.0.8');
  const base = path.resolve('.opencode/work/validation');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'parity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const generated = generate({ config: JSON.stringify({
    agents: { 'document-writer': { model: 'test/writer' }, 'lark-operator': { model: 'test/operator' } },
    acpAgents: { antigravity: { command: 'not-executed', permissionMode: 'ask' }, claude: { command: 'not-executed' } },
  }) });
  fs.writeFileSync(path.join(root, 'oh-my-opencode-slim.jsonc'), generated.config);
  for (const [relative, text] of Object.entries(generated.files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), text);
  }
  fs.writeFileSync(path.join(root, 'expected.json'), JSON.stringify({ config: JSON.parse(generated.config), files: generated.files }));
  const script = `
    import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict'; import {pathToFileURL} from 'node:url';
    const root=process.env.OPENCODE_CONFIG_DIR;
    const native=await import(pathToFileURL(${JSON.stringify(path.join(installed, 'dist/chunks/plugin-3x21gfn2.js'))}));
    const expected=JSON.parse(fs.readFileSync(path.join(root,'expected.json'),'utf8'));
    const loaded=native.loadPluginConfigFromPath(path.join(root,'oh-my-opencode-slim.jsonc'));
    assert.ok(loaded);
    for(const [name,agent] of Object.entries(expected.config.agents)) {
      assert.equal(loaded.agents[name].description,agent.description);
      assert.equal(loaded.agents[name].orchestratorPrompt,agent.orchestratorPrompt);
    }
    for(const [name,agent] of Object.entries(expected.config.acpAgents)) {
      assert.equal(loaded.acpAgents[name].prompt,agent.prompt);
      assert.equal(loaded.acpAgents[name].orchestratorPrompt,agent.orchestratorPrompt);
    }
    assert.equal(loaded.acpAgents.antigravity.permissionMode,'ask');
    for(const [relative,text] of Object.entries(expected.files)) {
      const name=path.basename(relative).replace(/(_append)?\\.md$/,'');
      const result=native.loadAgentPrompt(name);
      assert.equal(result[relative.includes('_append')?'appendPrompt':'prompt'],text);
    }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root, env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root, XDG_DATA_HOME: root, XDG_STATE_HOME: root, TMPDIR: root, OPENCODE_CONFIG_DIR: root, OMO_DISABLE_POSTHOG: '1' }, encoding: 'utf8', timeout: 10000,
  });
  fs.writeFileSync(path.join(base, 'parity-native.log'), result.stdout + result.stderr);
  assert.equal(result.status, 0, result.stderr);
});
