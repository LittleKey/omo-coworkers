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
 *
 * Third source (live-host gap, measured 2026-10-24): a live host spawned by
 * the OpenChamber web UI (opencode 2.1.4, pid 2324027) writes NO service.json
 * — ~/.local/state/opencode/service.json absent, .config copy is a stale
 * legacy leftover — so file discovery alone returned null and Bridge A
 * degraded to MEMORY_CONFIRMATION_UNAVAILABLE (the phone-side approval
 * "refusals" in approval-audit.jsonl). That host does carry a valid
 * OPENCODE_PASSWORD in its environ, and the plugin runs INSIDE the host
 * process, so its listening port is deterministically derivable from
 * /proc: readlink(/proc/self/fd/*) socket:[inode] set ∩ /proc/net/tcp(+tcp6)
 * state==0A (LISTEN) rows — on the live host exactly one row matches
 * (port 37563, bound 127.0.0.1). Zero guessing: 0 or >1 matching listeners
 * → this source returns null (fail-closed), and a port without
 * OPENCODE_PASSWORD is likewise unusable → null. Non-Linux / permission /
 * shape anomalies are caught → null. Sources are tried in priority order:
 * OPENCODE_SERVICE_JSON > ~/.local/state/opencode/service.json >
 * ~/.config/opencode/service.json > self-socket+env. The two file sources'
 * logic and parsing are unchanged; no state is cached across calls, so a
 * host restart that changes the port is picked up on the next tool call.
 *
 * Returns {base, authHeader, source} or null when nothing resolvable exists
 * — callers degrade to MEMORY_CONFIRMATION_UNAVAILABLE (fall back to the
 * CLI), never guess a port. `fdLister`/`netReader` are injectable for tests;
 * the defaults read /proc/self/fd and /proc/net/tcp{,6} directly (self only —
 * never another pid's /proc; no ss/lsof subprocesses).
 */
export async function resolveHostApi({
  env = process.env,
  readFile = (p) => fs.readFileSync(p, "utf8"),
  fdLister = defaultFdLister,
  netReader = defaultNetReader,
} = {}) {
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
  return resolveSelfSocketApi({ env, fdLister, netReader })
}

/**
 * Self-socket discovery (third source, last priority): the only non-file way
 * to find the host is the process's own listening socket. Steps, all
 * fail-closed — any failure yields null, never a guessed port:
 *   ① fd inodes via `fdLister` (default: readlink /proc/self/fd/*,
 *     keep `socket:[N]` entries)
 *   ② listeners via `netReader` (default: /proc/net/tcp + /proc/net/tcp6,
 *     rows with state 0A = LISTEN, as {port, inode})
 *   ③ EXACTLY one listener whose inode ∈ ① → base=http://127.0.0.1:<port>;
 *     0 or >1 matches → null (ambiguous namespace would be a guess)
 *   ④ auth: env.OPENCODE_PASSWORD must exist → Basic base64("opencode:<pw>");
 *     without it a port alone is unusable → null.
 */
async function resolveSelfSocketApi({ env, fdLister, netReader }) {
  let inodes
  let listeners
  try {
    inodes = await fdLister()
    listeners = await netReader()
  } catch {
    return null // /proc unreadable (non-Linux, permissions) → fail-closed
  }
  if (!Array.isArray(inodes) || !Array.isArray(listeners)) return null
  const inodeSet = new Set(inodes.map(canonicalInode).filter((s) => s !== null))
  const hits = listeners.filter((l) => l && inodeSet.has(canonicalInode(l.inode)))
  if (hits.length !== 1) return null
  const port = hits[0].port
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  const password = env.OPENCODE_PASSWORD
  if (typeof password !== "string" || password.length === 0) return null
  return {
    base: `http://127.0.0.1:${port}`,
    authHeader: "Basic " + Buffer.from(`opencode:${password}`).toString("base64"),
    source: "self-socket",
  }
}

/** Canonical decimal form of a /proc inode string; null when not numeric. */
function canonicalInode(v) {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return String(v)
  if (typeof v === "string" && /^\d+$/.test(v)) return String(Number(v))
  return null
}

/** Default ①: socket inodes among THIS process's own fds (/proc/self/fd/*). */
async function defaultFdLister() {
  const dir = "/proc/self/fd"
  const names = fs.readdirSync(dir)
  const inodes = []
  for (const n of names) {
    let target
    try {
      target = fs.readlinkSync(`${dir}/${n}`)
    } catch {
      continue // fd vanished between readdir and readlink — skip, stay fail-closed
    }
    const m = /^socket:\[(\d+)\]$/.exec(target)
    if (m) inodes.push(m[1])
  }
  return inodes
}

/** Default ②: LISTEN rows of /proc/net/tcp and /proc/net/tcp6 (state 0A),
 * as {port, inode}. tcp6 absent (IPv6 disabled) is normal → skipped. */
async function defaultNetReader() {
  const listeners = []
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text
    try {
      text = fs.readFileSync(file, "utf8")
    } catch {
      continue
    }
    const lines = text.split("\n")
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].trim().split(/\s+/)
      // columns: sl local_address rem_address st … inode(9); st 0A = LISTEN
      if (parts.length < 10 || parts[3] !== "0A") continue
      const colon = parts[1].lastIndexOf(":")
      if (colon < 0) continue
      const port = Number.parseInt(parts[1].slice(colon + 1), 16) // port column is hex
      if (!Number.isInteger(port) || port <= 0 || port > 65535) continue
      listeners.push({ port, inode: parts[9] })
    }
  }
  return listeners
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
     * display (body, scope, channel, targets, review date, object hash,
     * deadline); it is carried verbatim in the field description so every
     * client sees the complete object, and in metadata for the audit trail.
     * `fieldTitle`/`confirmLabel`/`cancelLabel` are presentation-only; the
     * machine option VALUES stay CONFIRM_VALUE/CANCEL_VALUE — answer
     * adjudication always goes by value, never by label.
     */
    async createForm({ sessionID, title, display, objectHash, kind, fieldTitle = "Confirm?", confirmLabel = "Confirm", cancelLabel = "Cancel" }) {
      const field = {
        key: "choice",
        type: "string",
        title: fieldTitle,
        description: display,
        required: true,
        custom: false, // single choice only — no free-text answer can exist
        options: [
          { value: CONFIRM_VALUE, label: confirmLabel },
          { value: CANCEL_VALUE, label: cancelLabel },
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
 * Make dynamic metadata text (IDs, titles, paths) safe to embed on ONE
 * Markdown line inside the approval template: newlines and control characters
 * become spaces so such text can never start a new block (heading, list,
 * fence) and change the display's structure. Content is not re-ordered and
 * only trimmed at the ends.
 */
export function mdInlineSafe(v) {
  return String(v ?? "")
    .replace(/\r\n?|\n/g, " ")
    // eslint-disable-next-line no-control-regex -- intentional: strip control chars from untrusted metadata
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ")
    .trim()
}

/**
 * Length-adaptive code fence: the fence must be strictly longer than the
 * longest run of backticks inside the body, otherwise the body could close
 * the fence early and render the rest as template prose. Max(3, L+1).
 */
function fenceFor(text) {
  let longest = 0
  const runs = String(text).match(/`+/g)
  if (runs) for (const run of runs) if (run.length > longest) longest = run.length
  return "`".repeat(Math.max(3, longest + 1))
}

/**
 * 64-hex sha256 → four 16-char groups joined by single spaces (the display
 * shows the digest in four groups; concatenated they are the full fingerprint).
 */
export function sha256Quads(hex) {
  const h = String(hex ?? "")
  if (!/^[0-9a-f]{64}$/.test(h)) {
    throw new Error(`buildApprovalDisplay: objectHash must be a 64-hex sha256 digest, got ${JSON.stringify(h.slice(0, 24))}`)
  }
  return `${h.slice(0, 16)} ${h.slice(16, 32)} ${h.slice(32, 48)} ${h.slice(48, 64)}`
}

function trackedStatusLabel(v) {
  return v === "已跟踪" || v === "未跟踪" ? v : "未知"
}

const COPY = {
  "approve:system-ride": {
    action: "**批准此规则版本；本次只记录批准，不开启投递、不写文件。**",
    effect:
      "另行授权投递后，跨会话持续加入匹配主会话每次模型请求的系统提示；直到停止投递、停用规则或重新批准新版。新版需要重新授权投递。",
    revocation: "停止投递或停用规则只停止后续追加，不清除已有历史回答或压缩摘要。",
  },
  "enable-delivery:system-ride": {
    action: "**授权此规则版本跨会话持续投递；不是仅在当前会话生效。**",
    effect: "本次确认授权后，将规则加入匹配主会话每次模型请求的系统提示；停止条件同上。",
    revocation: "停止投递或停用规则只停止后续追加，不清除已有历史回答或压缩摘要。",
  },
  "approve:patch-human-apply": {
    action: "**批准此规则版本；本次不生成补丁、不修改文件。**",
    effect: "另行生成补丁，由人工应用到下列文件；批准不等于已应用。",
    revocation:
      "停用规则不会删除已写入文件的内容；移除仍需人工应用移除补丁，也不会追溯清除历史回答或压缩摘要。",
  },
}

/**
 * Build the FULL display text shown to the user before the single Confirm /
 * Cancel choice — a Chinese Markdown template (headings ### and code fences
 * render reliably on mobile clients; bare line breaks do not, so every fact
 * is a list item or its own block). Branch copy is selected by
 * operation × channel and is the single source of truth: the enable-delivery
 * display never claims the confirmation "does not enable delivery".
 *
 * Adjudication requirements kept: full body text verbatim (no trim, no
 * indent, no escaping, no re-flow — inside a fence longer than any backtick
 * run in the body), effective scope, channel, agent restriction, absolute
 * target paths with Git tracking status, review date, the object hash the
 * confirmation binds to, the revocation boundary, and EXACTLY ONE real
 * deadline (epoch milliseconds > 0; anything else refuses rather than
 * rendering a bogus 1970 expiry).
 *
 * `targets` items: {path, tracked} where tracked is "已跟踪" | "未跟踪" |
 * anything else (rendered as "未知" — never guessed). `binding` (required for
 * enable-delivery): {ruleId, version, bodyHash}.
 */
export function buildApprovalDisplay({
  operation,
  objectLine,
  scopeDescription,
  channel,
  agents = null,
  targets = [],
  reviewDate,
  deadlineTs,
  objectHash,
  binding = null,
  body,
}) {
  if (operation !== "approve" && operation !== "enable-delivery") {
    throw new Error('buildApprovalDisplay: operation must be "approve" or "enable-delivery"')
  }
  if (channel !== "system-ride" && channel !== "patch-human-apply") {
    throw new Error(`buildApprovalDisplay: unknown channel ${JSON.stringify(channel)}`)
  }
  if (operation === "enable-delivery" && channel !== "system-ride") {
    throw new Error("buildApprovalDisplay: enable-delivery only applies to the system-ride channel")
  }
  if (!Number.isFinite(deadlineTs) || deadlineTs <= 0) {
    throw new Error(
      "buildApprovalDisplay: deadlineTs must be a real epoch-milliseconds value > 0 — a missing or zero deadline would render a wrong 1970 expiry, so this refuses instead",
    )
  }
  const copy = COPY[`${operation}:${channel}`]

  // ---- agents line ----
  let agentsCopy
  if (channel === "system-ride") {
    const list = (Array.isArray(agents) ? agents : []).map(mdInlineSafe).filter((s) => s.length > 0)
    agentsCopy = list.length > 0 ? list.join("、") : "不限代理"
  } else {
    agentsCopy = "静态文件不支持限定代理"
  }

  // ---- static targets section ----
  let targetsSection
  if (channel === "system-ride") {
    targetsSection = "- **静态目标：** 无；此通道不写文件。"
  } else {
    const rows = (Array.isArray(targets) ? targets : []).map((t) => {
      const p = typeof t === "string" ? t : t?.path
      const tracked = typeof t === "string" ? null : t?.tracked
      return `  - ${mdInlineSafe(p)}（Git 跟踪状态：${trackedStatusLabel(tracked)}）`
    })
    targetsSection = rows.length > 0 ? ["- **静态目标：**", ...rows].join("\n") : "- **静态目标：**（未提供）"
  }

  // ---- binding section ----
  const F = "```"
  const bindingSection = [
    "### 绑定信息",
    "- **对象指纹：** SHA-256；四组连起来即完整指纹。",
    "",
    F,
    sha256Quads(objectHash),
    F,
  ]
  if (operation === "enable-delivery") {
    const b = binding ?? {}
    bindingSection.push(
      `- **版本绑定：** 规则 ${mdInlineSafe(b.ruleId)}；当前版本 v${mdInlineSafe(b.version)}；通道 system-ride；正文指纹（SHA-256，四组连起来即完整指纹）：`,
      "",
      F,
      sha256Quads(b.bodyHash),
      F,
    )
  }

  // ---- verbatim body section ----
  const bodyText = typeof body === "string" ? body : String(body)
  const fence = fenceFor(bodyText)
  const bodySection = ["### 规则原文（完整）", "以下内容逐字展示，不做摘要或改写。", "", fence, bodyText, fence]

  const lines = [
    "### 本次确认",
    `- **操作：** ${copy.action}`,
    `- **对象：** ${mdInlineSafe(objectLine)}`,
    "",
    "### 适用范围与方式",
    `- **适用范围：** ${mdInlineSafe(scopeDescription)}`,
    `- **限定代理：** ${agentsCopy}`,
    `- **通道：** ${channel}`,
    `- **生效方式：** ${copy.effect}`,
    targetsSection,
    "",
    "### 时间与撤销",
    `- **复核日期：** ${mdInlineSafe(reviewDate)}；这是复核日期，不是自动失效日期。`,
    `- **确认截止：** ${new Date(deadlineTs).toISOString()}（UTC）。`,
    "- **取消或超时：** 不产生批准或投递授权，保留审计记录。",
    `- **撤销边界：** ${copy.revocation}`,
    "",
    ...bindingSection,
    "",
    ...bodySection,
  ]
  return lines.join("\n")
}

/** Validate a target path argument for the tool face: absolute, normalized; existence checked by callers. */
export function requireAbsoluteTarget(p) {
  if (typeof p !== "string" || p.length === 0) return null
  if (!isAbsolute(p)) return null
  return resolve(p)
}
