# Supervisor-Nudge 设计方案 v1(评审快照,已被 v2 取代)

> **已取代**:本文件保留为 oracle 三审(SHA-256 `25a56b0d…` 绑定)与 claude 二轮评审的对象快照。双通道评审均否决 v1 原样实施;现行设计见 `docs/supervisor-nudge-design-v2.md`。

日期:2026-10-15 | 状态:已被取代(superseded)
范围:opencode 插件层 supervisor,观测 orchestrator 会话并在合适时机插入 nudge,由 orchestrator 终审决定是否调起 oracle/council/claude 等高级 agent。

## 0. 背景与三轮演进

**目标**:高级模型把关交付质量,频率适中——不过频(浪费 token、拖慢效率),不过少(漏掉关键把关)。

- **R1(oracle 裁决)**:三段式职责分离「观测 → 提醒 → orchestrator 终审」方向正确;否决常驻读全量 transcript 的 LLM supervisor(无 dispatch 基线、成本乘数、同源影子 orchestrator);确定性规则门优先;先取基线再建 nudge 层。
- **R2(oracle+claude 双通道)**:用户细化「按 orchestrator 每次输出触发、只看 orchestrator I/O」被双双否决原样实现;裁决:拆成**双触发点**(决策前路由提醒 vs 文本后措辞检查);措辞类问题生成端修复优先,hook 无法在用户看到之前拦截流式输出;全量历史重发不可取 → 状态摘要 + 增量。
- **R3(机制调查 + 运行验证)**:所有关键机制已在本机验证(见 §2 与两份导出证据),设计具备落地条件。

## 1. 设计思想(原则)

1. **职责分离**:supervisor 永不直接 dispatch 高级 agent;nudge 只是建议,终审与派发权始终在 orchestrator。
2. **确定性优先**:规则、门控、频控用确定性代码;LLM 只做分诊(triage)与抽样诊断,不放在热路径上。
3. **非侵入**:独立小插件模块;不改 omo dist 本体、不改 blackboard.ts 本体;新合成消息格式须进双方防伪白名单。
4. **失效安全(fail-safe)**:nudge 携带 as-of 版本键,过期即弃;预算封顶;防自触发(不响应自己注入的消息)。
5. **成本分层**:分诊用小模型(glm-5.3-flash);高级 agent 只在 orchestrator 终审通过后调起。
6. **可观测先行**:先日志后干预;上线由指标驱动(每百回合缺陷数、nudge 精度、漏报率、时延、token 成本)。

## 2. 架构(机制均已验证)

### 2.1 观测层
- 输入源:插件 `event` hook(进程内、无认证)或 `GET /event` SSE。实测一轮对话捕获 `message.updated`、`message.part.updated`、`message.part.delta`、`session.status/idle` 等全套事件。
- 消息结构:`{info: {id, role, sessionID, parentID, agent, model, cost, tokens, time}, parts: [...]}`;assistant parts 序列 `step-start → reasoning → text → step-finish`。
- 全量回读:`client.session.messages`(SDK 稳定接口);单条按 id `GET /session/{id}/message/{messageID}`;`opencode.db`(SQLite)只读兜底。
- **噪声过滤**:排除 OMO 合成的 `v2-usage:*` 前缀消息(无 parentID、无 parts、role 恒 assistant);busy 会话 fallback 重放会给 prompt 换新 messageID,以「出现更新的 user/assistant 消息」判旧。

### 2.2 判断层(不需要创建 task)
- **主通道(v2 宿主)**:`input.experimental_v2.generateText(prompt, modelRef)`——一次性、无会话、无痕;OMO `runSecondaryModel`(dist:60795)即此模式。
- **fallback(v1 宿主)**:judge 会话 + 同步 `session.prompt`(返回 `{info, parts}` 完整结果;可关全部工具、指定小模型);OMO v1 fallback 模式 = 隐藏 title 标记 + 用完删除。judge 会话可常驻复用,创建成本极低(body 仅 `title`/`parentID`)。
- 明确不存在:服务端无 session 的 `/generate`、`/complete` 路由(已从 1.18.35 二进制路由全表确认);`experimental.text.complete` 只是文本完成时的原地改写钩子,不能自带 prompt。
- 不采用:插件内直接 fetch provider(绕过 opencode 抽象、配置双份维护,仅留作应急)。

### 2.3 注入层(双通道互补)
- **busy 会话 → `noReply:true` 补写**:server 只持久化 user 消息、不进 LLM 循环(二进制源码确证);nudge 落进 transcript、下一轮自然可见,不触发立即回复。适合非紧急提醒排队。
- **idle 会话 → 唤醒**:v2 优先 `session.synthetic`(用户不可见);fallback `prompt_async`(实测 HTTP 204,消息正常进入处理)。
- 组合策略:busy → noReply 排队;idle → synthetic/prompt_async 唤醒。

### 2.4 失效绑定
- 模式仿 OMO `hostMessageOccurrenceID` = `djb2Hash(messageID+":"+taskID):sha256(terminalPayload)`。
- nudge 头部携带 `as-of: {sessionID, messageID, contentHash}`;应用前校验该 messageID 仍是会话最新 assistant 消息且 hash 未变,否则丢弃。
- 绑 messageId 不绑消息序号(compaction 可能裁剪 parts)。

### 2.5 状态管理
- 插件自管状态存 `~/.local/share/opencode/storage/plugin/<name>/`(有先例)。
- supervisor 输入 = **状态摘要 + 增量 delta**(滑动窗口),不做全量历史重发(成本随回合数二次膨胀)。

## 3. 触发模型(R2 裁决的双触发点)

- **T1 决策前路由提醒**:用户消息进入后、首个模型决策前;在失败事件、证据冲突、工件更新时再评估。目标是「无静态大段 prompt 插入也能按规则+实际请求调起 adviser」。
- **T2 文本后检查**:assistant 文本完成后(措辞/自造词检查通道;用户当前已搁置自造词需求,通道保留但默认关闭)。
- **频控边界**(初版):每个决策/证据版本最多 1 条 nudge;每会话运行中检查 ≤1 次;新用户输入使旧建议作废;合成提醒不产生新预算;审阅进行中不重复派发同类建议。

## 4. 分层分诊

| 层 | 执行者 | 成本 | 职责 |
|---|---|---|---|
| L0 | 确定性规则(事件计数/状态机/显式条件) | 零 | 明确条件直接出 nudge 或直接放行 |
| L1 | 便宜 LLM 分诊(glm-5.3-flash,经 generateText/judge 会话) | 低 | 仅 L0 未覆盖的模糊区;输入=状态摘要+增量;超时/预算尽 → 放行并记日志 |
| L2 | orchestrator 终审 | — | nudge 只是建议;高级 agent 调用由 orchestrator 发起并记录结果 |

adviser 分工:oracle = 技术风险/正确性验证;claude = 目标与框架挑战、跳出当前思路的方案建议;council = 多视角独立判断。非固定串行阶梯。

## 5. 已验证 / 遗留未知

**已运行验证**:prompt_async 204 端到端;SSE 事件流;session 创建/删除;外部访问需 HTTP Basic auth(插件内进程 fetch 无此问题);judge 会话等价路径。

**遗留未知(实施前需补验证)**:
1. busy 会话上 noReply 的排队-晋升行为(`session_input` 表存在 pending→promoted 机制,未运行验证)。
2. `experimental_v2.generateText` 在当前宿主 PluginInput 的实际可用性。
3. idle 唤醒时 synthetic 与可见 prompt 的降级行为。

## 6. 评审请求

- **oracle**:架构风险、失效模式、分层边界是否正确、与既有 OMO wake scheduler + blackboard nudge 通道的冲突面、遗留未知的优先级。
- **claude**:挑战最高杠杆假设、最简可靠实现路径、决定性权衡;特别关注:双触发点是否必要、L1 分诊是否值得在建基线之前实现。

## 附:证据

- `.opencode/bcp/exports/fc7fa61a-1da7-41e5-98a9-406e9b4431f9-9f3fb941-f2d8-43de-8331-5ca4e1a40f5f-e000002.json`(R3-1:omo-slim 直接 LLM 通道/promptAsync/事件字段/transcript SQLite)
- `.opencode/bcp/exports/fc7fa61a-1da7-41e5-98a9-406e9b4431f9-ae550bca-ce3d-4a77-b04a-2d9aaff5a426-e000001.json`(R3-2:opencode 插件直接调 LLM 能力面/凭据/运行时/存储)
- R1/R2 审阅记录:`bb://fc7fa61a-1da7-41e5-98a9-406e9b4431f9/9b6b5712-c8fb-453e-a86e-a048bcf810cb/e000001` 与 `.../e000002`;claude R2:`bb://fc7fa61a-1da7-41e5-98a9-406e9b4431f9/9dfb7b01-ad20-42d8-98e9-0c6fa826cefa/e000001`
