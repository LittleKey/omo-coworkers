import test from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath, pathToFileURL } from "node:url"
import { spawnSync } from "node:child_process"

const repo = fileURLToPath(new URL("../", import.meta.url))
const host = process.env.OPENCHAMBER_WEB_ROOT

test("root extension is parser-valid and cold-loads offline without node_modules",
  { skip: !host && "set OPENCHAMBER_WEB_ROOT to installed OpenChamber 2.7.2" }, async () => {
    const root = await fs.mkdtemp(join(homedir(), ".omo-coworkers-test-"))
    try {
      const target = join(root, "extension")
      await fs.mkdir(target)
      const pkg = JSON.parse(await fs.readFile(join(repo, "package.json"), "utf8"))
      // Simulate the published payload, excluding dev fixtures and dependencies.
      await fs.writeFile(join(target, "package.json"), JSON.stringify(pkg))
      for (const name of pkg.files) await fs.cp(join(repo, name), join(target, name), { recursive: true })
      await assert.rejects(fs.stat(join(target, "node_modules")), { code: "ENOENT" })
      for (const retired of ["installer", "prompts", "oh-my-opencode-slim.json", "bin/coworkers-install.mjs"]) {
        await assert.rejects(fs.stat(join(target, retired)), { code: "ENOENT" })
      }
      assert.deepEqual(Object.keys(pkg.bin), ["supervisor-memory"])
      const { inspectGuestPackage } = await import(pathToFileURL(join(host, "server/lib/guests/catalog.js")))
      const inspected = await inspectGuestPackage(target, { openchamberVersion: "2.7.2" })
      assert.equal(inspected.ok, true, JSON.stringify(inspected))
      const { resolveOpenCodePluginFolder } = await import(pathToFileURL(join(host, "server/lib/guests/opencode-plugin.js")))
      const folder = await resolveOpenCodePluginFolder(fs, target, pkg.openchamber.contributes.opencodePlugin)
      assert.equal(folder, join(target, "openchamber/plugin"))
      const nested = JSON.parse(await fs.readFile(join(folder, "package.json"), "utf8"))
      assert.equal(nested.type, "module")
      assert.equal(pkg.openchamber.contributes.panel.entry, undefined)
      assert.deepEqual(Object.keys(pkg.openchamber.contributes).sort(), ["opencodePlugin", "panel", "skills"])
      for (const enabled of [undefined, "0", "true", "1"]) {
        const env = { ...process.env }
        delete env.OMO_COWORKERS_ENABLE_CLAUDE_GUARD
        if (enabled !== undefined) env.OMO_COWORKERS_ENABLE_CLAUDE_GUARD = enabled
        const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
          import assert from "node:assert/strict";
          import plugin from ${JSON.stringify(pathToFileURL(join(folder, nested.exports)).href)};
          let calls = 0, handler;
          const config = Object.freeze({ agents: Object.freeze({personal: true}) });
          const ctx = Object.freeze({ config, options: Object.freeze({enabled:true}),
            tool: Object.freeze({hook: async (name, cb) => {
              assert.equal(name, "execute.before"); calls++; handler = cb;
            }}) });
          await plugin.setup(ctx);
          assert.equal(calls, ${enabled === "1" ? 1 : 0});
          assert.deepEqual(config, {agents:{personal:true}});
          if (handler) {
            await handler({tool:"acp_run",input:{agent:"claude",prompt:"Read evidence."}});
            await assert.rejects(() => handler({tool:"acp_run",input:{agent:"claude",prompt:"Read.",cwd:"/elsewhere"}}));
          }
        `], { env, cwd: target, encoding: "utf8" })
        assert.equal(result.status, 0, `${enabled}: ${result.stderr || result.error}`)
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
