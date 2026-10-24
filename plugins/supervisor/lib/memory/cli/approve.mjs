// `approve <issueId|ruleId>` — D6 three-stage TTY approval (m1-plan §2 D6,
// design I.6). Stage 1: pick and confirm target(s). Stage 2: show the FULL
// approval object. Stage 3: confirm; on confirm the object canonicalJson hash
// and a store fingerprint are recomputed and compared with what stage 2 showed
// — any change invalidates the confirmation (no silent retry, explicit error,
// exit 1). The decision is recorded via store.recordDecision with the object
// hash. Approval success ≠ applied: P4 patches are PRINTED for manual apply;
// the CLI never writes target files.
//
// Non-TTY → refuse. Incomplete-commit store → requireHealthy() throws (D5).
// An approve is never recorded without at least one selectable, confirmed,
// existing target (未绑定目标的 approve 不得记完成). IO methods may be sync
// (test fakes) or async (real readline) — every call is awaited.
import fs from "node:fs"
import path from "node:path"
import { canonicalJson, sha256Hex } from "../store.mjs"
import { candidateTargets, whyTarget } from "./targets.mjs"
import { formatRulePatch, generatePatch, countBodyLines, BODY_MAX_LINES } from "./patch.mjs"
import { readDrafts } from "./views.mjs"

/** Store-state fingerprint captured at stage 2 and re-verified at stage 3 (T3). */
export function fingerprint(store, ruleId, issueId) {
  const decisions = store.listDecisions()
  const rule = ruleId ? store.getRule(ruleId) : null
  const issue = issueId ? store.getIssue(issueId) : null
  return {
    decisionsTotal: decisions.length,
    rule: rule
      ? {
          version: rule.version,
          status: rule.status,
          updatedAtTs: rule.updatedAtTs,
          decisionId: rule.approvalRef?.decisionId ?? null,
        }
      : null,
    issue: issue ? { status: issue.status, updatedAtTs: issue.updatedAtTs } : null,
  }
}

function sameFingerprint(a, b) {
  return canonicalJson(a) === canonicalJson(b)
}

export function describeScope(scope) {
  if (scope.kind === "user-global") return "user-global — global ~/.config/opencode/AGENTS.md (loaded by all projects)"
  if (scope.kind === "project") return `project — the root AGENTS.md of project ${scope.projectId} (confirmed directory)`
  return `directory — the AGENTS.md of the ${scope.directory} subtree (loaded only by sessions inside that directory)`
}

async function inputDate(io, prompt, fallback) {
  for (;;) {
    const v = await io.input(prompt, fallback)
    if (v.trim() === "" || /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return v.trim() || fallback
    io.print("  date format must be YYYY-MM-DD, please retry (empty = use the default).")
  }
}

function parseSelections(s, max) {
  const out = []
  for (const part of s.split(/[,，\s]+/)) {
    if (part === "") continue
    const n = Number(part)
    if (!Number.isInteger(n) || n < 1 || n > max) return null
    out.push(n - 1)
  }
  return out.length > 0 ? out : null
}

/**
 * @param ctx {store, io, cwd, home, env}
 * @param id issue id (ISS-…) or rule id (RUL-…)
 * @returns {{code:number, patches?:string[], ruleId?:string}}
 */
export async function runApprove(ctx, id) {
  const { store, io, cwd, home } = ctx
  if (!io.isTTY) {
    io.print("rejected: approve is a three-stage manual confirmation and must run in an interactive terminal (TTY); approvals are never accepted in a non-TTY environment.")
    return { code: 1 }
  }
  if (typeof id !== "string" || id.length === 0) {
    io.print("usage: supervisor-memory approve <issueId|ruleId>")
    return { code: 1 }
  }
  store.requireHealthy() // D5: incomplete/corrupt/locked → explicit refusal

  // ---- resolve subject: issue draft or existing rule ----
  let issue = null
  let rule = null
  if (id.startsWith("RUL-")) {
    rule = store.getRule(id)
    if (!rule) {
      io.print(`rule ${id} not found.`)
      return { code: 1 }
    }
    if (rule.status === "disabled") {
      io.print(`rejected: rule ${id} is disabled. Disabling is a human decision; re-enabling requires a fresh approval object (enable flow) and can never be silently revived by running approve again.`)
      return { code: 1 }
    }
  } else {
    issue = store.getIssue(id)
    if (!issue) {
      io.print(`issue candidate ${id} not found (candidates start with ISS-; rules start with RUL-).`)
      return { code: 1 }
    }
    if (issue.status !== "draft") {
      const why =
        issue.status === "approved"
          ? "already approved (approval success ≠ landed; the patch printed at the time is authoritative). Re-approving / re-reporting / merging never restores or expands authorization."
          : issue.status === "merged"
            ? `merged into ${issue.mergedInto}. Operate on that target candidate instead; the original event sources are preserved unchanged.`
            : "discarded (false positive or abandoned). Re-reporting the same fact only duplicates the count and never restores authorization."
      io.print(`rejected: issue candidate ${id} currently has status ${issue.status} — ${why}`)
      return { code: 1 }
    }
  }

  const projectId = issue?.projectId ?? rule?.scope?.projectId ?? null
  const nextVersion = (rule?.version ?? 0) + 1

  // ---- body ----
  let body = null
  const draftsView = readDrafts(store.root)
  const draftEntry = issue ? draftsView.drafts[issue.id] : null
  if (draftEntry?.body) {
    io.print("Stored draft body:")
    io.print(draftEntry.body)
    if (await io.confirm("Adopt this draft as the rule body?")) body = draftEntry.body
  }
  if (body === null && rule) {
    io.print("Current version body:")
    io.print(rule.body)
    if (await io.confirm("Keep the current version body?")) body = rule.body
  }
  if (body === null) {
    io.print("Enter the rule body: one line at a time; a lone . ends input.")
    body = await io.inputLines("body")
  }
  body = String(body).replace(/\r\n/g, "\n").replace(/\s+$/, "")
  if (body.trim().length === 0) {
    io.print("rejected: body is empty.")
    return { code: 1 }
  }
  if (countBodyLines(body) > BODY_MAX_LINES) {
    io.print(`rejected: body is ${countBodyLines(body)} lines, over the ${BODY_MAX_LINES}-line limit — the patch would fail as a whole; shorten it and retry (never truncated).`)
    return { code: 1 }
  }

  // ---- scope ----
  const scopeOptions = []
  if (projectId) scopeOptions.push({ kind: "project", label: `project — the root AGENTS.md of project ${projectId}` })
  scopeOptions.push({ kind: "user-global", label: "user-global — global AGENTS.md" })
  scopeOptions.push({ kind: "directory", label: "directory — the AGENTS.md of a given directory (that subtree only)" })
  io.print("Choose a scope:")
  const scopeIdx = await io.choose("scope", scopeOptions.map((o) => o.label))
  const scopeKind = scopeOptions[scopeIdx].kind
  let scope
  if (scopeKind === "project") {
    scope = { kind: "project", projectId }
  } else if (scopeKind === "user-global") {
    scope = { kind: "user-global" }
  } else {
    const dir = await io.input("absolute directory path", cwd)
    if (!path.isAbsolute(dir)) {
      io.print("rejected: a directory scope requires an absolute path.")
      return { code: 1 }
    }
    scope = { kind: "directory", directory: path.resolve(dir) }
  }

  // ---- agent restriction: cannot be honored through AGENTS.md (load scope
  // does not distinguish agents) → keep unpublished with a reason, no record. ----
  const agentsRaw = await io.input("agents to restrict to (comma-separated, empty = no restriction)", "")
  const agents = agentsRaw.split(/[,，\s]+/).filter(Boolean)
  if (agents.length > 0) {
    io.print("left unpublished: agent restrictions cannot be honored through the AGENTS.md load scope (that file loads by directory and does not distinguish agents); the v1 CLI does not record such approvals.")
    io.print(`reason: requested agent scope = ${agents.join(", ")}; the only scopes that can honor it are user-global / project / directory.`)
    return { code: 1 }
  }

  const defaultReview = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString().slice(0, 10)
  const reviewDate = await inputDate(io, "review date (YYYY-MM-DD, empty = 30 days from now)", defaultReview)
  const channel = "patch-human-apply"

  // ---- stage 1: targets (existing files only; per-target confirmation) ----
  const projects = store.listProjects()
  const candidates = candidateTargets({ scope, projects, cwd, home })
  io.print("Candidate targets (new files are never created; a missing file = not selectable):")
  candidates.forEach((c, i) => {
    const flag = c.exists ? `${i + 1}.` : "×"
    const conf = c.confirmedDir === false ? " [directory unconfirmed]" : c.confirmedDir === true ? " [directory confirmed]" : ""
    io.print(`  ${flag} ${c.path} — ${c.exists ? "exists" : "missing (new files are never created)"}, ${c.note}${conf}`)
  })
  const selectableCount = candidates.filter((c) => c.exists).length
  if (selectableCount === 0) {
    io.print("no eligible target: no existing AGENTS.md can carry this rule (a CLAUDE.md-only or file-less target is never fallen back to or created). Left unpublished, approval not recorded.")
    return { code: 1 }
  }
  const selRaw = await io.input("select targets (numbers, comma-separated for multiple; empty = abort)", "")
  const sel = parseSelections(selRaw, candidates.length)
  if (!sel || sel.length === 0) {
    io.print("no target selected — approval abandoned, no decision recorded.")
    return { code: 1 }
  }
  const targets = []
  for (const ix of sel) {
    const c = candidates[ix]
    if (!c || !c.exists) {
      io.print(`rejected: the selected target does not exist — new files are never created.`)
      return { code: 1 }
    }
    if (c.kind === "project" && c.confirmedDir !== true) {
      if (!(await io.confirm(`directory ${c.directory} is not registered as confirmed (projects.json) — register and confirm this directory?`))) {
        io.print("aborted: directory not confirmed — no decision recorded.")
        return { code: 1 }
      }
    }
    if (c.tracked) {
      if (!(await io.confirm(`${c.path} is git-tracked — explicitly confirm publishing to a tracked file?`))) {
        io.print("aborted: tracked target not explicitly confirmed — no decision recorded.")
        return { code: 1 }
      }
    }
    targets.push(c.path)
  }
  const directoryBoundary = scope.kind === "directory" ? scope.directory : scope.kind === "project" ? cwd : null

  // ---- build object, hash, fingerprint (stage 2 snapshot) ----
  const object = { body, scope, targets, reviewDate, channel, directoryBoundary, agents: null }
  const objectHash = sha256Hex(canonicalJson(object))
  const ruleIdForFp = rule?.id ?? null
  const issueIdForFp = issue?.id ?? null
  const before = fingerprint(store, ruleIdForFp, issueIdForFp)

  // ---- stage 2: full display ----
  io.print("────────────── approval object (stage 2/3) ──────────────")
  io.print(`rule: ${rule ? `${rule.id} → new version v${nextVersion}` : "new rule v1"}${issue ? ` (candidate ${issue.id}: ${issue.title})` : ""}`)
  io.print("body:")
  for (const l of body.split("\n")) io.print(`  | ${l}`)
  io.print(`effective scope: ${describeScope(scope)}`)
  io.print("agent restriction: none (publishing via AGENTS.md does not distinguish agents)")
  io.print(`review date: ${reviewDate}`)
  io.print(`channel: ${channel} (the patch is applied manually by a human; the plugin never writes to target files)`)
  io.print(`targets (${targets.length}):`)
  for (const t of targets) {
    const c = candidates.find((x) => x.path === t)
    io.print(`  - ${t}`)
    io.print(`    why: ${whyTarget(c)}`)
    io.print(`    tracking: ${c.note} — ${c.tracked ? "explicitly confirmed" : "untracked"}`)
  }
  io.print(`object hash (confirmation binding): ${objectHash.slice(0, 16)}…`)
  io.print("────────────── awaiting confirmation (stage 3/3) ──────────────")

  // ---- stage 3: confirm — recompute hash + fingerprint; any change invalidates ----
  if (!(await io.confirm("Confirm approval of the object above?"))) {
    io.print("cancelled — no decision recorded.")
    return { code: 1 }
  }
  const after = fingerprint(store, ruleIdForFp, issueIdForFp)
  const recheckHash = sha256Hex(canonicalJson(object))
  if (recheckHash !== objectHash || !sameFingerprint(before, after)) {
    io.print("confirmation invalidated: the object/store state at confirmation time no longer matches the stage-2 display (object hash or store fingerprint changed — possibly concurrent writes).")
    io.print("silent retries are forbidden: re-run approve and re-confirm from stage 1. No decision was recorded this time.")
    return { code: 1 }
  }

  // ---- validate patches BEFORE recording (target-changed → human review).
  // For a brand-new rule the real RUL id is minted by recordDecision below, so
  // validation uses a placeholder id (segment matching is a no-op then) and
  // the printable blocks are regenerated with the real id after recording. ----
  const previous = rule ? { version: rule.version, body: rule.body } : null
  const targetContexts = []
  for (const t of targets) {
    let content = null
    try {
      content = fs.readFileSync(t, "utf8")
    } catch {
      io.print(`rejected: target ${t} unreadable — target changed? Send for human review (never inferred as user deletion). No decision recorded.`)
      return { code: 1 }
    }
    try {
      generatePatch(content, { ruleId: rule?.id ?? "RUL-preview", version: nextVersion, body, previous })
      targetContexts.push({ path: t, candidate: candidates.find((x) => x.path === t), content })
    } catch (e) {
      io.print(`rejected: patch generation failed for target ${t} — ${e.message}`)
      io.print("no decision recorded; manually inspect the target file first.")
      return { code: 1 }
    }
  }

  // ---- record ----
  const { decision, rule: newRule } = store.recordDecision({ kind: "approve", ruleId: rule?.id ?? null, object })
  if (issue) {
    try {
      store.upsertIssue({ id: issue.id, status: "approved" })
    } catch (e) {
      io.print(`warning: approval recorded (${decision.id}), but the candidate status update failed: ${e.message}`)
    }
  }
  if (scope.kind === "project") {
    try {
      store.upsertProject({ projectId: scope.projectId, directory: cwd, confirmDirectory: true })
    } catch (e) {
      io.print(`warning: directory confirmation registration failed: ${e.message}`)
    }
  }

  // Regenerate with the real rule id (new rules got one just now), then print.
  // formatRulePatch = the shared generate+format composition (step-1a: the
  // prepare_publish tool uses the exact same two calls, so tool and CLI patch
  // text are byte-identical by construction).
  const patches = targetContexts.map((tc) =>
    formatRulePatch({
      targetPath: tc.path,
      why: whyTarget(tc.candidate),
      scopePromise: describeScope(scope),
      trackedNote: tc.candidate.note,
      fileContent: tc.content,
      ruleId: newRule.id,
      version: newRule.version,
      body,
      previous,
    }),
  )

  io.print(`approval recorded: ${decision.id} → rule ${newRule.id} v${newRule.version} (object hash ${decision.objectHash.slice(0, 16)}…)`)
  for (const p of patches) io.print(p)
  io.print("════════════════════════════════════════════")
  io.print("approval success ≠ landed — paste the patch above into the target file manually (the plugin never writes to target files).")
  io.print("after manual application, the read-only check of the next digest will observe it as present.")
  return { code: 0, patches, ruleId: newRule.id }
}
