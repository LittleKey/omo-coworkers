// bin/supervisor-memory.mjs command implementations (P3 CLI, m1-plan §3 P3).
// Subcommands: init / digest [--draft id] / approve / discard / merge /
// disable / status / doctor. All store mutations go through lib/memory/store.mjs
// transactions; the only files THIS layer writes are rebuildable views under
// <root>/digest/ — never target files, never store state directly.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import readline from "node:readline/promises"
import {
  SCHEMA_ID,
  SCHEMA_VERSION,
  FILE_RULES,
  FILE_ISSUES,
  FILE_PROJECTS,
  StoreError,
  defaultMemoryRoot,
  initStore,
  openStore,
} from "../store.mjs"
import { parseArgs } from "./args.mjs"
import { readonlyCheck } from "./checks.mjs"
import { generateRemove, formatPatch } from "./patch.mjs"
import { readView, writeView, readDrafts, saveDraft, recordDraftFailure } from "./views.mjs"
import { draftEnv, draftOnce } from "./draft.mjs"
import { runApprove } from "./approve.mjs"
import { runDeliveryEnable, runDeliveryDisable, printRideSentinel } from "./delivery.mjs"
import { submitDecision } from "../approval-service.mjs"
import { defaultLogPath } from "../../config.mjs"

// ---------- IO ----------

export function makeRealIO() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return {
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    print: (line = "") => console.log(line),
    confirm: async (prompt) => {
      const a = (await rl.question(`${prompt} [y/N] `)).trim().toLowerCase()
      return a === "y" || a === "yes"
    },
    choose: async (prompt, options) => {
      options.forEach((o, i) => console.log(`  ${i + 1}. ${o}`))
      for (;;) {
        const a = (await rl.question(`${prompt} [1-${options.length}] `)).trim()
        const n = Number(a)
        if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1
        console.log("  invalid selection number, please retry.")
      }
    },
    input: async (prompt, def = "") => {
      const a = await rl.question(def !== "" ? `${prompt}(${def}) ` : `${prompt} `)
      return a.trim() === "" ? def : a.trim()
    },
    inputLines: async (prompt) => {
      console.log(`${prompt}: one line at a time; a lone . ends input:`)
      const lines = []
      for (;;) {
        const l = await rl.question("")
        if (l.trim() === ".") break
        lines.push(l)
      }
      return lines.join("\n")
    },
    close: () => rl.close(),
  }
}

// ---------- errors ----------

export function humanStoreError(e) {
  if (!(e instanceof StoreError)) return e?.message ?? String(e)
  const prefix = `error[${e.code}]`
  if (e.code === "STORE_MISSING") return `${prefix} store does not exist — run init first (a missing store is not a fresh install; it is never auto-created).`
  if (e.code === "STORE_SCHEMA")
    return `${prefix} store schema version mismatch. Upgrade path: disable the old tool version → back up the whole store directory → upgrade the CLI and store, then migrate per the new version's instructions; never mix old and new tools in place.`
  if (e.code === "STORE_INCOMPLETE")
    return `${prefix} an incomplete commit exists — authorization output is disabled (no publishing, no status changes, no patches). Resolve it manually per the doctor diff report (restore from backup; v1 has no rebuild).`
  if (e.code === "STORE_LOCKED") return `${prefix} the store is locked by another process; the write failed and did not overwrite. Retry later; if the holding process is dead, the lock auto-recovers after the grace period.`
  if (e.code === "STORE_PERM") return `${prefix} permission problem — the store directory should be 0700 and files 0600.`
  if (e.code === "STORE_CORRUPT") return `${prefix} the store is corrupt; the operation was refused (fail-closed). Restore from backup; do not hand-patch.`
  return `${prefix} ${e.message}`
}

/**
 * Startup schema gate (m1-plan §5 risk table): check the JSON state files'
 * schema/version BEFORE opening, so a future store layout is refused with an
 * upgrade path instead of half-parsed behavior.
 */
export function openStoreChecked(root) {
  for (const f of [FILE_RULES, FILE_ISSUES, FILE_PROJECTS]) {
    let text
    try {
      text = fs.readFileSync(path.join(root, f), "utf8")
    } catch {
      continue
    }
    let doc
    try {
      doc = JSON.parse(text)
    } catch {
      continue // unparsable → openStore/doctor reports it properly
    }
    if (doc && typeof doc === "object" && (doc.schema !== SCHEMA_ID || doc.version !== SCHEMA_VERSION)) {
      throw new StoreError(
        "STORE_SCHEMA",
        `${f} is ${JSON.stringify(doc.schema)}/${JSON.stringify(doc.version)}, this tool requires ${SCHEMA_ID}/${SCHEMA_VERSION}`,
      )
    }
  }
  return openStore(root)
}

// ---------- weekly (D10) ----------

export function isoWeekMonday(ts) {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  const day = (d.getDay() + 6) % 7 // Mon = 0
  d.setDate(d.getDate() - day)
  return d
}

export function isoWeekKey(ts) {
  const d = new Date(ts)
  const thursday = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  thursday.setDate(thursday.getDate() - ((thursday.getDay() + 6) % 7) + 3)
  const jan4 = new Date(thursday.getFullYear(), 0, 4)
  const week1Thu = new Date(jan4)
  week1Thu.setDate(week1Thu.getDate() - ((week1Thu.getDay() + 6) % 7) + 3)
  const week = 1 + Math.round((thursday.getTime() - week1Thu.getTime()) / (7 * 86_400_000))
  return `${thursday.getFullYear()}-W${String(week).padStart(2, "0")}`
}

export function weeklyCounts(store, weekStartTs) {
  const weekEndTs = weekStartTs + 7 * 86_400_000
  const inWeek = (t) => typeof t === "number" && t >= weekStartTs && t < weekEndTs
  const issues = store.listIssues()
  const issueById = new Map(issues.map((i) => [i.id, i]))
  const candidates = issues.filter((i) => inWeek(i.createdAtTs)).length
  const dropped = issues.filter((i) => i.status === "dropped" && inWeek(i.updatedAtTs)).length
  const approved = store.listDecisions({ kind: "approve" }).filter((d) => inWeek(d.ts)).length
  const recurrences = store
    .listEvents()
    .filter((e) => inWeek(e.ts) && e.issueId && issueById.get(e.issueId)?.createdAtTs < weekStartTs).length
  return { candidates, approved, dropped, recurrences }
}

const UNKNOWN = "unknown"

function weeklySection(store, root, flags, nowTs, { write = true } = {}) {
  const weekStart = flags.week ? parseWeekFlag(flags.week) : isoWeekMonday(nowTs).getTime()
  const key = flags.week ?? isoWeekKey(nowTs)
  const counts = weeklyCounts(store, weekStart)
  const v = readView(root, "weekly.json", { weeks: {} })
  const weeks = v.weeks && typeof v.weeks === "object" ? v.weeks : {}
  const prev = weeks[key] ?? {}
  const prevSr = prev.selfReport ?? {}
  const selfReport = {
    spentMinutes: flags["spent-min"] !== undefined ? flags["spent-min"] : prevSr.spentMinutes ?? null,
    dupBurden: flags["dup-burden"] !== undefined ? flags["dup-burden"] : prevSr.dupBurden ?? null,
    missedExperience: flags["missed-exp"] !== undefined ? flags["missed-exp"] : prevSr.missedExperience ?? null,
    manualIncrement: flags["manual-increment"] !== undefined ? flags["manual-increment"] : prevSr.manualIncrement ?? null,
  }
  if (write) {
    weeks[key] = { week: key, counts, selfReport, updatedAtTs: nowTs }
    writeView(root, "weekly.json", { weeks })
  }
  return { key, counts, selfReport }
}

function parseWeekFlag(w) {
  // "YYYY-Www" → that Monday (local). Fallback: this week.
  const m = /^(\d{4})-W(\d{2})$/.exec(String(w))
  if (!m) return isoWeekMonday(Date.now()).getTime()
  // Jan 4 is always in ISO week 1; walk back from it.
  const jan4 = new Date(Number(m[1]), 0, 4)
  const start = isoWeekMonday(jan4.getTime())
  start.setDate(start.getDate() + (Number(m[2]) - 1) * 7)
  return start.getTime()
}

// ---------- digest rendering ----------

const STATE_LABEL = {
  approved: "approved (should be present)",
  "awaiting-apply": "awaiting manual application",
  "readonly-disabled": "disabled (should be absent)",
  "readonly-old-version": "old version (should be absent)",
}
const OBSERVED_LABEL = {
  present: "present",
  "present-unmarked": "present (no wrapping marker)",
  absent: "absent",
  "target-missing": "target file missing",
  "target-changed": "target changed",
  "marker-anomaly": "marker anomaly",
  "other-version": "a segment of another version exists",
}

function printPending(store, pending) {
  console.log(`pending review: ${pending.issues.length} candidates, ${pending.events.length} pending events`)
  for (const iss of pending.issues) {
    console.log(`\n[${iss.id}] ${iss.title} (status ${iss.status}, recurrences ${iss.recurrence}, project ${iss.projectId ?? "unknown"}, created ${new Date(iss.createdAtTs).toISOString()})`)
    if (iss.topic) console.log(`  topic: ${iss.topic}`)
    const evs = store.listEvents({ issueId: iss.id })
    for (const e of evs) {
      console.log(`  event ${e.id} [${e.status}] ${new Date(e.ts).toISOString()} source session=${e.source?.sessionId} project=${e.source?.projectId}`)
      console.log(`    excerpt: ${(e.evidence?.excerpt ?? "").replace(/\n/g, " ⏎ ").slice(0, 300)}`)
    }
  }
  const orphans = pending.events.filter((e) => !e.resolvedIssue)
  if (orphans.length > 0) {
    console.log(`\npending events without an owning candidate: ${orphans.length}`)
    for (const e of orphans) console.log(`  ${e.id} ${new Date(e.ts).toISOString()} ${e.evidence?.excerpt?.slice(0, 120) ?? ""}`)
  }
}

function printChecks(checks) {
  if (checks.rows.length === 0) {
    console.log("read-only check: no published records — no targets to verify.")
    return
  }
  console.log(`read-only check (whitespace-normalized comparison; reports only, never rewrites, zero writes to target files): ${checks.rows.length} item(s)`)
  for (const r of checks.rows) {
    const ver = r.version === null ? "old" : `v${r.version}`
    console.log(`  ${r.ruleId} ${ver} [${STATE_LABEL[r.state] ?? r.state}] ${r.target} → ${OBSERVED_LABEL[r.observed] ?? r.observed}${r.note ? ` (${r.note})` : ""}`)
  }
  for (const r of checks.rows.filter((x) => x.drift)) {
    console.log(`  ⚠ drift: ${r.ruleId} expected present, actually ${OBSERVED_LABEL[r.drift]} — report only, never rewrite.`)
  }
  for (const r of checks.rows.filter((x) => x.residue)) {
    console.log(`  ⚠ residue: ${r.ruleId} (disabled/old version) still visible in the target — report only, never rewrite.`)
  }
  for (const r of checks.reviewNeeded) {
    console.log(`  ⚠ target changed → send for human review (never inferred as user deletion): ${r.target}(${r.ruleId})`)
  }
}

function printWeekly(w) {
  const sr = w.selfReport
  console.log(`\nweekly report ${w.key}: candidates ${w.counts.candidates} / approved ${w.counts.approved} / dropped ${w.counts.dropped} / recurrences ${w.counts.recurrences}`)
  console.log(`self-reported: time spent (minutes) ${sr.spentMinutes ?? UNKNOWN}; duplicate burden ${sr.dupBurden ?? UNKNOWN}; missed-recording experience ${sr.missedExperience ?? UNKNOWN}; manual-review increment (could the candidate be recalled without the system?) ${sr.manualIncrement ?? UNKNOWN}`)
  console.log(`note: counts and self-reported fields are for review only; missing means unknown; counts alone never establish an "effort-saving" conclusion (D10).`)
}

// ---------- subcommands ----------

export function runInit(root) {
  try {
    const r = initStore(root)
    console.log(`memory store initialized: ${r.root}`)
    for (const f of r.files) console.log(`  ${f}`)
    console.log(`  digest/ (rebuildable view)`)
    return 0
  } catch (e) {
    if (e instanceof StoreError && e.code === "STORE_EXISTS") {
      console.error(`error: ${e.message} (an existing store is never overwritten).`)
      return 1
    }
    throw e
  }
}

export async function runDigest(ctx, flags) {
  const { store, io } = ctx
  // draft subcommand: explicit, only for the named candidate
  if (flags.draft) {
    const id = flags.draft === true ? ctx.argv?.[0] : flags.draft
    return runDraft(ctx, id, flags)
  }
  const st = store.status()
  const banner = (s) => console.log(`memory store @ ${st.root} — health: ${s}`)
  banner(st.health.status)
  if (st.health.status === "incomplete_commit") {
    console.log("⚠ authorization disabled: an incomplete commit exists — the output below is display only; no views are written and no approvals/patches are produced.")
    const inc = st.incomplete
    if (inc) {
      const landed = inc.files.filter((f) => f.landed).map((f) => f.path)
      const missing = inc.files.filter((f) => !f.landed).map((f) => f.path)
      console.log(`  transaction ${inc.txnId}(${inc.op}): landed [${landed.join(", ") || "none"}], not landed [${missing.join(", ") || "none"}]`)
    }
  } else if (st.health.status !== "ok") {
    for (const p of st.health.problems) console.log(`  problem[${p.severity}] ${p.detail}`)
    console.log("(full diagnostics: doctor)")
  }
  try {
    printPending(store, store.listPending())
    const checks = readonlyCheck(store.listRules(), store.listDecisions())
    printChecks(checks)
    printRideSentinel(store, { logPath: defaultLogPath() })
    const w = weeklySection(store, store.root, flags, Date.now(), { write: st.health.status === "ok" })
    printWeekly(w)
    // views only on a healthy store (rebuildable, non-authoritative)
    if (st.health.status === "ok") {
      writeView(store.root, "pending.json", { ts: Date.now(), ...store.listPending() })
      writeView(store.root, "checks.json", { ts: Date.now(), ...checks })
    } else {
      console.log("(views not written: health status is not ok)")
    }
  } catch (e) {
    console.error(humanStoreError(e))
    return 1
  }
  io.print("")
  return 0
}

export async function runDraft(ctx, id, flags) {
  const { store, io, env } = ctx
  if (typeof id !== "string" || id.length === 0) {
    io.print("usage: supervisor-memory digest --draft <issueId>")
    return 1
  }
  let issue
  try {
    issue = store.getIssue(id)
  } catch (e) {
    console.error(humanStoreError(e))
    return 1
  }
  if (!issue) {
    io.print(`issue candidate ${id} not found.`)
    return 1
  }
  if (issue.status !== "draft") {
    io.print(`rejected: candidate ${id} has status ${issue.status}; only draft candidates accept rule drafts.`)
    return 1
  }
  const denv = draftEnv(env ?? {})
  if (!denv.apiKey) {
    io.print("SUPERVISOR_MEMORY_DRAFT_API_KEY is not set — skipping drafting (no network request was sent). Draft manually.")
    return 0
  }
  const events = store.listEvents({ issueId: id })
  io.print(`drafting ${id}: the outbound scope is exactly this candidate's ${events.length} events and their excerpts (never the whole store); model ${denv.model} @ ${denv.baseUrl}; a single attempt.`)
  const r = await draftOnce({ issue, events, env: denv, fetchImpl: ctx.fetchImpl, timeoutMs: ctx.draftTimeoutMs ?? 30_000 })
  if (r.status === "ok") {
    io.print("── draft body ──")
    io.print(r.text)
    io.print("── end ──")
    const wantStore = flags["store-draft"] === true || (io.isTTY && (await io.confirm("Save as this candidate's draft?")))
    if (wantStore) {
      saveDraft(store.root, id, r.text, Date.now())
      io.print(`stored to ${path.join(store.root, "digest/drafts.json")} (a rebuildable view, not an authorization state).`)
    }
    return 0
  }
  if (r.status === "no-key") {
    io.print("SUPERVISOR_MEMORY_DRAFT_API_KEY is not set — skipping drafting. Draft manually.")
    return 0
  }
  recordDraftFailure(store.root, id, r.error, Date.now())
  const failures = readDrafts(store.root).failures[id]?.count ?? 1
  io.print(`drafting failed (${r.status === "timeout" ? "timeout" : r.error}) — draft manually; no retry, and normal digest is unaffected. This candidate now has ${failures} cumulative failure(s).`)
  return 0
}

export function runDiscard(ctx, id) {
  const { store, io } = ctx
  if (typeof id !== "string" || id.length === 0) {
    io.print("usage: supervisor-memory discard <issueId|eventId>")
    return 1
  }
  try {
    if (id.startsWith("EVT-")) {
      store.confirmEvent(id, "false_positive")
      io.print(`event ${id} marked as a false positive (terminal; the original source is preserved).`)
    } else {
      const iss = store.getIssue(id)
      if (!iss) {
        io.print(`issue candidate ${id} not found.`)
        return 1
      }
      if (iss.status !== "draft") {
        io.print(`candidate ${id} is already terminal (${iss.status}) — discard cannot be repeated; re-reporting the same fact only duplicates the count and never restores authorization.`)
        return 1
      }
      store.upsertIssue({ id, status: "dropped" })
      io.print(`candidate ${id} discarded (terminal; re-reporting the same fact only duplicates the count and never restores authorization).`)
    }
    return 0
  } catch (e) {
    console.error(humanStoreError(e))
    return 1
  }
}

export function runMerge(ctx, donorId, targetId) {
  const { store, io } = ctx
  if (typeof donorId !== "string" || typeof targetId !== "string") {
    io.print("usage: supervisor-memory merge <donorIssueId> <targetIssueId>")
    return 1
  }
  try {
    store.mergeIssues(donorId, targetId)
    io.print(`merged: ${donorId} → ${targetId}. Both sides' original event sources are preserved; merging carries no authorization and never widens scope; approve ${targetId} separately.`)
    return 0
  } catch (e) {
    console.error(humanStoreError(e))
    return 1
  }
}

export function runDisable(ctx, ruleId) {
  const { store, io } = ctx
  if (typeof ruleId !== "string" || ruleId.length === 0) {
    io.print("usage: supervisor-memory disable <ruleId>")
    return 1
  }
  try {
    store.requireHealthy()
    const rule = store.getRule(ruleId)
    if (!rule) {
      io.print(`rule ${ruleId} not found.`)
      return 1
    }
    if (rule.status !== "active") {
      io.print(`rejected: rule ${ruleId} currently has status ${rule.status}; only active rules can be disabled.`)
      return 1
    }
    // Stop-class: the explicit CLI invocation is the admin request — no second
    // confirmation. Routed through the shared approval critical section so a
    // concurrent approve/stop in another process cannot interleave.
    submitDecision({ store, kind: "disable", ruleId })
    io.print(`disabled ${ruleId} (a human decision; store status disabled, targets preserved).`)
    io.print("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!")
    io.print("!! disabled-in-store ≠ residue withdrawn from files — if the patch was applied manually, the managed segment is still in the target file; remove it by hand with the removal patch below.")
    io.print("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!")
    if ((rule.targets ?? []).length === 0) {
      io.print("(this rule has no registered targets — never published, no removal patch.)")
    }
    for (const t of rule.targets ?? []) {
      let content
      try {
        content = fs.readFileSync(t, "utf8")
      } catch {
        io.print(`  target ${t}: file missing (possibly deleted; nothing to remove).`)
        continue
      }
      try {
        const patches = generateRemove(content, { ruleId })
        if (!patches) {
          io.print(`  target ${t}: no managed segment for this rule (never applied, or already removed).`)
          continue
        }
        for (const p of patches) {
          io.print(formatPatch({ targetPath: t, why: "known publish target of the disabled rule", scopePromise: "removes the entire managed segment (all versions)", tracked: p.notes?.join("; ") || "see file", patch: p }))
        }
      } catch (e) {
        io.print(`  target ${t}: marker anomaly, fail-closed — ${e.message} (send for human review; never inferred as user deletion).`)
      }
    }
    return 0
  } catch (e) {
    console.error(humanStoreError(e))
    return 1
  }
}

export function runStatus(ctx) {
  try {
    const st = ctx.store.status()
    console.log(`memory store @ ${st.root}`)
    console.log(`health: ${st.health.status}`)
    for (const p of st.health.problems) console.log(`  problem[${p.severity}] ${p.detail}`)
    if (st.incomplete) {
      const landed = st.incomplete.files.filter((f) => f.landed).map((f) => f.path)
      const missing = st.incomplete.files.filter((f) => !f.landed).map((f) => f.path)
      console.log(`incomplete commit ${st.incomplete.txnId}(${st.incomplete.op}): landed [${landed.join(", ") || "none"}], not landed [${missing.join(", ") || "none"}]`)
    }
    console.log(`lock: ${st.lock?.exists ? `${st.lock.state}${st.lock.pid !== null ? `(pid ${st.lock.pid})` : ""}` : "no holder"}`)
    console.log(`counts: rules ${JSON.stringify(st.counts.rules)}; candidates ${JSON.stringify(st.counts.issues)}; events ${JSON.stringify(st.counts.events)}; decisions ${JSON.stringify(st.counts.decisions)}; projects ${JSON.stringify(st.counts.projects)}`)
    return ["ok", "incomplete_commit"].includes(st.health.status) ? 0 : 1
  } catch (e) {
    console.error(humanStoreError(e))
    return 1
  }
}

export function runDoctor(ctx) {
  const d = ctx.store.doctor()
  console.log(`doctor @ ${d.root} — health: ${d.health.status}`)
  for (const c of d.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`)
  if (d.health.status === "ok") {
    console.log("verdict: healthy.")
    return 0
  }
  console.log("verdict: unhealthy — authorization output stays disabled; resolve the differences above manually (restore from backup; v1 has no rebuild).")
  return 1
}

// ---------- usage / main ----------

export function printUsage() {
  console.log(`supervisor-memory — human-review CLI (P3) and exact patch output (P4)

usage: supervisor-memory [--root <store dir>] <subcommand> [args]

subcommands:
  init                     explicitly initialize the store (a missing store is not a fresh install; an existing one is never overwritten)
  digest                   pending list + source excerpts + read-only check (D9) + weekly report (D10)
  digest --draft <issueId> draft once for that candidate only (outbound: that candidate's event excerpts only; requires
                           SUPERVISOR_MEMORY_DRAFT_API_KEY; failures are never retried)
  approve <ISS-|RUL->      three-stage TTY approval (D6); prints patches for manual application; approval ≠ landed
  discard <ISS-|EVT->      discard a candidate / mark an event a false positive (terminal)
  merge <donor> <target>   merge candidates (both sides' original event sources preserved; carries no authorization)
  disable <RUL->           disable a rule + print removal patches for known targets (disabled-in-store ≠ residue withdrawn)
  delivery-enable <RUL->   authorize system-ride delivery for one rule version (binds ruleId+version+bodyHash+channel;
                           injected into the system prompt of every model request of matching sessions, persistent within session)
  delivery-disable <RUL->  stop appending the rule to the system prompt (history/compressed text is not retroactively removed)
  status                   human-readable store status
  doctor                   read-only diagnostics (including the incomplete-commit diff report)

options:
  --root <dir>             store root (default ~/.local/share/opencode-supervisor/memory)
  --week YYYY-Www          target week of the weekly report
  --spent-min <n>          weekly self-report: time spent (minutes)
  --dup-burden <text>      weekly self-report: duplicate burden
  --missed-exp <text>      weekly self-report: missed-recording experience
  --manual-increment <text> weekly self-report: manual-review increment
  --store-draft            save the --draft draft when non-interactive
environment variables (digest --draft):
  SUPERVISOR_MEMORY_DRAFT_API_KEY / SUPERVISOR_MEMORY_DRAFT_BASE_URL
  (default http://10.126.126.10:3000/v1) / SUPERVISOR_MEMORY_DRAFT_MODEL (default glm-5.3)`)
}

/**
 * @param {string[]} argv process.argv.slice(2)
 * @param {object} opts {env, cwd, home, io, fetchImpl, draftTimeoutMs}
 * @returns {Promise<number>} exit code
 */
export async function main(argv, opts = {}) {
  const env = opts.env ?? process.env
  const cwd = opts.cwd ?? process.cwd()
  const home = opts.home ?? os.homedir()
  const { flags, pos } = parseArgs(argv)
  const cmd = pos[0] ?? "help"
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    printUsage()
    return 0
  }
  const root = typeof flags.root === "string" ? flags.root : defaultMemoryRoot()
  if (cmd === "init") {
    try {
      return runInit(root)
    } catch (e) {
      console.error(humanStoreError(e))
      return 1
    }
  }
  let store
  try {
    store = openStoreChecked(root)
  } catch (e) {
    console.error(humanStoreError(e))
    return 1
  }
  const io = opts.io ?? makeRealIO()
  const ctx = { store, io, cwd, home, env, argv: pos.slice(1), fetchImpl: opts.fetchImpl, draftTimeoutMs: opts.draftTimeoutMs }
  try {
    switch (cmd) {
      case "digest":
        return await runDigest(ctx, flags)
      case "approve":
        return (await runApprove(ctx, pos[1])).code
      case "discard":
        return runDiscard(ctx, pos[1])
      case "merge":
        return runMerge(ctx, pos[1], pos[2])
      case "disable":
        return runDisable(ctx, pos[1])
      case "delivery-enable":
        return await runDeliveryEnable(ctx, pos[1])
      case "delivery-disable":
        return await runDeliveryDisable(ctx, pos[1])
      case "status":
        return runStatus(ctx)
      case "doctor":
        return runDoctor(ctx)
      default:
        console.error(`unknown subcommand: ${cmd} (see supervisor-memory help)`)
        return 2
    }
  } catch (e) {
    console.error(humanStoreError(e))
    return 1
  } finally {
    if (typeof io.close === "function") io.close()
  }
}
