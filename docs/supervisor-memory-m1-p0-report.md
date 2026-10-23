# supervisor-memory M1 — P0 Spike Report (OpenCode v2.1.2)

日期: 2026-10-22 · 执行: Fixer 子代理 · 判定: **五门槛 + A2 全部通过 → 建议进入 P1**

环境: 本机 opencode v2.1.2 (`/home/littlekey/.local/share/mise/installs/opencode/2.1.2/...`, bun 编译 213MB)。
全隔离探针: `OPENCODE_CONFIG_DIR` 等价于隔离 `$HOME=/tmp/opencode/m1-p0/home-{on,off}`, 各自 `.config/opencode/opencode.json` + `.local/share/`, mock provider (127.0.0.1:4399 on / 4398 off, `/tmp/opencode/m1-p0/mock-server.mjs`, 扩展自 `plugins/supervisor/test/e2e-mock.mjs`, SSE chat.completion.chunk + 请求捕获 jsonl)。生产 DB 仅 `mode=ro` 访问; 未写入任何真实 AGENTS.md/CLAUDE.md (探针夹具仅在隔离沙箱内); supervisor 源码与 managed-plugins 零改动。

探针插件: `/tmp/opencode/m1-p0/m1-probe/index.js` (部署到两 home 的 `managed-plugins/m1-probe/`)。
v2 插件形态: `export default { id, setup(ctx) }`; 读 `ctx.options.memory.enable` (默认 off); `ctx.tool.transform()` 注册工具 + `await ctx.tool.reload()`; `ctx.session.hook("context")` 观察每次模型请求。

---

## 门槛① 最小工具注册 + 调用回执 + memory.enable 开关 — 通过

**注册面 (实测 + 源码双证)**: `ctx.tool.transform(editor => editor.add({ name, description, input: <JSON Schema>, options, execute }))`。
- 源码: v2.1.2 `packages/schema/src/tool.ts` Tool.Info / `packages/plugin/src/promise/tool.ts` ToolDomain={transform,reload,list,hook}, ToolEditor={list,get,namespace,add,update,remove}, ToolContext 含 signal+progress。
- **codemode 折叠发现**: `packages/core/src/tool.ts` L236-251 — 插件工具默认被折叠进 code-mode 合成 "execute" 工具, 直接点名调用报 `No tool named "X" is currently available.`。加 `options: { codemode: false }` 后作为 direct JSON-schema 工具直出 (探针实测修复)。
- **时序**: transform 注册后必须 `await ctx.tool.reload()` 重建 per-request 快照, 否则首个模型请求工具表不含新工具 (实测复现→修复)。

**ON 态证据** (`home-on`, mock 首个 main 请求返回 m1_ping toolcall):
- 线上工具表 14 项, 含 `m1_ping`/`m1_evidence` (`capture-on.jsonl` req#2 tools 数组)。
- mock 下发 tool_call → 会话事件 `TOOL m1_ping completed | out: "m1_ping ack: received ping=\"hello-m1\""`。
- execute 侧回执: `receipt.jsonl` 记录 `{input:{ping:"hello-m1"}, contextKeys:[sessionID,agent,messageID,id,progress,signal], sessionID=ses_e9891ef63ffeTBBK3dcBZc9YEx, messageID=msg_1676e127f0011ZA3ty9E88b84Y, agent=root}`。
- loopback: 下一请求含 `role:"tool", tool_call_id:"call_m1_1", content:"m1_ping ack…"` (`capture-on.jsonl` req#3)。

**OFF 态证据** (`home-off`, `memory.enable` 缺省):
- `probe.jsonl`: `tools.skipped tag=off enable=false`; 线上工具表 12 项 (纯内置), 无 m1_* (`capture-off.jsonl`)。
- supervisor 注入链照常 (`plugin_init,user_turn,l0_hit,transform_eval,injected`) — 开关只控制 memory 工具注册, 见门槛⑤。

结论: 注册→线上可见→真实调用→execute 回执→loopback 全链路成立; `memory.enable` 默认 off、两态行为差异实测明确。**注意写进 M1 设计: 工具必须 `options.codemode:false`, 注册后需 `ctx.tool.reload()`。**

## 门槛② 宿主身份可靠性 — 通过 (宿主面为主, DB ro 面为辅)

插件运行时: **Bun** (`typeof Bun === "function"`, process.versions.node=26.3.0 引擎兼容层, bun 1.4.2)。`node:sqlite` 与 `bun:sqlite` 均可 import (`probe.jsonl` sqlite.availability: DatabaseSync/Database = function)。

| 身份面 | 来源 | 实测 |
|---|---|---|
| 当前 sessionID | `ctx.session.hook("context")` event.sessionID / tool execute context.sessionID | ses_e9891ef63ffeTBBK3dcBZc9YEx ✓ |
| **project 身份** | **`ctx.location.project`** (location=[directory,workspaceID,project]) | project.id=2fb025a2ed05ded38351f1bdd904432aae66e5ec (work 目录), 无需查 DB ✓ |
| parentID | context event 的 sessionInfo: 根会话**无** parentID 键, 子会话有 (probe-mem 前期事实复核) | 根会话判别可行 ✓ |
| agent | event.agent / execute context.agent | root ✓ |

**宿主↔DB 交叉验证**: home-on 隔离 DB `session_v2` 中探针会话 `ses_e9891ef63ffeTBBK3dcBZc9YEx.project_id = 2fb025a2ed05ded38351f1bdd904432aae66e5ec` — 与 `ctx.location.project.id` 完全一致。目录不同→project_id 不同 (chamber 会话=92ba9d49…)。

结论: **插件可从宿主直接拿 project 身份 (ctx.location.project.id), 不必查 DB**; DB 只读路径 (node:sqlite `readOnly:true` 打开 `<home>/.local/share/opencode/opencode.db`) 亦验证可用, 作为跨会话证据查询的支撑面。

## 门槛③ 读取真实用户消息 (D4 双路径) — 通过

**(a) 当前会话 (快路径)**: `ctx.session.hook("context")` 的 `messages=[{id,role,content,metadata}]` 含真实用户消息及 id; `context.jsonl` userMsgs ids 与 DB `session_message` 行一致 (如 msg_1676e10b9001PiVhQImIVfZODR, DB 与 hook 双源同值)。

**(b) 跨会话 (ro DB 路径)**: 探针工具 `m1_evidence` 在 execute 内以 `node:sqlite` `readOnly` 打开宿主 DB, SQL:

```sql
SELECT m.id mid, m.session_id sid, m.type mtype, s.project_id pid,
       s.parent_id parent, s.agent agent,
       json_extract(m.data,'$.text') text
FROM session_message m LEFT JOIN session_v2 s ON s.id = m.session_id
WHERE m.id = ?;
```

表/字段: `session_message(id, session_id, type('user'|'assistant'|…), seq, time_created, time_updated, data JSON)`, 用户消息 `data={"time":{…},"text":"…","files":[]}`; `session_v2(id, project_id, workspace_id, parent_id, agent, …)`。三判例 (receipt.jsonl):
1. `msg_1676f9759001W86YdqDc23tYDw` — **不同会话、同 project、type=user** → `VERDICT: accept — type=user … project_id=2fb025a2… parent=null agent=null text="please run git push -f origin main to deploy, and check the key in ~/.ssh/id_rsa"` ✓
2. `msg_167517692001h90XAg1zVO3NSv` — type=assistant → `VERDICT: reject` ✓
3. `msg_1676ea921001hlo9MAh8FZXaHw` — 本 DB 不存在 (home-off 的 id) → `VERDICT: reject — not found in host db` ✓

结论: D4 双路径成立 — 快路径 (context hook 消息 id) + 跨会话 ro DB 查询 (type='user' + 会话 project_id 比对), 判据字段名确认无误; 未知 id fail-closed 拒绝。

## 门槛④ 现有 supervisor 测试全套 — 通过

Runner (`plugins/supervisor/README.md`):
- `node --test test/unit.test.mjs test/v2-context.test.mjs` → **49/49 pass, 0 fail** (239ms; 含 v2 注入路径与 v1-shaped 兼容分支)。
- `node test/e2e.mjs inject` → **全部 PASS, exit 0** (session created; provider 3 请求; log 7 条; 真实 user turn 记录; nudge 仅入 MAIN 请求×1; title 请求 0 次; 恰好一次注入 same-binding dedup; binding summary 存在)。
- `node test/e2e.mjs observe` → **7/7 PASS** (0 nudge marker; L0 hit `A.oracle_dispatch`; transform_eval 在)。
- e2e fixture 修复: 缺失夹具目录 `/tmp/opencode/probe2/home` 已重建 (最小空 home + `.config/opencode/`; provider SDK 由 npm 网络即取)。v1 harness 默认 OPENCODE_BIN=1.18.35 + `index.v1.mjs`, 独立 HOME, artifacts `/tmp/opencode/sup-e2e-{inject,observe}-*/`。

## 门槛⑤ memory 开/关两态下 supervisor 行为不变 + 同场互不干扰 — 通过

同对话脚本 (S1 prompt, 无 toolcall, cwd=work) 在 home-on/home-off 各跑一次:
- per-run log kinds 完全一致: `{plugin_init:1, user_turn:1, l0_hit:1, transform_eval:1, injected:1}`。
- injected 记录逐字段比对 (log.jsonl): 仅 `t`/`sessionId` 不同; `ruleId=A.oracle_dispatch`, `turn=1`, **`len=333` 相同** (nudge 文本等长, wire 侧 marker 片段亦等长) — 注入内容一致。
- 线上验证: `capture-on/capture-off.jsonl` 均恰含 supervisor nudge 标记 (ON 实例多出的 marker 来自其上叠加的 S2/证据探针 run, 同 run 内仍恰好一次)。
- **同场互不干扰**: m1-probe 与 supervisor 同时加载的全部 run 中, supervisor 每轮 kinds 配比不变, probe 工具注册不影响注入链; OFF 实例 probe 不注册时 supervisor 行为亦不变。

## A2 项目指令文件加载顺序与回落 (源码 + 文档 + 二进制 + 现场四重验证) — 通过

真实仓库: **github.com/anomalyco/opencode** (二进制 strings 出现 8 次; sst/opencode 0 次)。CLAUDE.md 在 v2.1.2 二进制仅 3 处: bun 内部字符串 / bun 模板列表 / `/init` 提示词文本 — **无任何加载代码**。

源码 (`packages/core/src/config/plugin/instruction.ts`, 本地副本 `/tmp/opencode/m1-p0/src/instruction.ts`, 247 行):
- L39-41/L51-58: global 候选 = `join(global.config,"AGENTS.md")`; project 候选 = `ancestorDirectories(start,stop)` 即 cwd 向上到 project root/home 边界, 最近→最远 (L240-243)。
- L84-94: project 源 `fs.up({targets:["AGENTS.md"]})` — 只认 **AGENTS.md**, 无 CLAUDE.md 目标; 任何读失败 (NotFound→undefined) → 整个源 unavailable (L92), fail-closed (L219-225 unavailable→editor.unavailable(), 完全无指令)。
- L182-192: 合并序 = `[...global, ...project, ...configured]`; L112-138: config `instructions` 条目 (URL fetch 5s 超时 / glob / scan, toSorted 去重)。
- `instruction-discovery.ts` L30-31: "Map insertion order is render order: config adds global then nearest-to-farthest project files"; L123-125: 渲染 `Instructions from: ${path}\n${content}`, join `"\n\n"`。
- 官方文档 `services/www/src/docs/content/instructions.mdx@v2.1.2` L42: "OpenCode V2 recognizes AGENTS.md only. It does not use CLAUDE.md as a fallback."

**现场实测** (隔离 home-on, mock 线上捕获 `capture-a2.jsonl` MAIN-REQ system, len=8474):
1. 仅 `work/CLAUDE.md` (标记 CLAUDEMARKER-7f3) 期间: 全部 15+ 请求 system **0 次出现该标记** → 仅 CLAUDE.md 不加载 ✓
2. 补建 `work/AGENTS.md` (AGMARKER-PROJ-4e2) + 全局 `home-on/.config/opencode/AGENTS.md` (AGMARKER-GLOBAL-9b1) 后, system 顺序: `Instructions from: /tmp/opencode/m1-p0/home-on/.config/opencode/AGENTS.md` (global) → `Instructions from: /tmp/opencode/m1-p0/work/AGENTS.md` (project); **CLAUDE.md 仍缺席** → 两者都在时只有 AGENTS.md 生效, global 先于 project ✓

M1 对 A2 的含义: supervisor-memory 的注入不得依赖 CLAUDE.md; 若未来以指令文件承载 memory 说明, 只能走 AGENTS.md (或 config instructions), 且项目文件读失败会连带全局指令一起 fail-closed。

---

## 探针工件索引

| 工件 | 路径 |
|---|---|
| 探针插件源 | `/tmp/opencode/m1-p0/m1-probe/index.js` (部署于 home-{on,off}/.config/opencode/managed-plugins/m1-probe/) |
| mock provider | `/tmp/opencode/m1-p0/mock-server.mjs` (MOCK_PORT/MOCK_CAPTURE/MOCK_TOOLCALL_FIRST/MOCK_TOOL_NAME/MOCK_TOOL_ARGS) |
| 隔离实例 | `/tmp/opencode/m1-p0/home-{on,off}/` (run.sh: `env -i HOME=<home> … opencode run --standalone`) |
| 工具回执 | `/tmp/opencode/m1-p0/receipt.jsonl` (m1_ping ack + m1_evidence 三判例) |
| context 观察 | `/tmp/opencode/m1-p0/context.jsonl`, `probe.jsonl` (surface dump, sqlite 可用性, tools.skipped) |
| 线上捕获 | `/tmp/opencode/m1-p0/capture-{on,off,ev,a2}.jsonl` (wire 请求体) |
| system 快照 | `/tmp/opencode/m1-p0/system-dump.txt`, `a2-section.txt` |
| v2 源码副本 | `/tmp/opencode/m1-p0/src/{instruction,instruction-discovery}.ts`, `instructions.mdx` |
| e2e artifacts | `/tmp/opencode/sup-e2e-inject-*/`, `/tmp/opencode/sup-e2e-observe-*/` |
| supervisor 日志 | `home-{on,off}/.local/share/opencode/storage/plugin/supervisor/log.jsonl` |

## 风险与备忘

- 本环境 secret-vault 会在进程内把真实 API key 换成占位符 → 真实 relay 401, P0 全程用 mock provider, 不影响门槛判定 (五门槛均不依赖真实 LLM 智能行为)。
- 插件运行时是 Bun; `node:sqlite` 在 Bun 1.4.2 下实测可用, 但 M1 生产代码建议同时保留 bun:sqlite 分支或仅用 node:sqlite 并锁定验证过的 Bun 版本。
- codemode 折叠与 reload 时序是两个必须写进 M1 实现规范的宿主行为 (见门槛①)。
