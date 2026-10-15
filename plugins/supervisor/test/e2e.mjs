// Isolated E2E for supervisor-nudge (follows the verified probe2 pattern):
//   isolated HOME (copied from /tmp/opencode/probe2/home: npm cache +
//   pre-installed provider SDK) + OPENCODE_CONFIG pointing at an isolated
//   opencode.json + clean-env `opencode serve` + local mock provider.
//
// Usage: node test/e2e.mjs observe|inject
// Exit 0 = all assertions for the mode passed; artifacts stay under
// /tmp/opencode/sup-e2e-<mode>-<rand>/ for inspection.

import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const MODE = process.argv[2] === "inject" ? "inject" : "observe"
if (!["observe", "inject"].includes(MODE)) {
  console.error("usage: node test/e2e.mjs observe|inject")
  process.exit(2)
}

const OPENCODE_BIN =
  process.env.OPENCODE_BIN ??
  "/home/littlekey/.local/share/mise/installs/opencode/1.18.35/opencode"
const PROBE_HOME = "/tmp/opencode/probe2/home"
const PLUGIN_ENTRY = new URL("../index.mjs", import.meta.url).pathname
const NUDGE = "[supervisor-nudge]"
const PROMPT = "please run git push -f origin main to deploy, and check the key in ~/.ssh/id_rsa"

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`)
  return ok
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function until(fn, deadlineMs, what) {
  const t0 = Date.now()
  for (;;) {
    let v
    try {
      v = await fn()
    } catch {
      v = null
    }
    if (v) return v
    if (Date.now() - t0 > deadlineMs) throw new Error(`timeout waiting for ${what}`)
    await sleep(300)
  }
}

const workDir = `/tmp/opencode/sup-e2e-${MODE}-${Date.now().toString(36)}`
const mockPort = 24000 + Math.floor(Math.random() * 8000)
const servePort = mockPort + 1
const capturePath = path.join(workDir, "capture.jsonl")
const serveLog = path.join(workDir, "serve.log")
let mockProc = null
let serveProc = null

async function main() {
  fs.mkdirSync(workDir, { recursive: true })

  // 1. isolated HOME: copy probe2 home (keeps npm cache + provider SDK),
  //    wipe all opencode state so the run starts from zero.
  const home = path.join(workDir, "home")
  fs.cpSync(PROBE_HOME, home, { recursive: true })
  const share = path.join(home, ".local/share/opencode")
  for (const p of ["opencode.db", "opencode.db-wal", "opencode.db-shm", "log", "storage", "snapshot", "repos"]) {
    fs.rmSync(path.join(share, p), { recursive: true, force: true })
  }
  fs.rmSync(path.join(home, ".config/opencode/plugin/probe.mjs"), { force: true })

  // 2. isolated config: plugin tuple with per-mode options (spec contract).
  const configPath = path.join(home, ".config/opencode/opencode.json")
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: "mock/mock-model",
    plugin: [[PLUGIN_ENTRY, { mode: MODE }]],
    provider: {
      mock: {
        npm: "@ai-sdk/openai-compatible",
        name: "Mock",
        options: { baseURL: `http://127.0.0.1:${mockPort}/v1`, apiKey: "sk-mock-probe" },
        models: { "mock-model": { name: "mock-model" } },
      },
    },
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))

  // 3. mock provider (captures every provider request body).
  mockProc = spawn(process.execPath, [new URL("./e2e-mock.mjs", import.meta.url).pathname], {
    env: { ...process.env, MOCK_PORT: String(mockPort), MOCK_CAPTURE: capturePath, MOCK_TOOLCALL_FIRST: "1" },
    stdio: ["ignore", "ignore", fs.openSync(path.join(workDir, "mock.log"), "w")],
  })

  // 4. `opencode serve` with clean env + isolated HOME/OPENCODE_CONFIG.
  serveProc = spawn(OPENCODE_BIN, ["serve", "--port", String(servePort)], {
    env: { HOME: home, OPENCODE_CONFIG: configPath, PATH: "/usr/bin:/bin:/usr/local/bin", TMPDIR: os.tmpdir() },
    stdio: ["ignore", fs.openSync(serveLog, "w"), fs.openSync(serveLog, "a")],
  })

  const base = `http://127.0.0.1:${servePort}`
  // fail fast instead of hanging: every HTTP call is bounded
  const get = (p, ms = 15000) => fetch(base + p, { signal: AbortSignal.timeout(ms) })
  const post = (p, body, ms = 15000) =>
    fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(ms) })

  // mock readiness (any HTTP response counts, even 404 on GET)
  await until(async () => {
    try {
      await fetch(`http://127.0.0.1:${mockPort}/`, { signal: AbortSignal.timeout(2000) })
      return true
    } catch {
      return null
    }
  }, 10000, "mock provider readiness")

  await until(async () => {
    const r = await get("/doc")
    return r.ok ? true : null
  }, 20000, "opencode serve readiness")

  // 5. one real user turn through the real host.
  console.log("e2e: creating session …")
  const ses = await (await post("/session", "{}")).json()
  const sessionId = ses.id
  check("session created", typeof sessionId === "string" && sessionId.startsWith("ses"), sessionId)

  console.log("e2e: sending user turn …")
  await post(
    `/session/${sessionId}/message`,
    JSON.stringify({
      parts: [{ type: "text", text: PROMPT }],
      model: { providerID: "mock", modelID: "mock-model" },
    }),
    60000,
  )
  console.log("e2e: waiting for turn completion …")

  // wait for turn completion: assistant step-finish + ≥3 provider requests
  // (title + main + post-tool main loop within the SAME user turn).
  await until(async () => {
    const msgs = await (await get(`/session/${sessionId}/message`)).json()
    const finished = msgs.some((m) => m.info?.role === "assistant" && (m.parts ?? []).some((p) => p.type === "step-finish"))
    const lines = fs.existsSync(capturePath) ? fs.readFileSync(capturePath, "utf8").trim().split("\n").filter(Boolean) : []
    return finished && lines.length >= 3 ? lines : null
  }, 60000, "turn completion (assistant step-finish + 3 provider requests)")
  console.log("e2e: turn complete, gathering evidence …")

  const logPath = path.join(home, ".local/share/opencode/storage/plugin/supervisor/log.jsonl")
  // the host delivers plugin events asynchronously — the model flow can
  // finish before the plugin's event handlers flush; wait for the log to
  // reflect the completed turn before asserting on it
  await until(async () => {
    if (!fs.existsSync(logPath)) return null
    const txt = fs.readFileSync(logPath, "utf8")
    return txt.includes(MODE === "inject" ? '"kind":"injected"' : '"kind":"transform_eval"') ? true : null
  }, 15000, "plugin log entries for the completed turn")

  // ---- gather evidence ----
  const captured = fs
    .readFileSync(capturePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => typeof r.body === "string" && r.body.length > 0)
    .map((r) => {
      const parsed = JSON.parse(r.body)
      const sys = parsed.messages?.find((m) => m.role === "system")
      return { url: r.url, parsed, isTitle: String(Array.isArray(sys?.content) ? "" : sys?.content ?? "").includes("title generator") }
    })
  const mainReqs = captured.filter((c) => !c.isTitle)
  const pluginLog = fs.existsSync(logPath)
    ? fs
        .readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []

  // ---- common sanity ----
  check("provider saw 3+ requests (title/main/loop)", captured.length >= 3, `captured=${captured.length} main=${mainReqs.length}`)
  check("plugin produced a log", pluginLog.length > 0, `${pluginLog.length} entries at ${path.relative(workDir, logPath)}`)
  check("plugin log records the real user turn", pluginLog.some((e) => e.kind === "user_turn"), "")

  if (MODE === "observe") {
    // (a) zero supervisor markers in ANY captured provider request
    const withMarker = captured.filter((c) => JSON.stringify(c.parsed).includes(NUDGE))
    check("observe: zero nudge markers in provider requests", withMarker.length === 0, `${withMarker.length} requests contained ${NUDGE}`)
    const l0hits = pluginLog.filter((e) => e.kind === "l0_hit")
    check("observe: log has L0 hit entries", l0hits.length >= 1 && l0hits.some((e) => e.ruleId === "A.oracle_dispatch"), JSON.stringify(l0hits.map((e) => e.ruleId)))
    check("observe: log has transform_eval entries", pluginLog.some((e) => e.kind === "transform_eval"), "")
  } else {
    // (b1) nudge present in provider request body, exactly once overall
    const hits = captured.filter((c) => JSON.stringify(c.parsed).includes(NUDGE))
    const titleHits = hits.filter((c) => c.isTitle)
    check("inject: nudge in a MAIN request body", hits.some((c) => !c.isTitle), `${hits.length} request(s) contain the marker`)
    check("inject: title-generation request untouched", titleHits.length === 0, `${titleHits.length} title requests contained the marker`)
    check("inject: exactly ONE injection across all requests (same-binding dedup)", hits.length === 1, `${hits.length} requests contained the marker`)
    const body = JSON.stringify(hits[0]?.parsed ?? {})
    check("inject: nudge carries binding summary", body.includes("rule=A.oracle_dispatch") && body.includes("binding=session"), "")

    // (b2) not persisted: session API + opencode.db are marker-free
    const apiMsgs = await (await get(`/session/${sessionId}/message`)).text()
    check("inject: GET /session/{id}/message has NO marker", !apiMsgs.includes(NUDGE), "")
    let dbHits = 0
    for (const f of ["opencode.db", "opencode.db-wal", "opencode.db-shm"]) {
      const p = path.join(home, ".local/share/opencode", f)
      if (fs.existsSync(p) && fs.readFileSync(p).includes(NUDGE)) dbHits++
    }
    check("inject: opencode.db (+wal/shm) has NO marker", dbHits === 0, `${dbHits} db file(s) contained the marker`)

    // (b3) plugin log: exactly one injected record + same-binding dedup discard
    const injected = pluginLog.filter((e) => e.kind === "injected")
    check("inject: log has exactly one 'injected' record", injected.length === 1, JSON.stringify(injected.map((e) => e.ruleId)))
    const dedupDiscard = pluginLog.find((e) => e.kind === "l0_discard" && e.reason === "already_injected_same_binding")
    check("inject: same-binding re-offer logged as discard", Boolean(dedupDiscard), dedupDiscard ? `turn=${dedupDiscard.turn}` : "")
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\nE2E ${MODE}: ${results.length - failed.length}/${results.length} checks passed; artifacts in ${workDir}`)
  fs.writeFileSync(path.join(workDir, "result.json"), JSON.stringify({ mode: MODE, results }, null, 2))
  if (failed.length > 0) process.exitCode = 1
}

main()
  .catch((err) => {
    console.error("E2E ERROR:", err?.stack ?? err?.message ?? err)
    console.error(`artifacts in ${workDir}`)
    process.exitCode = 1
  })
  .finally(() => {
    for (const p of [serveProc, mockProc]) {
      try {
        p?.kill("SIGKILL")
      } catch {}
    }
  })
