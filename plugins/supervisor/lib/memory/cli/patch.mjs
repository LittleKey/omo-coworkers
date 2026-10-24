// P4 precise patch generation (m1-plan §3 P4, design I.8) — pure functions.
// ZERO filesystem access: every function takes and returns strings/objects.
// The CLI prints patches; the user applies them by hand (patch-human-apply).
//
// Managed segment format (v1.1 final, paired per-rule per-version markers;
// wrap idea from the v2.0 archive, version-scoped per the approved contract):
//
//   <!-- supervisor-memory:rule:<ruleId>:v<version> -->
//   <body — at most 10 lines>
//   <!-- /supervisor-memory:rule:<ruleId>:v<version> -->
//
// Oversized bodies fail the whole patch — never truncated. Malformed markers
// (open without close, nested, mismatched, duplicated) fail closed and are
// reported for human review. Presence comparison is blank-normalized
// (per-line trim, empty lines dropped) per design I.8.

export class PatchError extends Error {
  constructor(message, details) {
    super(message)
    this.name = "PatchError"
    if (details !== undefined) this.details = details
  }
}

export const BODY_MAX_LINES = 10

export function openMarker(ruleId, version) {
  return `<!-- supervisor-memory:rule:${ruleId}:v${version} -->`
}

export function closeMarker(ruleId, version) {
  return `<!-- /supervisor-memory:rule:${ruleId}:v${version} -->`
}

/** Blank-normalized text: per-line trim, empty lines dropped, joined with \n. */
export function normalizeBlank(text) {
  return String(text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n")
}

function bodyLinesOf(body) {
  const lines = String(body ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
  while (lines.length > 0 && lines[0].trim() === "") lines.shift()
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop()
  return lines
}

export function countBodyLines(body) {
  return bodyLinesOf(body).length
}

/** The exact managed segment text for one rule version. Throws on oversize. */
export function buildSegment(ruleId, version, body) {
  const lines = bodyLinesOf(body)
  if (lines.length === 0) throw new PatchError("rule body is empty — nothing to publish")
  if (lines.length > BODY_MAX_LINES) {
    throw new PatchError(
      `rule body is ${lines.length} lines (max ${BODY_MAX_LINES}) — whole patch fails, never truncated; shorten the body and re-approve`,
    )
  }
  return [openMarker(ruleId, version), ...lines, closeMarker(ruleId, version)].join("\n")
}

const OPEN_RE = /^<!--\s*supervisor-memory:rule:([^:\s]+):v(\d+)\s*-->\s*$/
const CLOSE_RE = /^<!--\s*\/supervisor-memory:rule:([^:\s]+):v(\d+)\s*-->\s*$/

/**
 * Parse every managed segment in a file. Errors fail closed: unknown marker
 * shapes are never silently ignored (v2.0 §3 spirit, kept under v1.1 rules).
 * Returns { segments: [{ruleId, version, startLine, endLine, bodyLines}],
 * errors: string[] } — line numbers are 0-based inclusive.
 */
export function findSegments(content) {
  const lines = String(content ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
  const segments = []
  const errors = []
  let cur = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const open = line.match(OPEN_RE)
    const close = line.match(CLOSE_RE)
    if (cur) {
      if (open) {
        errors.push(`line ${i + 1}: nested open marker while inside segment ${cur.ruleId}:v${cur.version}`)
        cur = null
        continue
      }
      if (close) {
        if (close[1] !== cur.ruleId || close[2] !== String(cur.version)) {
          errors.push(`line ${i + 1}: mismatched close marker ${close[1]}:v${close[2]} for open ${cur.ruleId}:v${cur.version}`)
          cur = null
          continue
        }
        segments.push({ ...cur, endLine: i })
        cur = null
        continue
      }
      cur.bodyLines.push(line)
      continue
    }
    if (close) {
      errors.push(`line ${i + 1}: close marker without open (${close[1]}:v${close[2]})`)
      continue
    }
    if (open) {
      if (segments.some((s) => s.ruleId === open[1] && s.version === Number(open[2]))) {
        errors.push(`line ${i + 1}: duplicate segment ${open[1]}:v${open[2]}`)
      }
      cur = { ruleId: open[1], version: Number(open[2]), startLine: i, bodyLines: [] }
    }
  }
  if (cur) {
    errors.push(`unterminated segment ${cur.ruleId}:v${cur.version} (open at line ${cur.startLine + 1}, no close marker)`)
  }
  return { segments, errors }
}

/**
 * Build a patch description for one target file. `previous` = the version the
 * decision replaces ({version, body}) or null for a first-time add.
 * Returns { action: "add"|"replace", anchor, block, removed?, notes[] }.
 * Throws PatchError on marker anomalies, oversize, or a target that no longer
 * matches the decision history (external change → human review).
 */
export function generatePatch(fileContent, { ruleId, version, body, previous }) {
  const { segments, errors } = findSegments(fileContent)
  if (errors.length > 0) {
    throw new PatchError(
      `managed-marker anomalies in target — fail-closed, needs human review: ${errors.join("; ")}`,
    )
  }
  const mine = segments.filter((s) => s.ruleId === ruleId)
  const block = buildSegment(ruleId, version, body)
  if (previous) {
    const old = mine.find((s) => s.version === previous.version)
    if (!old) {
      if (mine.length > 0) {
        throw new PatchError(
          `target carries ${ruleId}:v${mine.map((m) => m.version).join(",")} but the decision replaces v${previous.version} — target changed; send for human review`,
        )
      }
      return {
        action: "add",
        anchor: "append at end of file",
        block,
        notes: [
          `old v${previous.version} segment not found in target (never applied or already removed) — emitting an add instead`,
        ],
      }
    }
    if (
      previous.body !== undefined &&
      normalizeBlank(old.bodyLines.join("\n")) !== normalizeBlank(previous.body)
    ) {
      throw new PatchError(
        `target segment ${ruleId}:v${previous.version} content differs from the approved v${previous.version} body — target changed; send for human review`,
      )
    }
    return {
      action: "replace",
      anchor: `replace lines ${old.startLine + 1}-${old.endLine + 1}`,
      block,
      removed: old.bodyLines.join("\n"),
      notes: [],
    }
  }
  if (mine.length > 0) {
    throw new PatchError(
      `target already carries ${ruleId}:v${mine.map((m) => m.version).join(",")} but this approval has no previous version — target changed; send for human review`,
    )
  }
  return { action: "add", anchor: "append at end of file", block, notes: [] }
}

/**
 * Removal patch(es): the whole segment (any version) of this rule.
 * Returns an array (a rule may have several version segments present) or
 * null when no segment exists. Throws on marker anomalies (fail-closed).
 */
export function generateRemove(fileContent, { ruleId }) {
  const { segments, errors } = findSegments(fileContent)
  if (errors.length > 0) {
    throw new PatchError(`managed-marker anomalies — fail-closed, needs human review: ${errors.join("; ")}`)
  }
  const mine = segments.filter((s) => s.ruleId === ruleId)
  if (mine.length === 0) return null
  return mine.map((s) => ({
    action: "remove",
    anchor: `delete lines ${s.startLine + 1}-${s.endLine + 1}`,
    // Full verbatim segment (marker pair + body): the human must be able to
    // locate and delete the exact block by content, not just by line numbers.
    removed: [openMarker(s.ruleId, s.version), ...s.bodyLines, closeMarker(s.ruleId, s.version)].join("\n"),
    version: s.version,
    notes: [],
  }))
}

/**
 * Human-readable patch text with the mandatory boundary notes (target path /
 * why this target / scope promise / tracking status). Pure string output.
 */
export function formatPatch({ targetPath, why, scopePromise, tracked, patch }) {  const L = []
  L.push(`--- target: ${targetPath}`)
  L.push(`    why this target: ${why}`)
  L.push(`    scope promise: ${scopePromise}`)
  L.push(`    tracking: ${tracked}`)
  L.push(`    action: ${patch.action} — ${patch.anchor}`)
  for (const n of patch.notes ?? []) L.push(`    note: ${n}`)
  if (patch.removed !== undefined) {
    L.push(`    old content removed/replaced (${patch.removed.split("\n").length} lines):`)
    for (const l of patch.removed.split("\n")) L.push(`      | ${l}`)
  }
  if (patch.action !== "remove") {
    L.push(
      `    how to apply: take the whole block below and ${patch.action === "add" ? "append it to the end of the file" : "replace the old segment with it"} (manual paste; the plugin never writes to the target file):`,
    )
    L.push("    ──── COPY START ────")
    for (const l of patch.block.split("\n")) L.push(`    ${l}`)
    L.push("    ──── COPY END ────")
  }
  return L.join("\n")
}

/**
 * Shared single-target patch composition (generate + format) used by BOTH the
 * CLI approve printer (runApprove, byte-for-byte unchanged output) and the
 * memory_prepare_publish tool face (v6.0 Part III step 1a). Pure: takes and returns
 * strings, zero filesystem access. Throws PatchError from generatePatch on
 * marker anomalies, oversize, or a target that no longer matches the decision
 * history.
 */
export function formatRulePatch({
  targetPath,
  why,
  scopePromise,
  trackedNote,
  fileContent,
  ruleId,
  version,
  body,
  previous,
}) {
  return formatPatch({
    targetPath,
    why,
    scopePromise,
    tracked: trackedNote,
    patch: generatePatch(fileContent, { ruleId, version, body, previous }),
  })
}

/**
 * Shared per-target removal-patch composition (generateRemove + formatPatch) —
 * the removal counterpart of formatRulePatch (R33 phase 4). The CLI disable
 * printer (runDisable in cli.mjs) uses generateRemove + formatPatch directly
 * with the same arguments, so tool and CLI removal-patch text are
 * byte-identical by construction. Pure: takes and returns strings, zero
 * filesystem access. Returns [] when the target carries no segment of this
 * rule (never applied, or already removed); throws PatchError from
 * generateRemove on marker anomalies (fail-closed). When trackedNote is
 * omitted it falls back to the CLI disable printer's own per-patch default
 * (the patch notes, or "see file").
 */
export function formatRuleRemovePatch({ targetPath, why, scopePromise, trackedNote, fileContent, ruleId }) {
  const removals = generateRemove(fileContent, { ruleId })
  if (!removals) return []
  return removals.map((p) => ({
    version: p.version,
    text: formatPatch({
      targetPath,
      why,
      scopePromise,
      tracked: trackedNote !== undefined ? trackedNote : (p.notes?.join("; ") || "see file"),
      patch: p,
    }),
  }))
}
