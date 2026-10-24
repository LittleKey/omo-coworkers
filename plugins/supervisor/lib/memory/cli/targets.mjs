// D8 target selection (three conditions: file exists + per-target user
// confirmation + verified load scope) and git-tracking checks.
//
// Load-scope model is the A2-verified OpenCode v2.1.2 behavior: AGENTS.md
// only (no CLAUDE.md fallback), merge order global ~/.config/opencode/AGENTS.md
// first, then project files from the session cwd upward (nearest → farthest).
// Therefore: user-global rules → the global file; project rules → that
// project directory's root AGENTS.md (subtree sessions inherit it); directory
// rules → that directory's own AGENTS.md (only sessions inside its subtree
// load it — never a fallback to the project root file).
//
// Read-only: nothing here creates or writes files (永不创建新文件).
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"

export function userGlobalAgentsPath(home) {
  return path.join(home, ".config", "opencode", "AGENTS.md")
}

export function fileExists(p) {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** Is <dir>/<relPath> tracked by git? Missing git / not a repo → untracked. */
export function gitTracked(dir, relPath) {
  let r
  try {
    r = spawnSync("git", ["-C", dir, "ls-files", "--", relPath], { encoding: "utf8", timeout: 5000 })
  } catch {
    return { tracked: false, note: "git unavailable — treated as untracked" }
  }
  if (r.error) return { tracked: false, note: "git unavailable — treated as untracked" }
  if (r.status !== 0) return { tracked: false, note: "not a git repository — treated as untracked" }
  const tracked = r.stdout.trim().length > 0
  return { tracked, note: tracked ? "git-tracked" : "not git-tracked" }
}

/**
 * Candidate targets for one approval (display + selection only — selection
 * and confirmation happen in approve stage 1; nothing here authorizes).
 * Order: project confirmed dirs → unconfirmed dirs → cwd (when unregistered).
 */
export function candidateTargets({ scope, projects, cwd, home }) {
  const out = []
  const push = (t) => {
    if (!out.some((x) => x.path === t.path)) out.push(t)
  }
  if (scope.kind === "user-global") {
    const p = userGlobalAgentsPath(home)
    push({
      path: p,
      kind: "user-global",
      directory: path.dirname(p),
      exists: fileExists(p),
      ...gitTracked(path.dirname(p), "AGENTS.md"),
      confirmedDir: null,
      notes: [],
    })
  } else if (scope.kind === "project") {
    const proj = (projects ?? []).find((p) => p.id === scope.projectId)
    for (const d of proj?.directories ?? []) {
      const p = path.join(d.path, "AGENTS.md")
      push({
        path: p,
        kind: "project",
        projectId: scope.projectId,
        directory: d.path,
        exists: fileExists(p),
        ...gitTracked(d.path, "AGENTS.md"),
        confirmedDir: d.confirmed === true,
        notes: d.confirmed ? [] : ["directory unconfirmed (projects.json) — selecting it registers and confirms it explicitly"],
      })
    }
    if (cwd && !(proj?.directories ?? []).some((d) => d.path === cwd)) {
      const p = path.join(cwd, "AGENTS.md")
      push({
        path: p,
        kind: "project",
        projectId: scope.projectId,
        directory: cwd,
        exists: fileExists(p),
        ...gitTracked(cwd, "AGENTS.md"),
        confirmedDir: false,
        notes: ["current directory not registered under this project_id — selecting it registers and confirms it"],
      })
    }
  } else if (scope.kind === "directory") {
    const p = path.join(scope.directory, "AGENTS.md")
    push({
      path: p,
      kind: "directory",
      directory: scope.directory,
      exists: fileExists(p),
      ...gitTracked(scope.directory, "AGENTS.md"),
      confirmedDir: null,
      notes: [],
    })
  }
  return out
}

/** Boundary note: why this file is the right target for this scope (A2). */
export function whyTarget(t) {
  if (t.kind === "user-global") {
    return "user-global rule → global ~/.config/opencode/AGENTS.md (measured on v2.1.2: only AGENTS.md is loaded, global merges first — A2)"
  }
  if (t.kind === "project") {
    return "project rule → the AGENTS.md at the project directory root (sessions merge nearest→farthest upward from cwd, sessions in the subtree all inherit the root file; confirmed per directory)"
  }
  return "directory rule → that directory's own AGENTS.md (loaded only by sessions whose cwd is inside its subtree; no fallback to the project root file)"
}
