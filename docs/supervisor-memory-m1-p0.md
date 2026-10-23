# Supervisor Memory — M1 P0 回填 (A1/A2)

> P0 spike 实测于 2026-10-22, 宿主 opencode v2.1.2 (anomalyco/opencode, bun 编译)。
> 全隔离探针 (独立 `$HOME` + mock provider), 生产 DB 仅只读访问, supervisor 源码与部署副本零改动。
> 完整证据与工件路径: `/tmp/opencode/m1-p0/report.md`。总判定: **五门槛 + A2 全部通过, 建议进入 P1**。

## A1. v2 工具注册 / 身份 / 消息读取实测面 (五门槛逐项结论)

### 门槛① 最小工具注册 + 调用回执 + memory.enable 开关 — 通过

- 注册面: `ctx.tool.transform(editor => editor.add({ name, description, input: <JSON Schema>, options, execute }))`; `ctx.tool` 面 = {transform, reload, list, hook}。
- 真实调用链路全通 (ON 实例): 线上工具表出现 `m1_ping`/`m1_evidence` (12 内置 → 14) → mock 下发 tool_call → execute 回执落 `receipt.jsonl` (`{input, contextKeys:[sessionID,agent,messageID,id,progress,signal]}`) → 下一请求 loopback `role:"tool"`。
- **宿主行为 1 (必守)**: 插件工具默认被折叠进 code-mode 合成 "execute" 工具, 点名直呼报 `No tool named "X" is currently available.`; 必须 `options: { codemode: false }` 才作为 direct JSON-schema 工具直出 (`packages/core/src/tool.ts` L236-251)。
- **宿主行为 2 (必守)**: transform 注册后必须 `await ctx.tool.reload()` 重建 per-request 快照, 否则首个模型请求工具表不含新工具。
- 配置开关: `ctx.options.memory.enable` (`===true` 才注册, 默认 off) 实测两态差异 — ON: 工具出现且可调用; OFF: `tools.skipped`, 线上 12 内置工具, 无 m1_*。

### 门槛② 宿主身份可靠性 — 通过

- **project 身份可从宿主直接获得: `ctx.location.project.id`** (location=[directory,workspaceID,project]), 无需查 DB。实测与隔离 DB 交叉验证一致: 探针会话 `ses_e9891ef63ffeTBBK3dcBZc9YEx` 的 `session_v2.project_id` = `ctx.location.project.id` = `2fb025a2ed05ded38351f1bdd904432aae66e5ec`。
- sessionID: context event 与 tool execute context 均有; agent: `event.agent` / `context.agent`; parentID: 根会话 sessionInfo **无** `parentID` 键, 子会话有 → 根/子判别可行。
- 插件运行时为 **Bun** (typeof Bun=function; process.versions.node=26.3.0 为兼容层)。`node:sqlite` 与 `bun:sqlite` 均可 import; `node:sqlite` `DatabaseSync` 以 `readOnly:true` 打开 `<home>/.local/share/opencode/opencode.db` 实测成功 (生产级 ro 路径可用, 作为跨会话证据面)。

### 门槛③ 读取真实用户消息 (D4 双路径) — 通过

- **快路径**: `ctx.session.hook("context")` 的 `messages=[{id,role,content,metadata}]` 含真实用户消息及 id; 与 DB `session_message` 行 id 双源一致。
- **跨会话路径** (ro DB, 判据字段确认): 表 `session_message(id, session_id, type, seq, time_created, time_updated, data JSON)` + `session_v2(id, project_id, parent_id, agent, …)`; 用户消息 `type='user'`, 文本在 `json_extract(m.data,'$.text')`。SQL:

```sql
SELECT m.id mid, m.session_id sid, m.type mtype, s.project_id pid,
       s.parent_id parent, s.agent agent,
       json_extract(m.data,'$.text') text
FROM session_message m LEFT JOIN session_v2 s ON s.id = m.session_id
WHERE m.id = ?;
```

- 三判例实测 (m1_evidence 工具): ①异会话同 project type=user → **accept**; ②type=assistant → **reject**; ③宿主 DB 不存在的 id → **reject (fail-closed)**。D4 证据校验的双路径成立。

### 门槛④ 现有 supervisor 测试全套 — 通过

- `node --test test/unit.test.mjs test/v2-context.test.mjs` → **49/49 pass**。
- `node test/e2e.mjs inject` → 全部 PASS (恰一次注入、title 请求零污染、binding summary 存在); `node test/e2e.mjs observe` → **7/7 PASS** (零 nudge marker)。
- e2e 夹具 `/tmp/opencode/probe2/home` 原缺失, 已重建为最小空 home (provider SDK 走 npm 网络), harness 其余不变 (默认 OPENCODE_BIN=1.18.35 + index.v1.mjs)。

### 门槛⑤ memory 开/关两态下 supervisor 行为不变 + 同场互不干扰 — 通过

- 同对话脚本 ON/OFF 各跑一次: per-run log kinds 完全一致 `{plugin_init:1, user_turn:1, l0_hit:1, transform_eval:1, injected:1}`; injected 记录仅 `t`/`sessionId` 不同, `ruleId`/`turn`/`len=333` 相同 (注入文本等长)。
- m1-probe 与 supervisor 同场加载的全部 run 中 supervisor kinds 配比不变 — 探针工具注册不影响注入链。

## A2. AGENTS/CLAUDE 加载回落顺序 — 已源码+现场双重确认

真实仓库为 **github.com/anomalyco/opencode** (v2.1.2 二进制 strings 8 次; sst/opencode 0 次)。

1. **仅 CLAUDE.md → 不加载。** 源码: 指令收集只认 `AGENTS.md` 目标 (`packages/core/src/config/plugin/instruction.ts` L84-94 `fs.up({targets:["AGENTS.md"]})`); 文档明示 "OpenCode V2 recognizes AGENTS.md only. It does not use CLAUDE.md as a fallback." (`instructions.mdx` L42); 二进制中 CLAUDE.md 仅出现在 bun 内部串/模板列表//init 提示词, 无加载代码。现场: 仅 CLAUDE.md 存在期间 15+ 请求 system 零出现其标记。
2. **两者都在 → 只有 AGENTS.md 生效** (无"优先级"问题, CLAUDE.md 根本不在候选集)。现场: AGENTS.md 建立后 system 只含其内容, CLAUDE.md 标记仍缺席。
3. **合并顺序** (`instruction.ts` L39-58, L182-192; `instruction-discovery.ts` L30-31): 全局 `~/.config/opencode/AGENTS.md` → 项目自 cwd 向上最近→最远 (止于 project root / home 边界, `ancestorDirectories` L240-243) → config `instructions` 条目 (URL/glob/scan, 排序去重)。渲染为 `Instructions from: <path>\n<content>`, 以空行拼接 (discovery L123-125)。现场捕获顺序: global (AGMARKER-GLOBAL) 先, project (AGMARKER-PROJ) 后 ✓。
4. **fail-closed**: 项目文件读失败 (NotFound) → 整个指令源 unavailable → `editor.unavailable()` 即**完全无指令**, 连全局一起失效 (L92, L219-225)。

**对 M1 的含义**: memory 模块若以指令文件承载说明, 只能依赖 AGENTS.md; 注入链本身走 `ctx.session.hook("context")`, 与指令文件机制独立, 不受此回落影响。D8 相关表述可据此去含糊化。
