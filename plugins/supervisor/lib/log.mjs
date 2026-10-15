// Observe log: JSONL with size-based rotation (spec item 8).
// Default path ~/.local/share/opencode/storage/plugin/supervisor/log.jsonl,
// 5 MB rotation to log.jsonl.1 (single previous generation kept).
// Appends are synchronous and never throw — supervisor failures must not
// abort the host.

import fs from "node:fs"
import path from "node:path"

export function createObserveLog({ logPath, logMaxBytes }) {
  let bytes = 0
  let disabled = false
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    bytes = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0
  } catch {
    // Unwritable destination: stay functional, drop log lines only.
    disabled = true
  }

  function rotate() {
    try {
      fs.renameSync(logPath, logPath + ".1")
      bytes = 0
    } catch {
      try {
        fs.unlinkSync(logPath)
        bytes = 0
      } catch {
        disabled = true
      }
    }
  }

  function write(entry) {
    if (disabled) return
    let line
    try {
      line = JSON.stringify({ t: Date.now(), ...entry }) + "\n"
    } catch {
      return
    }
    try {
      if (bytes > 0 && bytes + Buffer.byteLength(line) > logMaxBytes) rotate()
      if (disabled) return
      fs.appendFileSync(logPath, line)
      bytes += Buffer.byteLength(line)
    } catch {
      disabled = true
    }
  }

  function size() {
    return bytes
  }

  return { write, size }
}
