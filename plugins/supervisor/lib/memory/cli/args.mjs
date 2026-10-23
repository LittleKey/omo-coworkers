// Tiny argv parser for bin/supervisor-memory.mjs (P3 CLI).
// Supports: --flag value, --flag=value, boolean --flag, "--" terminator.
// Everything after "--" is positional; unknown flags are booleans.
const VALUE_FLAGS = new Set([
  "root",
  "week",
  "spent-min",
  "dup-burden",
  "missed-exp",
  "manual-increment",
])

export function parseArgs(argv) {
  const flags = {}
  const pos = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--") {
      pos.push(...argv.slice(i + 1))
      break
    }
    if (a.startsWith("--") && a.length > 2) {
      const body = a.slice(2)
      const eq = body.indexOf("=")
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1)
        continue
      }
      if (VALUE_FLAGS.has(body) && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        flags[body] = argv[++i]
      } else {
        flags[body] = true
      }
      continue
    }
    pos.push(a)
  }
  return { flags, pos }
}
