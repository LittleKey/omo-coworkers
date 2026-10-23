// Rebuildable digest views (P3 CLI writes, design II.1 "digest/ derived views
// only, never authoritative"). These are the ONLY files the CLI writes besides
// nothing — all store mutations go through lib/memory/store.mjs transactions.
// Stored under <root>/digest/ with 0600/0700 like the rest of the store.
//
// NOTE (v1 deviation, documented in README): the frozen P1 store has no draft
// field on issues, so draft bodies and draft-generation failure counts live in
// the rebuildable drafts.json view instead. Losing digest/ only loses draft
// texts — never authorization state.
import fs from "node:fs"
import path from "node:path"
import { DIR_DIGEST } from "../store.mjs"

function viewPath(root, name) {
  return path.join(root, DIR_DIGEST, name)
}

export function readView(root, name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(viewPath(root, name), "utf8"))
  } catch {
    return fallback
  }
}

export function writeView(root, name, obj) {
  const p = viewPath(root, name)
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 })
  const tmp = path.join(path.dirname(p), `.${path.basename(p)}.tmp-${Math.random().toString(16).slice(2, 10)}`)
  const fd = fs.openSync(tmp, "wx", 0o600)
  try {
    fs.writeSync(fd, JSON.stringify(obj, null, 2) + "\n")
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, p)
  fs.chmodSync(p, 0o600)
}

export function emptyDrafts() {
  return { drafts: {}, failures: {} }
}

export function readDrafts(root) {
  const v = readView(root, "drafts.json", null)
  const base = emptyDrafts()
  if (!v || typeof v !== "object") return base
  return {
    drafts: v.drafts && typeof v.drafts === "object" ? v.drafts : {},
    failures: v.failures && typeof v.failures === "object" ? v.failures : {},
  }
}

export function saveDraft(root, issueId, body, ts) {
  const v = readDrafts(root)
  v.drafts[issueId] = { body, ts }
  writeView(root, "drafts.json", v)
}

export function recordDraftFailure(root, issueId, reason, ts) {
  const v = readDrafts(root)
  const cur = Number.isInteger(v.failures[issueId]?.count) ? v.failures[issueId].count : 0
  const history = Array.isArray(v.failures[issueId]?.history) ? v.failures[issueId].history : []
  v.failures[issueId] = { count: cur + 1, history: [...history, { reason, ts }].slice(-20) }
  writeView(root, "drafts.json", v)
}
