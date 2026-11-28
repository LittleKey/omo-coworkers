# omo-coworkers

`omo-coworkers` **8.0.0**（待用户实机测试版；已完成静态独立复审 PASS 与仓库全套单测 198/198，未执行安装/运行态验证）是面向 OpenChamber 的扩展包，包含响应式配置工作台面板（`角色` / `设置`）、宿主配置服务、扩展行为插件及随包技能。包清单声明 OpenChamber `>=2.8.0`、Node `>=20`；新增的 `opencode` 服务权限（`provides: ["opencode"]`）已在本地 `@openchamber/sdk@2.8.1` 与 `@openchamber/web@2.8.1` 清单解析器中校验，`2.8.0` 宿主对该权限的兼容尚未实测。

## 能力与当前实现边界

- **双页工作台与私有草稿**：主界面仅保留 `角色` 与 `设置` 两页（右上角标识 `全局 OMO` 与 `待重载` 徽标），适配桌面端与移动端（`<560px`）。有效编辑经 300ms 防抖自动保存至服务私有状态文件（`OPENCHAMBER_SERVICE_DATA_DIR/workbench-state.json`），采用单调修订号、幂等 `mutationId` 与 `STALE_REVISION` 冲突保护。**保存私有草稿不会改写原生配置或改变运行态**；未通过校验的输入保留在界面中，暂不落盘。
- **12 角色平级配置与内置推荐**：平级管理 12 个真实 OMO 角色（`orchestrator`、`explorer`、`oracle`、`designer`、`fixer`、`observer`、`council`、`councillor`、`document-writer`、`lark-operator`、`claude`、`antigravity`）。`orchestrator` 与 `councillor` 不可停用；`observer` 默认停用；`council` 席位与预设保持只读，通用 `councillor` 模型不会扇出覆盖各席位。内置推荐配比（`recommended-models.json` `8.0.0`）直接物化到私有草稿中，支持单角色恢复、全局停用推荐（保留当前已选值）、批量恢复及带基线比对的推荐更新；**不支持复杂 `preset.extends`、`inheritModelFrom` 或双源冲突配置**（遇到时阻断并返回 `COMPLEX_MODEL_SOURCE`）。
- **ACP 代理与有限环境开关**：`claude` 与 `antigravity` 明确区分外层 `包装层模型`（`wrapperModel`）与外部运行时决定的只读 `内部模型`；`requestedVariant` 仅作为工作台私有草稿意向保留，**在严格 OMO 校验下不会写入原生 `acpAgents`**。支持 6 项原生字段（`command`、`args`、`cwd`、`wrapperModel`、`timeoutMs`、`permissionMode`）；私有草稿允许暂存未完成编辑，但预览与发布前投影会严格校验合法的 `wrapperModel`（`provider/model` 格式）、非空 `command` 与非空白 `cwd`（否则以 `INVALID_CONFIG` 阻断）。仅 `claude` 保留 3 个指定 `behaviorEnv` 开关及独立的全局 `claudeGuard` 开关（`behavior.json`）。不提供任意环境变量或凭据编辑器。
- **扩展权威与个人内容保护**：发布时仅投影有限托管字段及 `manifest.json` 冻结的 7 份提示词文件与路由定义（随包提供 `maintaining-product-engineering-docs`、`domain-modeling`、`humanizer` 三项技能，字节与清单哈希冻结）。扩展不捆绑、不安装 `oh-my-opencode-slim` 或第三方依赖，由用户个人 `dotfiles` / `opencode.json` 预置。若检测到未识别的个人提示词文件、自定义正文或内联覆盖，一律阻断（`PERSONAL_CONTENT_BLOCKED`）而不猜测或覆盖；非托管配置项、额外技能与 `opencode.json` 原样保留。
- **显式冷发布、目标确认与恢复**：`允许写入全局配置` **默认关闭**（开启前仍可预览差异与导出备份），且执行写入前会在私有锁下复核最新开关状态（若期间关闭则撤销旧预览授权并返回 `READ_ONLY`）。仅允许写入服务默认配置根（`$XDG_CONFIG_HOME/opencode` 或 `~/.config/opencode` 下的 `oh-my-opencode-slim.json`/`.jsonc`），不接受浏览器路径或目录上下文推断。`发布` 先执行无副作用差异预览（24 小时有效），并在首次接管、目标路径/文件变更、外部修改覆盖、ACP 可执行/权限变更及启用 `claudeGuard` 时要求手动勾选风险确认；目标不变且无风险的常规发布只需一次点击确认。写入前先落盘多文件 WAL（台账上限 4096 次变更 / 128 条操作记录，不自动淘汰）；写锁支持确认原持有进程已退出（`ESRCH` 且锁文件未变）后的安全清理，存活或未知持有者仍快速阻断。仅在明确收到服务端 pre-WAL 拒收凭据（`operationStarted: false`）时清除待查句柄并要求重新预览；其余超时、404 或结果未知一律锁定并发写入并保留 `查询状态`，不可盲目重试。旧版 v3 写入接口已退役并返回 `410 API_RETIRED`。
- **授权模型目录与请求级缓存**：插件 `ctx.rpc`（`omo-coworkers.catalog.v1`）采用异步隔离注册（注册失败不阻塞插件主初始化），经 OpenChamber 只读 `opencode` 代理的 SSE 流（`/api/event`）按每次请求的 `directory` 参数独立订阅模型快照（最多 16 个目录上下文，不跨面板共享单例），不回退旧 CLI 或私有路径。因当前缺乏受信任的公开目标身份证明，磁盘快照（`0o600`，最多 16 份）**仅作只写持久化，不跨服务重启或新服务实例供选择器复用**；**不宣称支持重启 SWR 或源身份已验**。保留含多 `/` 的不透明模型 ID 与草稿中已选值；刷新仅重连 SSE（最长 30 秒首推周期，不强制上游拉取），断连、刷新重连、流异常或鉴权失败会清空可用目录选项直到收到新流快照；同一流连续 **90 秒**无新有效快照（SSE 心跳不续期）即标为 `目录已过期 · 等待重新确认`（`locationMatch: false`）。**权限提示**：宿主 `provides: ["opencode"]` 向扩展服务授予已列出的 `/api/session*`、`/api/project` 与 `/api/event` 只读代理权限（而非仅限模型）；本扩展仅订阅指定快照事件且不向面板暴露令牌，但该权限范围需在扩展设置中重新批准。
- **与设计文档（`docs/configuration-workbench-design.md`）的已知偏差与运行态边界**：`docs/configuration-workbench-design.md` 作为已批准历史设计原样保留，当前 `8.0.0` 实现边界如下：
  1. **生产环境不提供热刷新（`hotApply: false`）**：虽已在隔离 OMO `3.0.8` 导出函数夹具中验证 `liveConfigRefresh` 机制，但生产环境中缺乏受信任的运行时版本/根目录/无遮蔽/注册证明及公开运行时 ACK 桥接，因此工作台不启用 §9.1 的 `保存生效` 热按钮，所有变更均需冷发布并经宿主手动重载（顶栏标 `待重载`）。
  2. **`允许写入全局配置` 默认关闭**（有别于 §6.2 默认开启的描述），需显式开启后方可执行发布。
  3. **`发布后自动重载` 保持禁用**：OpenChamber SDK 2.8.1 未提供公开重载或重启接口。
  4. **`诊断日志` 仅为本页内存元数据**：默认关闭、30 分钟自动失效、刷新即清空，**尚未接入持久日志目录**（`diagnosticLogging: false`），不记录配置正文、环境变量或凭据。
  5. **安全与验证状态**：宿主服务 `runtime: "host"` 拥有当前用户完整 Node 权限，**不是操作系统沙箱**；当前已完成最终 Oracle 2/2 正确性与静态安全/权限/隐私评审 **PASS**、仓库全套离线单测 **198/198**（0 skips）及文档终修前 `8.0.0` 打包预检快照（98 项，无 ignored 产物）。上述离线与夹具测试**不作为**真实宿主运行态证明，真实宿主权限弹窗授权、实时浏览器/移动端界面及外部 OpenCode+OMO 实机运行态仍未验证（当前仍为待用户实机测试版，未执行安装/运行态验证）。

详细安装、操作、恢复与停止托管步骤见 [INSTALL.md](INSTALL.md)；源码结构、哈希与验证记录见 [SOURCES.md](SOURCES.md)。
