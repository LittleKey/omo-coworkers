# Supervisor-Nudge 设计方案 v2

日期:2026-10-15 | 状态:v2.1(已整合 oracle 四审 APPROVE WITH CHANGES,阶段一准入 PASS;四审记录 `bb://fc7fa61a…/9b6b5712…/e000004`,绑定修订前 SHA `331121fd…`,本版按其必改项修订)
取代:`docs/supervisor-nudge-design-v1.md`(v1 保留为评审快照,oracle 审阅绑定的 SHA-256 `25a56b0d…`)
范围:opencode 插件层 supervisor——观测 orchestrator 会话,在模型请求构造时同步注入候选建议,由 orchestrator 终审决定是否调起 oracle/council/claude 等高级 agent。

## 0. 背景与评审演进

**目标不变**:高级模型把关交付质量,频率适中(不过频浪费 token,不过少漏把关)。

- **R1(oracle)**:确立三段式职责分离;否决常驻读全量 transcript 的 LLM supervisor;确定性规则优先;基线先行。
- **R2(oracle+claude)**:否决 per-output 触发原样实现;拆双触发点;措辞问题生成端优先;拒绝全量历史重发。
- **R3(机制调查+运行验证)**:验证 prompt_async 204、SSE 事件流、judge 会话等价路径;固化 v1 文档。
- **R3.5(v1 双通道评审,双双否决 v1 原样实施)**:
  - oracle REJECT(作为实施契约):T1 时序承诺与异步投递机制不一致;messageId+sha256 不构成完整失效机制;`experimental_v2.generateText` 是 OMO 私有适配层字段而非标准 PluginInput;三种投递形式缺统一身份契约。记录 `bb://fc7fa61a…/9b6b5712…/e000003`。
  - claude:砍到 L0+日志;注入改 `experimental.chat.messages.transform`(同步、不落盘、天然新鲜,一个改动消除失效绑定+busy/idle 双通道+遗留未知#1)。记录 `bb://fc7fa61a…/9dfb7b01…/e000002`。
- **v2 前置验证(本次,live probe)**:transform 注入通道五项断言全过,详见 §6。

## 1. 设计思想(原则)

1. **职责分离**:supervisor 永不直接 dispatch;nudge 只是建议,终审与派发权在 orchestrator。
2. **确定性优先**:规则、门控、频控、失效校验全部确定性代码;LLM 只做分诊,不进热路径。
3. **同步注入优先**:建议在**模型请求构造时**同步校验并注入(不落 transcript),不承诺异步计算赶上本次首个决策。
4. **不干扰优先**:宁可漏掉一次可选建议,不抢占新用户请求、不复活已取消任务、不因 supervisor 失败 abort/replay 主任务。
5. **非侵入**:独立小插件;不改 omo dist、不改 blackboard.ts;能进既有白名单则进,不能则禁用该传输而非改本体。
6. **失效安全**:候选有显式生命周期;无法重建有效状态(compaction/revert/fork 后)默认不干预。
7. **成本分层+预算分离**:分诊用小模型;四桶预算分开计算(L1 调用费/唤醒主模型费/adviser 费/返工费)+ 总并发上限。
8. **最小数据与权限**:不读子 agent 内部过程;日志记规则、版本、结果、成本,不复制敏感上下文;judge 输出是低可信数据,不得变成高优先级指令或授予执行/审批权限。

**准入规则(硬约束)**:L0 未覆盖 ≠ 需要 L1;"L0 未命中"绝大多数是普通任务。L1 只服务**正向定义的模糊触发条件**(见 §4),且必须在基线证明存在 L0 漏报类之后启用。

## 2. 架构

### 2.1 观测层
- 输入源:进程内插件 `event` hook(单源,默认);SSE 仅作诊断替代,不双路订阅。
- 事件面(probe 实测一轮完整时序):`session.created → message.updated(user) → session.status → message.part.updated* → … → session.idle`;消息结构 `{info, parts}`,assistant parts 序列 `step-start → text → step-finish`(reasoning 可选)。
- **过滤规则**:仅监控根 orchestrator 会话(排除 councillor/child/judge 会话事件);排除 `v2-usage:*` 合成消息(无 parentID、无 parts、role 恒 assistant);fallback 重放换 messageID 时保守丢弃并重评估,不刷新预算。
- 全量回读:`client.session.messages`;`opencode.db` 仅作诊断,不作自动恢复运行上下文的兜底。

### 2.2 注入层(v2 核心变更)
**主通道:模型请求构造 hook 同步注入。**
- v1 宿主:`experimental.chat.messages.transform`——**已 live probe 验证**(§6):hook 在 provider 请求发出前同步执行(本轮 probe 为单一 user 消息场景,不外推"仅见已完成消息"为一般保证)、注入的合成消息到达 provider 请求、不进 transcript、不进 opencode.db、不影响正常回复循环。
- v2 宿主:`ctx.session.hook("context")`(未验证——当前无 v2 宿主)。
- 注入内容:当前有效、尚未消费的候选(文本 + 结构化元数据:候选 id、来源版本、规则版本、有效期)。
- 幂等控制:hook 每次模型请求都会触发(含工具循环的多次请求),同一候选每用户轮次至多注入一次,由候选状态机保证。
- 无下一次模型请求 → 等待,不自动唤醒。

**备选通道(默认关闭,按需启用)**:`noReply:true` 补写(busy 排队,下轮可见)、`session.synthetic` / `prompt_async`(idle 唤醒)。仅在需要跨轮持久或主动唤醒的场景,且通过阶段三对应验证后才启用。已知风险(oracle):noReply 落盘后无法从后续上下文撤销,compaction 可能折叠为"用户说过";OMO shim 的 promptAsync 默认 delivery=steer,非紧急建议不可直接用;idle 与 OMO orchestratorWake 双唤醒=重复回合;停止/取消/归档 ≠ idle。

### 2.3 判断层(能力探测驱动,不建 task)
- **v2 宿主**:独立插件在自己的 v2 setup 中探测并调用 `ctx.generate.text({prompt, model})`。**禁止导入 OMO 工厂借用其私有 `experimental_v2` shim**(oracle 举证:OMO 从 `ctx.generate?.text` 构造 wrapper 放入自造字段,dist:66003-66015、64071-64090;标准 PluginInput 无此字段——本次 probe 实证 PluginInput keys 仅 `["$","client","directory","experimental_workspace","project","serverUrl","worktree"]`)。
- **v1 宿主(当前)**:无 generate 能力 → 一次性、禁工具的 judge 会话(**不挂 parentID**——避免进入 OMO 子会话列表被 wake/reap 等待;排除出监控集合;用后删除;超时不停止底层调用,不得立即启第二套调用避免双计费)。
- 能力探测不支持组合 → **禁用 L1**,不假定可降级(OMO v2 shim 的 session.prompt 拒绝 agent/model/variant 覆盖,judge 指定小模型在 v2 并非天然等价)。
- 明确不做:插件内直接 fetch provider(仅留应急)。

### 2.4 候选生命周期(取代 v1 的"失效绑定")
状态机:`候选(candidate) → 待消费(pending) → 已注入(injected) / 已过期(expired)`,外加投递结果未知(unconfirmed)的显式处理。

- **校验执行点**:模型请求构造 hook 内,确定性代码完成(不依赖模型自觉忽略 as-of 标记)。
- **绑定键**:主会话 + 真实用户轮次/任务代次 + 决策/证据版本 + 规则版本。`messageID + contentHash` 仅作**来源版本**标注(主要供 T2 绑定被检查的 assistant 消息用;且只对已完成消息取 hash,流式中 hash 无意义)。
- 失效条件(应用前校验):出现更新的真实用户输入;任务代次/证据版本前进;规则版本更新;候选已被消费。
- 不照抄 OMO `djb2Hash` occurrence 编码——明确身份字段 + 来源 hash 更易审计。
- revert/fork/compaction 后无法重建有效状态 → 默认不干预。

### 2.5 状态管理
- 插件自管状态存 `~/.local/share/opencode/storage/plugin/<name>/`(有先例);supervisor 输入 = 状态摘要 + 增量 delta(滑动窗口),不做全量历史重发。

## 3. 触发模型

- **T1a(L0,同步)**:用户消息进入后,**在模型请求构造 hook 内**同步执行有界的本地确定性计算(不等待 LLM 或网络调用);记录新增处理耗时,不承诺零延迟。规则命中后仍须通过有效性、去重和预算校验才注入。
- **T1b(L1,异步)**:在满足正向分诊条件时异步形成候选。不等待、不延迟当前模型请求。候选仅可在绑定的真实用户轮次、任务代次及决策/证据版本仍有效时,于后续自然发生的模型请求构造点校验后使用;若没有后续请求,则不保证送达、不主动唤醒;出现新真实用户输入或版本变化时作废,不跨轮补投旧候选;后续重新分诊必须使用新快照并重新满足准入条件。异步调用完成时同样检查绑定版本,不得把已失效结果放回待消费。`injected` 只表示加入了某次请求上下文,不表示 provider 已成功处理、更不表示 orchestrator 已采纳。不补建可靠消息队列,可选提醒允许保守丢弃。
- **T2(文本后检查)**:保留设计边界,默认关闭;不实现改写执行器(用户已搁置自造词需求)。
- **频控边界**:每个决策/证据版本最多 1 条候选;每会话运行中检查 ≤1 次(另有总并发上限);新用户输入使旧候选作废;合成提醒不产生新预算;审阅进行中不重复派发。
- **状态语义**:`204 accepted` ≠ 进入模型请求 ≠ orchestrator 已处理,三者分开记录;停止、取消、归档、删除不按 idle 处理。

## 4. 分层分诊与预算

| 层 | 执行者 | 职责 | 启用条件 |
|---|---|---|---|
| L0 | 确定性规则(事件计数/状态机/显式条件) | 命中即出候选或直接放行 | 首版即有 |
| L1 | 便宜 LLM 分诊(小模型,经 §2.3 通道) | 仅正向定义的模糊触发条件:如"失败 ≥2 次且错误文本异构""证据互相矛盾""高影响工件变更且无对应审阅记录" | 基线证明存在 L0 漏报类 + 离线/影子运行验证有效后,分别开启 |
| L2 | orchestrator 终审 | 派发 adviser 并记录结果 | 始终(人的 orchestrator 语义不变) |

- L1 超时/预算尽 → "放行"仅表示**不追加可选咨询建议**,不得解释为通过强制 Oracle/审批/权限门。
- adviser 分工:oracle=技术风险/正确性;claude=目标与框架挑战;council=多视角独立判断;非串行阶梯。
- 四桶预算(L1 费/唤醒主模型费/adviser 费/返工费)分开计量;模型/传输失败不自动启第二套调用。

**预算档位(启用相应能力前必须填写并验证上限;只有分桶统计、没有启用上限,不构成预算封顶)**:

| 运行阶段 | 最低预算约束 |
|---|---|
| 阶段一:纯观察 | supervisor 新增 LLM 调用、注入、唤醒次数均为 **0**;既有 adviser/返工费用仅观测(不要求为 0);日志队列、磁盘占用、处理时间有界 |
| 阶段二:L0 注入 | L1 与主动唤醒仍为 0;明确每会话注入上限、单条注入长度上限;保留每决策/证据版本去重 |
| 阶段四:L1 | 启用前明确输入/输出 token 上限、调用次数或费用上限、超时、每会话及总并发上限;结果未知的调用计入占用/费用预留,不立即启第二套调用 |

预算职责边界:supervisor 只能限制自身分诊、注入与唤醒;adviser 与返工预算由 orchestrator 既有决策及审阅机制执行;可选建议预算耗尽不得覆盖强制 Oracle、审批或权限要求。

**L1 输出契约(启用 L1 前落实)**:L1 返回有限标签、理由及来源引用;确定性代码验证结构、绑定版本及允许的建议类型,再用固定模板形成 nudge;无效输出不注入,不原样提升为 system 指令。

## 5. 身份契约与兼容矩阵

三种投递形式(noReply 选项 / prompt_async 接口 / synthetic 消息类型)**落地身份不同**,主通道(transform 注入)根本不落消息,天然规避此问题——这是选它的决定性理由之一。

- v1 主通道注入的是"模型请求内容",非 transcript 消息:不新增持久化消息,**预期**避免消息事件驱动的轮次推进与唤醒重置(probe 实证:transcript 与 db 均无痕);共享上下文 hook 的相互作用及后续响应链仍须组合测试验证,非持久化是降低风险的机制,不是组合测试的替代品。
- 备选通道启用前,必须通过兼容矩阵:对每种投递形式 × {blackboard 轮次推进、OMO wake 进度重置、PHASE_REMINDER 追加、supervisor 自触发次数} 逐项验证;文本标记可用于兼容过滤,但不得作为来源真实性或授权依据。
- 事件过滤:judge 会话、child/councillor 会话排除出监控集合(防 claude 指出的"事件 hook 看到 judge 会话"与 wake/reap 等待)。

## 6. 验证状态(四档记录)

**档 A:源码支持**(d.ts/二进制取证):全部 hook 签名、路由表、PluginInput 字段、OMO shim 行为。

**档 B:已运行成功的窄路径**:
1. R3:prompt_async 204 端到端、SSE 事件流、session 创建/删除、judge 会话等价路径、外部 basic auth。
2. **本次 live probe(transform 注入通道,隔离环境:干净 env + HOME 隔离 + mock OpenAI-compatible provider 于 127.0.0.1:4399 + opencode 1.18.35 serve 于 4099)**:
   - ✅ hook 在 provider 请求前同步执行:时间线上 transform(probe.log:8,t=1792063682529)→ 821ms 后 mock 收到请求(capture.jsonl:1,t=1792063683350)→ 之后才有 assistant 消息事件(注:821ms 含 mock 服务器与请求转发开销,**不是**插件新增延迟的测量值;四审更正,原稿误写 18ms);
   - ✅ 注入的合成 user 消息(MARKER)出现在 provider 请求体内;
   - ✅ MARKER 不在 `GET /session/{id}/message` 返回中(transcript 无痕);
   - ✅ MARKER 不在隔离 `opencode.db`(含 wal,rg -a 零命中);
   - ✅ 注入不破坏回复循环:mock 回复 MOCK-REPLY-OK 正常成为 assistant text;
   - ✅ PluginInput keys 实证(无 generate/experimental_v2)。
   - 工件:`/tmp/opencode/probe2/{mock/{probe.log,capture.jsonl,server.mjs},home/.config/opencode/{opencode.json,plugin/probe.mjs}}`。

**档 C:验证边界**:尚未覆盖并发边界;当前仅验证单会话、单用户轮次、无工具循环的窄路径。

**档 D:尚未验证**:
1. v2 宿主 `ctx.session.hook("context")`(阻塞 v2 注入能力)与 `ctx.generate.text`(仅阻塞依赖它的 v2 L1)——无 v2 宿主环境;均不阻塞当前 v1 纯观察与 v1 L0 路线;v2 纯观察可否部署取决于其事件适配自身的验证,不能由 v1 结果代替。
2. 工具循环中多次模型请求的注入幂等(设计已约束,未跑)。
3. 备选通道三项:busy noReply 排队晋升、synthetic/可见 prompt 降级、与 OMO orchestratorWake 双唤醒互斥——**仅当启用对应通道时才阻塞**。
4. 真实 provider 网络栈(bili proxy 环境)下的 transform 行为(probe 为干净 env;预期无差异,部署时冒烟即可)。

## 7. 实施顺序(约束,非建议)

**阶段一:纯观察基线(只记录,零注入)**
- event hook 单源接入 + §2.1 过滤;记录:真实用户轮次、决策/证据版本、已有 adviser 调用(含 acp_run claude)、L0 规则命中与丢弃原因、(触发点, orchestrator 是否已派, 结果)三元组;未触发样本抽查以估计漏报。
- **L1 默认关闭;主动唤醒默认关闭。**

**阶段二:最小 L0 请求前注入**
- transform hook 内:候选校验 + 注入(结构化元数据);与 blackboard / PHASE_REMINDER / OMO wake 组合测试为**验收项**(非持久化降低风险,但不替代组合测试)。
- 幂等验收(注入启用前置):同轮多次 hook、provider 重试/fallback、候选过期、无新外部证据不重复提醒。
- 基线数据显示漏报类之前,不进入阶段三以下任何通道。真实 provider 网络栈(bili proxy)下的注入冒烟 = 启用注入前的硬检查,不是上线后观察项。

**阶段三:按需验证备选通道**(优先级:busy noReply 排队晋升 → synthetic/可见降级 → ctx.generate.text/judge fallback;不采用则不阻塞)

**阶段四:有限开启 L1**(正向触发条件 + §4 预算档位 + L1 输出契约 + 总并发上限;先离线样例/影子运行证明能发现 L0 漏掉且值得咨询的问题)

## 8. 评审记录与证据

- oracle 三审:`bb://fc7fa61a-1da7-41e5-98a9-406e9b4431f9/9b6b5712-c8fb-453e-a86e-a048bcf810cb/e000001`(R1)、`e000002`(R2)、`e000003`(R3.5,REJECT 本 v1)
- oracle 四审(v2,APPROVE WITH CHANGES,阶段一准入 PASS):`…/9b6b5712…/e000004`(绑定修订前 SHA `331121fd…`;本 v2.1 已按其必改项修订)
- claude:`bb://fc7fa61a-1da7-41e5-98a9-406e9b4431f9/9dfb7b01-ad20-42d8-98e9-0c6fa826cefa/e000001`(R2)、`e000002`(R3.5)
- 机制证据导出:`.opencode/bcp/exports/fc7fa61a…-9f3fb941…-e000002.json`(omo-slim 通道)、`.opencode/bcp/exports/fc7fa61a…-ae550bca…-e000001.json`(opencode LLM 能力面)
- probe 工件:见 §6 档 B。
