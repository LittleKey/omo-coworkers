// resolveHostApi third discovery source: self-socket + OPENCODE_PASSWORD.
//
// Live-host gap (measured 2026-10-24): a live opencode host spawned by the
// OpenChamber web UI writes NO service.json, so file-only discovery returned
// null and Bridge A degraded to MEMORY_CONFIRMATION_UNAVAILABLE. The fix: as
// the LAST source, derive the host port deterministically from
// /proc/self/fd socket inodes ∩ /proc/net/tcp(+tcp6) LISTEN rows — exactly
// one match or fail-closed null — authenticated by env OPENCODE_PASSWORD.
// All /proc I/O is injectable here; the tests never touch the real /proc.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { resolveHostApi } from "../lib/memory/confirm.mjs"

const b64 = (s) => Buffer.from(s).toString("base64")

/** Fake /proc state → injectable fdLister/netReader pair. `fds` are raw
 * readlink outputs ("socket:[N]"); the fake extracts inodes exactly like the
 * default fdLister does, so the injected contract (inode strings) holds. */
function fakeProc({ fds = [], listeners = [] } = {}) {
  return {
    fdLister: async () =>
      fds
        .map((s) => {
          const m = /^socket:\[(\d+)\]$/.exec(s)
          return m ? m[1] : null
        })
        .filter((s) => s !== null),
    netReader: async () => listeners, // parsed LISTEN rows: {port, inode}
  }
}

test("self-socket: single matching LISTEN + env password → resolves with correct base and Basic auth", async () => {
  const api = await resolveHostApi({
    env: { OPENCODE_PASSWORD: "live-pw" },
    ...fakeProc({ fds: ["socket:[111]", "pipe:[2]"], listeners: [{ port: 37563, inode: "111" }] }),
  })
  assert.ok(api, "must resolve")
  assert.equal(api.base, "http://127.0.0.1:37563")
  assert.equal(api.authHeader, `Basic ${b64("opencode:live-pw")}`)
  assert.equal(api.source, "self-socket")
})

test("self-socket: two matching listeners → null (fail-closed, never guess)", async () => {
  const api = await resolveHostApi({
    env: { OPENCODE_PASSWORD: "live-pw" },
    ...fakeProc({
      fds: ["socket:[111]", "socket:[222]"],
      listeners: [
        { port: 37563, inode: "111" },
        { port: 40921, inode: "222" },
      ],
    }),
  })
  assert.equal(api, null)
})

test("self-socket: zero matching listeners → null (no row, and no inode intersection)", async () => {
  const none = await resolveHostApi({
    env: { OPENCODE_PASSWORD: "live-pw" },
    ...fakeProc({ fds: ["socket:[111]"], listeners: [] }),
  })
  assert.equal(none, null)
  const noIntersection = await resolveHostApi({
    env: { OPENCODE_PASSWORD: "live-pw" },
    ...fakeProc({ fds: ["socket:[111]"], listeners: [{ port: 40921, inode: "999" }] }),
  })
  assert.equal(noIntersection, null)
})

test("self-socket: port resolvable but no OPENCODE_PASSWORD in env → null (port without credentials is unusable)", async () => {
  const api = await resolveHostApi({
    env: {},
    ...fakeProc({ fds: ["socket:[111]"], listeners: [{ port: 37563, inode: "111" }] }),
  })
  assert.equal(api, null)
  const emptyPw = await resolveHostApi({
    env: { OPENCODE_PASSWORD: "" },
    ...fakeProc({ fds: ["socket:[111]"], listeners: [{ port: 37563, inode: "111" }] }),
  })
  assert.equal(emptyPw, null)
})

test("self-socket: /proc read throws → null (fail-closed on non-Linux / permission errors)", async () => {
  const fdThrow = await resolveHostApi({
    env: { OPENCODE_PASSWORD: "live-pw" },
    fdLister: async () => {
      throw new Error("ENOENT /proc/self/fd")
    },
    netReader: async () => [{ port: 37563, inode: "111" }],
  })
  assert.equal(fdThrow, null)
  const netThrow = await resolveHostApi({
    env: { OPENCODE_PASSWORD: "live-pw" },
    fdLister: async () => ["socket:[111]"],
    netReader: async () => {
      throw new Error("EACCES /proc/net/tcp")
    },
  })
  assert.equal(netThrow, null)
})

test("priority: state service.json wins over self-socket; OPENCODE_SERVICE_JSON wins over the state file", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "svmem-confirm-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const statePath = path.join(dir, ".local", "state", "opencode", "service.json")
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  fs.writeFileSync(
    statePath,
    JSON.stringify({ id: "opencode", version: "2.1.4", url: "http://127.0.0.1:41001", pid: 1, password: "file-pw" }),
  )
  const proc = fakeProc({ fds: ["socket:[111]"], listeners: [{ port: 37563, inode: "111" }] })

  const fromState = await resolveHostApi({
    env: { HOME: dir, OPENCODE_PASSWORD: "env-pw" },
    readFile: fs.promises.readFile,
    ...proc,
  })
  assert.equal(fromState.source, statePath, "the state file must win over self-socket")
  assert.equal(fromState.base, "http://127.0.0.1:41001")
  assert.equal(fromState.authHeader, `Basic ${b64("opencode:file-pw")}`)

  const overridePath = path.join(dir, "override.json")
  fs.writeFileSync(overridePath, JSON.stringify({ port: 41002, password: "override-pw" }))
  const fromOverride = await resolveHostApi({
    env: { HOME: dir, OPENCODE_SERVICE_JSON: overridePath, OPENCODE_PASSWORD: "env-pw" },
    readFile: fs.promises.readFile,
    ...proc,
  })
  assert.equal(fromOverride.source, overridePath, "OPENCODE_SERVICE_JSON must stay first in the chain")
  assert.equal(fromOverride.base, "http://127.0.0.1:41002")
})

test("legacy .config password-only file is still skipped: no base derivable → self-socket supplies the API, never the legacy password", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "svmem-confirm-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const legacyPath = path.join(dir, ".config", "opencode", "service.json")
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true })
  fs.writeFileSync(legacyPath, JSON.stringify({ password: "stale-legacy-pw" }))
  const proc = fakeProc({ fds: ["socket:[111]"], listeners: [{ port: 37563, inode: "111" }] })

  const api = await resolveHostApi({
    env: { HOME: dir, OPENCODE_PASSWORD: "env-pw" },
    readFile: fs.promises.readFile,
    ...proc,
  })
  assert.ok(api, "self-socket must take over when only the legacy file exists")
  assert.equal(api.source, "self-socket")
  assert.equal(api.base, "http://127.0.0.1:37563")
  assert.equal(api.authHeader, `Basic ${b64("opencode:env-pw")}`, "the legacy password must NOT authenticate")

  const noListener = await resolveHostApi({
    env: { HOME: dir },
    readFile: fs.promises.readFile,
    ...fakeProc({ fds: ["socket:[111]"], listeners: [] }),
  })
  assert.equal(noListener, null, "legacy password-only file must not rescue discovery on its own")
})
