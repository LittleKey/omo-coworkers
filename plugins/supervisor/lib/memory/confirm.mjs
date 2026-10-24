// Bridge A adapter (oracle R33+ adjudication): the supervisor-memory approval
// tools ask the REAL user through the opencode server-side form/question HTTP
// API — the path proven end-to-end by the q-bridge probe
// (/tmp/opencode/q-bridge/report.md §A/§B1, artifacts + OpenAPI at
// /tmp/opencode/q-openapi.json). Bridge A only — no ctx.permission.assert
// mixing, no model-supplied confirmation: the model can NEVER provide
// `confirmed` / an answer / a hash / "the user agreed"; the only confirmation
// source is a form this module created against the frozen object, bound to
// the session, whose answer is read back from the host.
//
// Deadline semantics (adjudication, fixing the probe's late-answer race at
// qbridge/index.mjs:107-114): the deadline is checked BEFORE an answered
// state is accepted — both before each poll read and again right before an
// in-flight answered result is returned. On expiry the form is DELETEd; a
// failed DELETE still leaves the decision expired and unconsumable (a late
// answer can never feed a decision). Default wait 10 minutes, configurable
// cap 30 minutes; the per-request HTTP timeout is independent of the
// deadline.
//
// Single consumption: one formID can feed at most one decision — consume()
// throws on reuse, and every retry creates a brand-new form (fresh decision).

import fs from "node:fs"
import { isAbsolute, resolve } from "node:path"

export const CONFIRM_VALUE = "confirm"
export const CANCEL_VALUE = "cancel"

/** Default / maximum confirmation wait (adjudication: 10 min default, 30 cap). */
export const CONFIRM_DEFAULT_MIN = 10
export const CONFIRM_CAP_MIN = 30

export function clampConfirmTimeoutMin(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return CONFIRM_DEFAULT_MIN
  return Math.min(CONFIRM_CAP_MIN, Math.max(1, Math.round(n)))
}

/**
 * Host API discovery — probe-verified facts only (report §"版本注意" and the
 * probe plugin svc()): 2.1.4 writes `{id,version,url,pid,password}` to
 * $HOME/.local/state/opencode/service.json (port lives inside `url`); older
 * layouts carried `{port,password}`; one legacy file under .config holds only
 * the password. OPENCODE_SERVICE_JSON overrides the file path (tests).
 * Returns {base, authHeader} or null when nothing resolvable exists — callers
 * degrade to MEMORY_CONFIRMATION_UNAVAILABLE (fall back to the CLI), never
 * guess a port.
 */
export async function resolveHostApi({ env = process.env, readFile = (p) => fs.readFileSync(p, "utf8") } = {}) {
  const candidates = []
  if (env.OPENCODE_SERVICE_JSON) candidates.push(env.OPENCODE_SERVICE_JSON)
  const home = env.HOME ?? ""
  if (home) {
    candidates.push(`${home}/.local/state/opencode/service.json`)
    candidates.push(`${home}/.config/opencode/service.json`)
  }
  for (const p of candidates) {
    let doc = null
    try {
      doc = JSON.parse(await readFile(p, "utf8")) // works for sync AND async readFile
    } catch {
      continue
    }
    if (!doc || typeof doc !== "object") continue
    let base = null
    if (typeof doc.url === "string" && /^https?:\/\//.test(doc.url)) {
      base = doc.url.replace(/\/+$/, "")
    } else if (Number.isInteger(doc.port) && doc.port > 0) {
      base = `http://127.0.0.1:${doc.port}`
    }
    if (!base) continue
    const password = typeof doc.password === "string" ? doc.password : ""
    return { base, authHeader: "Basic " + Buffer.from(`opencode:${password}`).toString("base64"), source: p }
  }
  return null
}

/**
 * Create a Bridge A client. All I/O goes through `fetchImpl` (default global
 * fetch) so tests point it at a local mock server. Each instance owns a
 * consume-once registry: one formID → one decision, enforced per process.
 */
export function createConfirmBridge({
  base,
  authHeader,
  fetchImpl = globalThis.fetch,
  pollMs = 250,
  httpTimeoutMs = 5000,
  now = () => Date.now(),
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("createConfirmBridge: fetchImpl unavailable")
  const consumed = new Set()

  async function http(method, path, body) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new Error("confirm-bridge http timeout")), httpTimeoutMs)
    try {
      const res = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          ...(authHeader ? { authorization: authHeader } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ac.signal,
      })
      const text = await res.text()
      let json = null
      try {
        json = JSON.parse(text)
      } catch {
        json = null
      }
      return { status: res.status, ok: res.ok, json, text: text.slice(0, 500) }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Best-effort DELETE of a pending form. Never throws. */
  async function cancelFormBestEffort(sessionID, formID) {
    try {
      const r = await http("DELETE", `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}`)
      return { ok: r.ok, status: r.status }
    } catch (e) {
      return { ok: false, status: 0, error: String(e?.message ?? e) }
    }
  }

  /** Deadline expiry: DELETE the pending form; a failed DELETE still yields
   * an unconsumable "expired" (never a late answer). */
  async function expire(sessionID, formID) {
    const cleanup = await cancelFormBestEffort(sessionID, formID)
    return { status: "expired", cleanup: cleanup.ok ? "form-deleted" : `form-delete-failed(${cleanup.status ?? cleanup.error})` }
  }

  return {
    /** True when an answer for formID has already been consumed once. */
    isConsumed: (formID) => consumed.has(formID),

    /**
     * Mark formID consumed. Throws on reuse — one formID feeds exactly one
     * decision (adjudication: 单次消费).
     */
    consume(formID) {
      if (consumed.has(formID)) {
        const e = new Error(`form ${formID} was already consumed — one form feeds at most one decision; retry with a brand-new form`)
        e.code = "MEMORY_CONFIRMATION_REPLAY"
        throw e
      }
      consumed.add(formID)
    },

    /**
     * Create the single-choice Confirm/Cancel form against the host
     * (POST /api/session/{sid}/form). `display` is the FULL frozen object
     * text (body, scope, channel, absolute targets, review date, object
     * hash, revocation boundary); it is carried verbatim in the field
     * description so every client sees the complete object, and in metadata
     * for the audit trail.
     */
    async createForm({ sessionID, title, display, objectHash, kind }) {
      const field = {
        key: "choice",
        type: "string",
        title: "Confirm?",
        description: display,
        required: true,
        custom: false, // single choice only — no free-text answer can exist
        options: [
          { value: CONFIRM_VALUE, label: "Confirm" },
          { value: CANCEL_VALUE, label: "Cancel" },
        ],
      }
      const payload = {
        title,
        metadata: { kind: kind ?? "supervisor-memory-approval", objectHash },
        fields: [field],
      }
      const r = await http("POST", `/api/session/${encodeURIComponent(sessionID)}/form`, payload)
      if (!r.ok) {
        const e = new Error(`host form create failed: HTTP ${r.status} ${r.text.slice(0, 200)}`)
        e.code = "MEMORY_FORM_ERROR"
        e.httpStatus = r.status
        throw e
      }
      const formID = r.json?.id ?? r.json?.data?.id
      if (typeof formID !== "string" || formID.length === 0) {
        const e = new Error("host form create returned no form id — cannot bind a confirmation")
        e.code = "MEMORY_FORM_ERROR"
        throw e
      }
      return { formID }
    },

    /** Best-effort cancel of a still-pending form (DELETE). Never throws. */
    async cancelForm(sessionID, formID) {
      return cancelFormBestEffort(sessionID, formID)
    },

    /**
     * Poll until answered / cancelled / expired. Deadline is authoritative:
     * it is checked BEFORE each read and AGAIN before an answered state is
     * accepted, so a late answer (the probe's race) can never be consumed.
     * On expiry the pending form is DELETEd locally; a failed DELETE is
     * reported in `cleanup` but still yields an unconsumable "expired".
     */
    async waitAnswer({ sessionID, formID, deadlineTs }) {
      for (;;) {
        if (now() >= deadlineTs) return expire(sessionID, formID)
        let r
        try {
          r = await http("GET", `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}`)
        } catch (e) {
          // transient transport error — keep polling until the deadline
          if (now() >= deadlineTs) return expire(sessionID, formID)
          await sleep(pollMs)
          continue
        }
        if (r.status === 404) {
          // host lost the form (fork/cleanup elsewhere) → confirmation invalidated
          const e = new Error(`host form ${formID} no longer exists — confirmation invalidated`)
          e.code = "MEMORY_CONFIRMATION_STALE"
          throw e
        }
        if (!r.ok) {
          const e = new Error(`host form read failed: HTTP ${r.status} ${r.text.slice(0, 200)}`)
          e.code = "MEMORY_FORM_ERROR"
          throw e
        }
        const st = r.json?.data ?? r.json
        const status = st?.state?.status ?? st?.status
        if (status === "answered") {
          if (now() >= deadlineTs) return expire(sessionID, formID) // late answer → never consumed
          return { status: "answered", answer: st.state?.answer ?? st.answer }
        }
        if (status === "cancelled") return { status: "cancelled" }
        await sleep(pollMs)
      }
    },
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Build the FULL display text shown to the user before the single Confirm /
 * Cancel choice. Adjudication requirements: full body text, effective scope,
 * channel, agent restriction, absolute target paths, review date, the object
 * hash the confirmation binds to, and the revocation boundary (what cancel /
 * later disable can and cannot undo — history is never retroactively
 * removed; approval ≠ delivery ≠ applied).
 */
export function buildApprovalDisplay({
  headline,
  body,
  scopeDescription,
  channel,
  agents,
  targets,
  reviewDate,
  objectHash,
  deadlineTs,
  extraLines = [],
}) {
  const lines = []
  lines.push(`─ ${headline} ─`)
  lines.push("body (full, this exact text is what approval authorizes):")
  for (const l of String(body).split("\n")) lines.push(`  | ${l}`)
  lines.push(`effective scope: ${scopeDescription}`)
  if (channel === "system-ride") {
    lines.push(`agent restriction: ${Array.isArray(agents) && agents.length > 0 ? agents.join(", ") : "none (all agents)"}`)
    lines.push(
      "channel: system-ride — PERSISTENT system-prompt delivery across sessions, not just this session: the body is injected into every model request of matching sessions until delivery is disabled or the rule is re-approved to a new version. No file is ever written.",
    )
    lines.push("this approval alone does NOT enable delivery — delivery is a separate explicit authorization step.")
  } else {
    lines.push("agent restriction: none (AGENTS.md publishing cannot distinguish agents)")
    lines.push("channel: patch-human-apply — the patch is applied manually by a human; nothing is ever written by the tool. Approval ≠ applied.")
  }
  if (Array.isArray(targets) && targets.length > 0) {
    lines.push(`targets (absolute paths):`)
    for (const t of targets) lines.push(`  - ${t}`)
  } else {
    lines.push("targets: none (system-ride produces no static targets)")
  }
  lines.push(`review date: ${reviewDate}`)
  lines.push(`object hash (confirmation binding): ${objectHash}`)
  lines.push(...extraLines)
  lines.push("revocation boundary: Cancel records nothing. Later disable/withdrawal only STOPS appending — text already present in history answers or compressed summaries is never retroactively removed.")
  lines.push(`deadline: unanswered requests expire at ${new Date(deadlineTs).toISOString()} and record nothing.`)
  return lines.join("\n")
}

/** Validate a target path argument for the tool face: absolute, normalized; existence checked by callers. */
export function requireAbsoluteTarget(p) {
  if (typeof p !== "string" || p.length === 0) return null
  if (!isAbsolute(p)) return null
  return resolve(p)
}
