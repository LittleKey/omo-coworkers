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
    return { tracked: false, note: "git 不可用 — 按未跟踪对待" }
  }
  if (r.error) return { tracked: false, note: "git 不可用 — 按未跟踪对待" }
  if (r.status !== 0) return { tracked: false, note: "非 git 仓库 — 按未跟踪对待" }
  const tracked = r.stdout.trim().length > 0
  return { tracked, note: tracked ? "被 git 跟踪" : "git 未跟踪" }
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
        notes: d.confirmed ? [] : ["目录未确认(projects.json) — 选择即显式登记并确认"],
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
        notes: ["当前目录未登记于该 project_id — 选择即登记并确认"],
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
    return "user-global 规则 → 全局 ~/.config/opencode/AGENTS.md(实测 v2.1.2 仅加载 AGENTS.md, 全局最先合并 — A2)"
  }
  if (t.kind === "project") {
    return "project 规则 → 该项目目录根的 AGENTS.md(会话自 cwd 向上最近→最远合并, 子树内会话都继承根文件; 已按目录逐项确认)"
  }
  return "directory 规则 → 该目录自己的 AGENTS.md(仅 cwd 在其子树内的会话加载; 不回退到项目根文件)"
}
