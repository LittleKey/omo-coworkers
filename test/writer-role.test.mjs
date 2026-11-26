import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { setupWriterRole } from "../openchamber/plugin/writer-role.mjs"
import plugin from "../openchamber/plugin/index.mjs"

const root = new URL("../openchamber/plugin/roles/", import.meta.url)
const writer = await readFile(new URL("document-writer.md", root), "utf8")
const routing = JSON.parse(await readFile(new URL("routing.json", root), "utf8"))
const audience = (await readFile(new URL("audience.md", root), "utf8")).trimEnd()
const oracle = (await readFile(new URL("oracle-line.txt", root), "utf8")).trimEnd()
// Verified public rule literals only, not a user's composed/private configuration.
const oldAudience = `# Audience and dispatch

- Default audience: software developer; avoid teaching familiar basics.
- Dispatch in the recipient's working language with readable sources, constraints and expected output; send only missing context/deltas to continuing sessions. Claude's dedicated routing specifies its transport and output contract.
- Use document-writer for formal-document wording.`
const oldRouting = "Use document-writer for formal documents: MODE: WRITE for creation/body edits; MODE: REVIEW for document review. Reuse a suitable writer for revisions, never to independently review its own output. Keep internal plans/state in the main session; independent platform work goes to lark-operator. Follow the main-session review policy."
const oldOracle = "- Tie findings to the inspected version, coverage and limits; include severity, location and evidence/gap. Send purely editorial formal-document issues to document-writer unless meaning changes."

function agents() {
  return {
    "document-writer": {
      id: "document-writer", name: "Writer", mode: "subagent", hidden: true,
      system: "Old writer", description: "old", model: { provider: "fixture", id: "fixture" },
      variant: "fixture", request: { temperature: 0.2 }, permissions: [{ tool: "*", action: "deny" }],
      skills: ["fixture-skill"], custom: { retained: true },
    },
    orchestrator: { id: "orchestrator", mode: "primary", system: "# Main\n\nUnrelated instructions.\n", permissions: ["fixture"] },
    oracle: { id: "oracle", mode: "subagent", system: "Read only.\n", model: "fixture" },
    unrelated: { id: "unrelated", system: "Do not touch", custom: true },
  }
}
function editorFor(state) {
  const updates = []
  return {
    updates,
    get: id => state[id],
    update(id, cb) {
      updates.push(id)
      assert.ok(state[id], "must not upsert")
      cb(state[id])
    },
    default() { assert.fail("must not change default") },
    remove() { assert.fail("must not remove roles") },
  }
}
async function register(t, ctx = {}) {
  const warnings = []
  t.mock.method(console, "warn", text => warnings.push(text))
  let transform
  await setupWriterRole({ agent: { transform: cb => { transform = cb } }, ...ctx })
  return { warnings, run: state => { const editor = editorFor(state); transform(editor); return editor.updates }, callback: () => transform }
}

test("four payloads retain frozen hashes", async () => {
  for (const [name, hash] of [
    ["document-writer.md", "36ef44de293053e5fbeb743851d63ba5c9965a85c78147e2b40dacc50f71fd9d"],
    ["routing.json", "9de5fb6d0ee5244e6398424326620ef557bfc478beef8a793d36d5f1186da115"],
    ["audience.md", "0e5c2d7a7ad22309dab93659b43224f7000143219813356712179c532f5c67a3"],
    ["oracle-line.txt", "1cbc333a6b9d0b6a2c868fa1bb3191d369f9c8a4b68f18b2e83c202aa58b0c28"],
  ]) {
    assert.equal(createHash("sha256").update(await readFile(new URL(name, root))).digest("hex"), hash)
  }
})

test("native layout, exact writer bytes and only authorized fields; replay is idempotent", async t => {
  const state = agents(), before = structuredClone(state)
  const { run, warnings } = await register(t)
  assert.deepEqual(run(state), ["document-writer", "orchestrator", "oracle"])
  assert.equal(state["document-writer"].system, writer)
  assert.equal(state["document-writer"].description, routing.description)
  const restored = structuredClone(state)
  restored["document-writer"].system = before["document-writer"].system
  restored["document-writer"].description = before["document-writer"].description
  restored.orchestrator.system = before.orchestrator.system
  restored.oracle.system = before.oracle.system
  assert.deepEqual(restored, before)
  assert.ok(state.orchestrator.system.startsWith(before.orchestrator.system))
  assert.ok(state.orchestrator.system.includes(audience))
  assert.ok(state.orchestrator.system.includes(routing.orchestratorPrompt))
  assert.ok(state.oracle.system.includes(oracle))
  assert.equal(state.Audience, undefined)
  assert.equal(state["Audience and dispatch"], undefined)
  const applied = structuredClone(state)
  assert.deepEqual(run(state), ["document-writer"])
  assert.deepEqual(state, applied)
  assert.deepEqual(warnings, [])
})

test("all three system strings are byte-identical on replay and fresh equivalent setup", async t => {
  const first = agents(), fresh = agents()
  const systems = state => Object.fromEntries(["document-writer", "orchestrator", "oracle"].map(id => [id, Buffer.from(state[id].system)]))
  const a = await register(t)
  a.run(first)
  const bytes = systems(first)
  a.run(first)
  assert.deepEqual(systems(first), bytes)
  const b = await register(t)
  b.run(fresh)
  assert.deepEqual(systems(fresh), bytes)
  b.run(fresh)
  assert.deepEqual(systems(fresh), bytes)
})

test("composed old Audience + project-specific paragraph and Oracle line migrate in place", async t => {
  const state = agents()
  const prefix = "# Main\n\nKeep main instructions.\n\n"
  const middle = "\n\n# Search tools\n\nKeep search rules.\n\n# Project-specific routing guidance\n\nKeep another role route.\n\n"
  const suffix = "\n\nKeep final rule.\n"
  state.orchestrator.system = prefix + oldAudience + middle + oldRouting + suffix
  state.oracle.system = "Read only.\n" + oldOracle + "\nRe-review prior findings.\n"
  const { run, warnings } = await register(t)
  run(state)
  assert.equal(state.orchestrator.system, prefix + audience + middle + routing.orchestratorPrompt + suffix)
  assert.equal(state.oracle.system, "Read only.\n" + oracle + "\nRe-review prior findings.\n")
  assert.deepEqual(warnings, [])
})

test("R1-F1: single-LF routing/Audience heading boundaries migrate exactly once and replay unchanged", async t => {
  const { run, warnings } = await register(t)
  for (const [route, brief] of [[oldRouting, oldAudience], [routing.orchestratorPrompt, audience]]) {
    for (const adjacent of [false, true]) {
      const state = agents()
      const prefix = adjacent ? "# Project-specific routing guidance\n" : ""
      const suffix = adjacent ? "\n# Search tools\nKeep unrelated search rules.\n" : "\n"
      state.orchestrator.system = prefix + route + "\n" + brief + suffix
      const before = structuredClone(state)
      run(state)
      assert.equal(state.orchestrator.system, prefix + routing.orchestratorPrompt + "\n" + audience + suffix)
      assert.equal(state.orchestrator.system.split(routing.orchestratorPrompt).length - 1, 1)
      assert.equal(state.orchestrator.system.includes(oldRouting), false)
      const restored = structuredClone(state)
      restored["document-writer"].system = before["document-writer"].system
      restored["document-writer"].description = before["document-writer"].description
      restored.orchestrator.system = before.orchestrator.system
      restored.oracle.system = before.oracle.system
      assert.deepEqual(restored, before)
      const after = structuredClone(state)
      assert.deepEqual(run(state), ["document-writer"])
      assert.deepEqual(state, after)
    }
  }
  assert.deepEqual(warnings, [])
})

test("already migrated exact slots are unchanged; undefined native systems append", async t => {
  const { run } = await register(t)
  const state = agents()
  state.orchestrator.system = audience + "\n\n# Routing\n\n" + routing.orchestratorPrompt + "\n"
  state.oracle.system = oracle + "\n"
  assert.deepEqual(run(state), ["document-writer"])
  state.orchestrator.system = undefined
  state.oracle.system = undefined
  run(state)
  assert.equal(state.orchestrator.system, routing.orchestratorPrompt + "\n\n" + audience + "\n")
  assert.equal(state.oracle.system, oracle + "\n")
})

test("terminal legacy/new Audience without routing inserts before heading and replays unchanged", async t => {
  const { run, warnings } = await register(t)
  for (const existing of [oldAudience, audience]) {
    const state = agents()
    const prefix = "# Main\n\nKeep these unrelated bytes.  \n\n"
    const suffix = "\n\n\n"
    state.orchestrator.system = prefix + existing + suffix
    run(state)
    assert.equal(state.orchestrator.system, prefix + routing.orchestratorPrompt + "\n\n" + audience + suffix)
    const after = structuredClone(state)
    assert.deepEqual(run(state), ["document-writer"])
    assert.deepEqual(state, after)
  }
  assert.deepEqual(warnings, [])
})

test("routing inserted before a terminal heading is independent even without a preceding blank line", async t => {
  const { run, warnings } = await register(t)
  const state = agents()
  state.orchestrator.system = "Keep prior line.\n" + oldAudience + "\n"
  run(state)
  assert.equal(state.orchestrator.system, "Keep prior line.\n\n" + routing.orchestratorPrompt + "\n\n" + audience + "\n")
  const after = structuredClone(state)
  run(state)
  assert.deepEqual(state, after)
  assert.deepEqual(warnings, [])
})

test("missing, removed, disabled and incompatible writer never create or add routing", async t => {
  const { run, warnings } = await register(t)
  for (const kind of ["missing", "disabled", "primary", "no-mode"]) {
    const state = agents()
    if (kind === "missing") delete state["document-writer"]
    if (kind === "disabled") state["document-writer"].disabled = true
    if (kind === "primary") state["document-writer"].mode = "primary"
    if (kind === "no-mode") delete state["document-writer"].mode
    const before = structuredClone(state)
    assert.deepEqual(run(state), [])
    assert.deepEqual(state, before)
  }
  const state = agents()
  run(state)
  delete state["document-writer"] // Removed by an upstream transform on the next replay.
  const before = structuredClone(state)
  assert.deepEqual(run(state), [])
  assert.deepEqual(state, before)
  assert.ok(warnings.some(x => x.includes("WRITER_PREREQUISITE_MISSING")))
  assert.ok(warnings.some(x => x.includes("WRITER_MODE_INCOMPATIBLE")))
})

test("all mode is allowed, hidden is preserved; absent routing targets are not created", async t => {
  const state = agents()
  state["document-writer"].mode = "all"
  delete state.orchestrator
  delete state.oracle
  const { run, warnings } = await register(t)
  assert.deepEqual(run(state), ["document-writer"])
  assert.equal(state["document-writer"].hidden, true)
  assert.equal(state.orchestrator, undefined)
  assert.equal(state.oracle, undefined)
  assert.equal(warnings.filter(x => x.includes("ROUTING_TARGET_ABSENT")).length, 2)
})

test("every predictable routing conflict results in zero updates across all roles", async t => {
  const { run, warnings } = await register(t)
  const cases = [
    ["orchestrator", oldAudience + "\n\n" + oldAudience],
    ["orchestrator", oldAudience + "\n\n" + audience],
    ["orchestrator", "# Audience and dispatch\n\nCustom rules.\n"],
    ["orchestrator", oldAudience + "\nCustom addition.\n"],
    ["orchestrator", oldRouting + "\n\n" + oldRouting],
    ["orchestrator", oldRouting + "\n\n" + routing.orchestratorPrompt],
    ["orchestrator", routing.orchestratorPrompt + "\n\n" + routing.orchestratorPrompt],
    ["orchestrator", "Custom prefix " + oldRouting],
    ["orchestrator", "Use document-writer differently."],
    ["orchestrator", "```md\nUnfinished example"],
    ["orchestrator", { secret: "must not log" }],
    ["oracle", oldOracle + "\n" + oldOracle],
    ["oracle", oldOracle + "\n" + oracle],
    ["oracle", oracle + "\n" + oracle],
    ["oracle", "Custom prefix " + oldOracle],
    ["oracle", "Use document-writer differently."],
    ["oracle", "~~~text\nUnfinished example"],
    ["oracle", ["secret must not log"]],
  ]
  for (const [id, value] of cases) {
    const state = agents()
    state[id].system = value
    const before = structuredClone(state)
    assert.deepEqual(run(state), [], id + ": zero mutations required")
    assert.deepEqual(state, before)
  }
  assert.ok(warnings.some(x => x.includes("ROUTING_CONFLICT")))
  assert.ok(warnings.every(x => !x.includes("secret") && !x.includes(oldRouting)))
})

test("fenced examples with legacy headings, lines and custom writer mentions remain inert", async t => {
  const { run } = await register(t)
  const state = agents()
  const example = "```md\n" + oldAudience + "\n\n" + oldRouting + "\nCustom document-writer rule\n```\n\n"
  const tilde = "~~~text\n" + oldOracle + "\nCustom document-writer rule\n~~~\n\n"
  state.orchestrator.system = example + oldAudience + "\n\n# Routing\n\n" + oldRouting + "\n"
  state.oracle.system = tilde + oldOracle + "\n"
  run(state)
  assert.equal(state.orchestrator.system, example + audience + "\n\n# Routing\n\n" + routing.orchestratorPrompt + "\n")
  assert.equal(state.oracle.system, tilde + oracle + "\n")
})

test("missing API, invalid editor, registration failure diagnose without disclosing input", async t => {
  const warnings = []
  t.mock.method(console, "warn", text => warnings.push(text))
  const config = Object.freeze({ agents: Object.freeze({ personal: true }) })
  await setupWriterRole(Object.freeze({ config }))
  await setupWriterRole({ agent: { transform: cb => cb({}) } })
  await setupWriterRole({ agent: { transform() { throw new Error("private secret") } } })
  assert.ok(warnings.some(x => x.includes("NATIVE_AGENT_TRANSFORM_UNAVAILABLE")))
  assert.ok(warnings.some(x => x.includes("ROLE_REGISTRATION_FAILED")))
  assert.ok(warnings.every(x => !x.includes("private secret")))
  assert.deepEqual(config, { agents: { personal: true } })
})

test("guard opt-in is independent of writer availability and never follows options", async t => {
  t.mock.method(console, "warn", () => {})
  const original = process.env.OMO_COWORKERS_ENABLE_CLAUDE_GUARD
  const originalWriter = process.env.OMO_COWORKERS_ENABLE_WRITER_ROLE
  try {
    process.env.OMO_COWORKERS_ENABLE_WRITER_ROLE = "1"
    for (const value of [undefined, "0", "true", "1"]) {
      if (value === undefined) delete process.env.OMO_COWORKERS_ENABLE_CLAUDE_GUARD
      else process.env.OMO_COWORKERS_ENABLE_CLAUDE_GUARD = value
      for (const native of [false, true]) {
        let hooks = 0, transforms = 0
        await plugin.setup({
          options: { enabled: true },
          ...(native ? { agent: { transform: cb => { transforms++; cb(editorFor({})) } } } : {}),
          tool: { hook: async () => { hooks++ } },
        })
        assert.equal(hooks, value === "1" ? 1 : 0)
        assert.equal(transforms, native ? 1 : 0)
      }
    }
  } finally {
    if (original === undefined) delete process.env.OMO_COWORKERS_ENABLE_CLAUDE_GUARD
    else process.env.OMO_COWORKERS_ENABLE_CLAUDE_GUARD = original
    if (originalWriter === undefined) delete process.env.OMO_COWORKERS_ENABLE_WRITER_ROLE
    else process.env.OMO_COWORKERS_ENABLE_WRITER_ROLE = originalWriter
  }
})
