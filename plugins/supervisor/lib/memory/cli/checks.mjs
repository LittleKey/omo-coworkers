// D9 read-only check: presence/absence of published bodies in known target
// files, blank-normalized (design I.8). Three states are kept separate:
//   approved         — active rule whose publishResult says applied (应在场)
//   awaiting-apply   — active rule, application not yet recorded (待人工应用)
//   readonly-*       — disabled rules and old-version bodies (应离场)
// Drift/residue are REPORTED, never rewritten. A marker segment whose content
// no longer matches the recorded body is "target changed" → human review —
// never interpreted as "the user deleted the body" (D8).
import fs from "node:fs"
import { findSegments, normalizeBlank } from "./patch.mjs"

function readFileOrNull(p) {
  try {
    return fs.readFileSync(p, "utf8")
  } catch {
    return null
  }
}

const isPresent = (observed) => observed === "present" || observed === "present-unmarked"
const closed = (observed) =>
  observed === "target-missing" || observed === "target-changed" || observed === "marker-anomaly"

/**
 * @param rules current rules incl. disabled (store.listRules())
 * @param decisions all decisions (store.listDecisions())
 * @returns {{rows: Array, reviewNeeded: Array}}
 */
export function readonlyCheck(rules, decisions) {
  const rows = []
  const reviewNeeded = []
  // Records: current rules + historical approval bodies (old versions).
  // The store keeps current state only; past bodies come from the decision log.
  const records = []
  // Version lineage: bump/enable decisions carry ruleId, but the minting (v1)
  // approve decision persists ruleId null — the rule did not exist yet. The
  // store (frozen for M1) keeps no back-link; the only join is the shared
  // transaction timestamp frozen into rule.createdAtTs. A same-ms collision
  // could at worst add a spurious report-only row (never a write).
  const mintByTs = new Map()
  for (const d of decisions) {
    if (d.kind === "approve" && d.ruleId === null && d.object) mintByTs.set(d.ts, d)
  }
  for (const r of rules) {
    records.push({
      ruleId: r.id,
      version: r.version,
      body: r.body,
      targets: r.targets ?? [],
      state:
        r.status === "active"
          ? r.publishResult?.applied === true
            ? "approved"
            : "awaiting-apply"
          : "readonly-disabled",
    })
    const past = decisions.filter(
      (d) =>
        d.ruleId === r.id &&
        (d.kind === "approve" || d.kind === "enable") &&
        d.object &&
        normalizeBlank(d.object.body) !== normalizeBlank(r.body),
    )
    const mint = mintByTs.get(r.createdAtTs)
    if (mint && normalizeBlank(mint.object.body) !== normalizeBlank(r.body) && !past.includes(mint)) {
      past.unshift(mint)
    }
    for (const d of past) {
      records.push({
        ruleId: r.id,
        version: null,
        body: d.object.body,
        targets: d.object.targets ?? [],
        state: "readonly-old-version",
      })
    }
  }
  const seen = new Set()
  for (const rec of records) {
    for (const t of rec.targets) {
      const key = `${rec.ruleId}|${rec.version ?? "old"}|${rec.state}|${t}`
      if (seen.has(key)) continue
      seen.add(key)
      const content = readFileOrNull(t)
      let observed
      if (content === null) {
        observed = "target-missing"
      } else {
        const { segments, errors } = findSegments(content)
        if (errors.length > 0) {
          observed = "marker-anomaly"
        } else {
          const seg = segments.find(
            (s) => s.ruleId === rec.ruleId && (rec.version === null || s.version === rec.version),
          )
          const segBody = seg ? normalizeBlank(seg.bodyLines.join("\n")) : null
          const bodyPresent = normalizeBlank(content).includes(normalizeBlank(rec.body))
          if (seg && segBody !== normalizeBlank(rec.body)) observed = "target-changed"
          else if (seg) observed = "present"
          else if (bodyPresent) observed = "present-unmarked"
          else if (segments.some((s) => s.ruleId === rec.ruleId)) observed = "other-version"
          else observed = "absent"
        }
      }
      const expected = rec.state === "approved" || rec.state === "awaiting-apply" ? "present" : "absent"
      const row = {
        ruleId: rec.ruleId,
        version: rec.version,
        state: rec.state,
        target: t,
        expected,
        observed,
        drift:
          rec.state === "approved" && !isPresent(observed) && !closed(observed)
            ? observed
            : null,
        residue:
          (rec.state === "readonly-disabled" || rec.state === "readonly-old-version") && isPresent(observed)
            ? observed
            : null,
        note:
          rec.state === "awaiting-apply" && isPresent(observed)
            ? "observed present — looks manually applied but the publish result was never recorded"
            : null,
      }
      rows.push(row)
      // Human review (D9): marker anomalies and target-changed bodies are
      // always fail-closed; for an applied approval, ANY absence/mismatch of
      // the expected segment contradicts the recorded publish result → the
      // target has been changed externally → send for human review, never
      // inferred as "the user deleted the body".
      if (
        observed === "marker-anomaly" ||
        observed === "target-changed" ||
        (rec.state === "approved" && observed !== "present")
      ) {
        reviewNeeded.push(row)
      }
    }
  }
  return { rows, reviewNeeded }
}
