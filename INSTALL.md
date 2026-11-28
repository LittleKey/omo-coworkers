# 安装、配置工作台与恢复指南（8.0.0）

本文面向熟悉 OpenCode 与 OpenChamber 的维护者和用户，说明 `omo-coworkers` **8.0.0** 待用户实机测试版（已完成静态独立复审 PASS 与全套离线单测 198/198，未执行安装/运行态验证，真实宿主与实机运行态未验）的实际已实现能力与安全边界。`docs/configuration-workbench-design.md` 作为已批准的历史设计文档保留；本文第 3 节明确列出当前实现相对该设计的已知偏差。**私有草稿自动保存、显式冷发布写盘、宿主手动重载与运行态核验是四个互相独立的步骤**，任一前置步骤均不证明运行中的 OpenCode 已加载新配置。

---

## 1. 安装、授权与权限边界

1. **版本要求**：仓库 `package.json` 声明 `version: "8.0.0"`、Node `>=20` 与 OpenChamber `>=2.8.0`；扩展贡献列表包含 `panel`、`service`（`runtime: "host"`、`provides: ["opencode"]`）、`skills` 与 `opencodePlugin`。其中新增的 `opencode` 服务权限已针对 `@openchamber/sdk@2.8.1` 与 `@openchamber/web@2.8.1` 清单解析器校验，在 `2.8.0` 宿主上的行为未单独实测。
2. **授权与权限范围**：在 OpenChamber **设置 → 扩展** 安装或更新后，必须重新批准本地服务的 **`opencode`** 权限。
   - **宿主服务非沙箱**：`runtime: "host"` 以当前用户完整 Node 权限运行，仅监听 `127.0.0.1` 并要求 Bearer 鉴权。
   - **`opencode` 代理范围**：按 OpenChamber SDK 2.8.1 规范，`provides: ["opencode"]` 向扩展服务授予受控列表中的 `/api/session*`、`/api/project` 与 `/api/event` 只读代理访问（而非仅限模型目录的细粒度权限）。本扩展服务仅订阅 `/api/event?types=rpc.omo-coworkers.catalog.v1.snapshot`，插件发布器会过滤掉 provider 凭据、设置与无关字段，面板端不持有令牌，也不回退至 `opencode models` 等 CLI 或私有路径。
3. **目录上下文与原生写路径严格隔离**：
   - 面板通过宿主 `onReady.directory` / `onDirectory` 向 `POST /workbench/context` 与请求级 `GET /models?directory=...` 传递的目录**仅用于过滤模型目录 SSE 事件**，不构成写入目标授权，也不证明当前运行实例使用该目录。
   - 原生写入目标固定由服务端检查默认配置根（`$XDG_CONFIG_HOME/opencode` 或 `~/.config/opencode`）下的 `oh-my-opencode-slim.json` 或 `oh-my-opencode-slim.jsonc`（若两者都不存在则默认为 `.jsonc`；若两者同时存在则报 `CONFLICT` 阻断）。服务拒绝浏览器传入的任何路径。
4. **OMO 插件与依赖职责**：扩展**不打包、不安装** `oh-my-opencode-slim` 或第三方技能/工具依赖。OMO 插件本体、provider 凭据与运行依赖需由用户自行在 `dotfiles` 与 `opencode.json` 中预置；内置推荐配比中的模型 ID 尚未经外部实机运行时逐一验证可用性。

---

## 2. 角色编辑、内置推荐与模型目录

### 2.1 角色页与模型选择

- **12 个平级角色**：`orchestrator`、`explorer`、`oracle`、`designer`、`fixer`、`observer`、`council`、`councillor`、`document-writer`、`lark-operator`、`claude`、`antigravity`。
- **角色保护与默认值**：`orchestrator` 与 `councillor` 标记 `🔒 不可停用`，服务端拒绝将其设为停用；`observer` 默认处于停用状态（若手动启用，界面提示所选模型应支持视觉能力）。`disabled_agents` 更新时保留其他未托管成员与 `observer` 默认语义。`council` 的席位与预设保持原样只读，通用 `councillor` 模型不会覆盖各席位模型。
- **内置推荐（`8.0.0`）**：
  - 推荐配比直接物化进私有草稿（无独立“方案”页）。可在单角色详情点击 `恢复推荐`、在模型选择器顶部查看 `★ 推荐` 项，或在 `设置 → 内置推荐` 中关闭 `使用内置推荐`（关闭后立即保留当前所有角色值，不会清空配置）、展开只读 `查看推荐配比` 或点击 `全部恢复推荐`（仅更新草稿）。
  - 若扩展升级后推荐版本变化，设置页会显示升级提示：当历史推荐基线（`recommendationBase`）可确认时，点击 `更新内置推荐` 仅更新仍与旧推荐一致的字段，保留用户自定义模型、等级、启停与连接设置；若旧基线不可确认，则只能逐个角色手动对比，**不会静默重置**。
- **原生预设解析限制**：对已选中的单层或嵌套 `preset`（`presets[preset].<role>` 或 `presets[preset].agents.<role>`），按直写覆盖选中预设的优先级读写，并保留无关预设与 `council` 席位；若存在 `extends`、`inheritModelFrom` 或同时存在嵌套与扁平定义，则报 `COMPLEX_MODEL_SOURCE` 阻断，不静默压平。

### 2.2 模型目录与请求级缓存边界

- **请求级订阅、推送与重连**：目录查询（`GET /models?directory=...`）按请求参数中的显式绝对路径隔离运行（最多 16 个独立目录上下文并按 LRU 淘汰，不跨面板共享单例；缺失或非法目录返回 `unbound` 且列表为空；`POST /workbench/context` 不改变全局目录状态，面板核对 `catalogContext.requestedDirectory` 与请求代次避免串页）。插件以异步隔离方式注册 `omo-coworkers.catalog.v1`（注册失败不阻塞插件其余能力），在启动完成后及每 30 秒通过 `ctx.rpc` 全量推送一次模型快照（上限 4096 个模型 / 1 MiB）。首次连接最多可能需要约 30 秒才能收到快照；点击模型选择器 `↻`（`GET /models?refresh=true`）**仅重连当前目录的 SSE 订阅流**，不会强制上游重新拉取。断连、刷新重连、流异常或鉴权失败会**清空可用候选列表**直到收到新快照，同时**保留草稿中已选模型引用**。
- **不透明 ID、90 秒过期与只写磁盘约束**：完整保留含多 `/` 的模型 ID（如 `magpie/agy-cli/gemini-4-hydrogen`）；`catalog-publisher` 规范以 `id` 字段为主、缺失时回退 `modelID` 别名，而服务与面板仅使用规范 `id`。同一流以服务端接收时间 `receivedAt` 起算 **90 秒**无新有效快照即转为 `stale`（界面显示 `目录已过期 · 等待重新确认`，`locationMatch: false`），**SSE 心跳本身不续期**；同一流中出现多个发布者时标为 `ambiguous`。由于当前不存在受信任的公开目标/发布者身份证明，写入 `OPENCHAMBER_SERVICE_DATA_DIR/catalog-<sha256>.json`（`0o600` 权限、最多 16 份、严格校验非符号链接与属主权限）的快照**仅作只写持久化，不会在服务重启或新服务实例时读回供选择器复用**；**不宣称支持跨重启 SWR 或源身份已验**。目录状态仅表示快照来源，**不证明运行中实例已采用该配置**。

### 2.3 ACP 代理与 `claude` 行为选项

- `claude` 与 `antigravity` 在详情中区分 **`包装层模型`（`wrapperModel`）** 与外部 CLI 决定的只读 **`内部模型`**。`requestedVariant` 仅作为工作台私有草稿意向保存（以备后续或参考），**因原生 OMO `acpAgents` 架构不允许该字段，发布时绝不写入原生配置文件**。
- `连接参数` 折叠区支持编辑 `command`、`args`（JSON 数组）、`cwd`、`permissionMode`（默认/`ask`/`allow`/`reject`）与 `timeoutMs`（`0` 表示不限，范围 `0..2147483647`）。私有草稿允许暂存未填完的输入，但在执行 `预览` 与写 WAL 前的最终投影阶段，服务端严格校验合法的 `wrapperModel`（`provider/model` 格式）、非空 `command` 及非空白 `cwd`（否则返回 `INVALID_CONFIG`）。
- 仅 `claude` 额外提供 `行为选项` 折叠区：包含 3 个指定环境变量开关（`CLAUDE_CODE_DISABLE_CLAUDE_MDS`、`CLAUDE_CODE_DISABLE_BUNDLED_SKILLS`、`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`，仅允许显式设 `1`/`0`）及独立的全局 `claudeGuard` 开关（写入 `.omo-coworkers/behavior.json`，由单独的 `behavior.lock` 事务维护，**不是** Claude 环境变量）。当 `behavior.json` 不存在时插件才读取旧版 `OMO_COWORKERS_ENABLE_CLAUDE_GUARD=1` / `OMO_COWORKERS_ENABLE_WRITER_ROLE=1`；服务写盘时固定写入 `writerTransformEnabled: false`。不提供通用环境变量编辑器，已有未知或非规范键保持不动。

---

## 3. 自动保存草稿、冷发布预览与已知偏差

1. **私有草稿自动保存**：所有有效改动经 300ms 防抖整份写入 `OPENCHAMBER_SERVICE_DATA_DIR/workbench-state.json`（带期望版本号 `expectedRevision` 与幂等 `mutationId`）。保存失败时底栏提供 `重试保存`；若多页面并发编辑导致 `STALE_REVISION` 冲突，本页编辑仍保留在内存中，顶部横幅提供 `备份本页编辑` 或显式 `放弃本页编辑并读取最新`。
2. **开启写入与无副作用预览**：进入 `设置 → 发布与生效` 开启 `允许写入全局配置`（**默认关闭**；关闭状态下仍可点击 `发布` 进行只读差异预览，预览弹窗会显示 `READ_ONLY` 阻断提示）。预览请求（`POST /workbench/preview`，24 小时有效，最新预览覆盖旧预览）不修改草稿或原生文件，并在窗口内列出逐字段差异与服务端确认的真实路径。发布写盘前服务端会在私有锁下复核最新的 `允许写入全局配置` 状态——若在预览后关闭该开关，旧预览授权立即失效并被 `READ_ONLY` 阻断，而已保留的草稿与后续自动保存不受影响。
3. **分层风险确认**：
   - 首次接管目标文件（`firstTakeover`）及目标目录/文件身份（`targetId` / `dev+ino`）未获确认时，须手动勾选 5 项标准目标确认与对应风险项。
   - 若目标路径或文件被替换（含 `.json` 与 `.jsonc` 切换），原有授权自动失效并要求 `targetAuthorization` 重新确认。
   - 若原生文件在已发布后被外部修改，预览标记 `externalOverwrite` 风险，并提供 `导入外部修改` 按钮以便先合入最新原生值再决定是否覆盖。
   - 变更 ACP `command`/`args`/`cwd`/`permissionMode` 触发 `acpExecution` 确认；启用 `claudeGuard` 触发 `guardEnable` 确认。
   - 当同一目标文件身份已确认且本次变更不含上述高风险项时，服务端返回 `requiredConfirmations: []`，弹窗不显示额外勾选框，点击 `确认发布` 即可写盘（仍需人工触发，绝不自动发布）。
4. **个人提示词与内联覆盖保护**：发布时会按 `manifest.json` 先校验并写入 7 份冻结提示词资产（`oh-my-opencode-slim/*.md`）与 `fragments/leaves.json` 中的固定描述/路由字段；已存在且哈希与当前冻结版本完全一致的资产保留不重写。若存在未知历史提示词正文、同名 `_append`/非 `_append` 冲突文件、当前选中 preset 下的冲突提示词，或内联 `prompt`/`appendPrompt` 与冻结定义不一致，操作将**快速失败并拒绝写入**（`409 PERSONAL_CONTENT_BLOCKED`），需要用户先自行备份或清理个人正文。
5. **相对 `docs/configuration-workbench-design.md`（§6.2 / §9.1）的当前实现偏差**：
   - **冷发布强制生效路径（无热刷新按钮）**：代码内包含 `workbench-hot.mjs` 条件分类器，但因生产宿主缺乏受信任的运行时版本/根目录/注册/无项目遮蔽证据与运行时 ACK 接口，服务端固定返回 `capabilities.hotApply: false`。界面**不提供** §9.1 所述的 `保存生效` 热更新按钮，所有发布写入后顶栏均标示 `待重载`，需自行重载外部 OpenCode 后在新会话验证。
   - **默认保护策略更保守**：`允许写入全局配置` 默认为 `false`（关闭），而非 §6.2 中的默认开启。
   - **`发布后自动重载` 不可用**：因 OpenChamber SDK 2.8.1 无公开重载或重启 API，该开关保持置灰禁用。
   - **`诊断日志` 仅限内存元数据**：当前仅实现浏览器页面内存中的环形元数据缓冲（默认关闭，开启 30 分钟后自动关闭，上限 100 条，刷新页面即清除，支持 `导出日志` / `清空日志`），**未接入 §6.2 所述的持久 `logs/` 目录**（`capabilities.diagnosticLogging: false`）。严禁记录提示词、配置正文、环境变量或凭据。

---

## 4. 恢复、容量限制、备份与停止托管

1. **发布结果未知与条件恢复边界**：
   - 发送 `POST /workbench/operations` 前，面板将 `operationId` 存入 `localStorage`（`omo-workbench-pending-operation-v4`），服务则先持久化请求哈希与操作日志（WAL），再按序原子写入提示词资产、原生配置与 `behavior.json`。
   - **明确未提交 vs 结果未知**：仅当服务端针对已知有限的 pre-WAL 前置阻断且核实尚未生成操作文件、显式返回 `error.disposition.operationStarted === false` 时，面板才清除该待查句柄、作废旧预览并提示 `未提交发布`（保留草稿供重新预览，不自动重发）。若因超时、404、无上述凭据的冲突或页面中断导致状态为 `pending` / `unknown`，面板一律保留持久化的 `operationId`、顶部显示 `发布结果未知` 与 `查询状态` 按钮（`GET /workbench/operations/:id`），并**锁定一切新发布**（`RECOVERY_REQUIRED`）。服务读回若确认全部目标哈希已落盘则会收敛为 `applied`；**切勿盲目重发不同 `operationId` 的发布请求**。
   - **写锁恢复边界**：私有锁、原生锁与 `behavior.lock` 仅在确认原持有进程已退出（`ESRCH`）且锁文件快照/元数据未变化时执行死锁清理；若持有进程仍存活、PID 复用或状态未知，则快速失败阻断（`LOCKED` / `BUSY`）。
   - **关于操作级恢复按钮**：服务端已实现有限条件恢复接口（`POST /workbench/operations/:id/restore`，仅在目标配置文件、资产与 `behavior.json` 仍严格匹配操作前后哈希、且无第三方改动时回滚本次托管叶子并删除新建提示词文件，拒绝混合整包恢复）；**禁写状态（`允许写入全局配置` 关闭）同样禁止执行条件恢复**（在私有与原生写锁内复核开关并返回 `READ_ONLY`，需重新开启后才可恢复，而只读 `查询状态` 与已恢复状态的只读重放仍可用）。**当前 8.0.0 面板界面未暴露操作恢复按钮**，仅提供 `查询状态`（底栏的 `还原草稿` 按钮仅用于放弃内存中的未发布修改、恢复到 `appliedDraft` 基线）。
2. **旧版接口与容量上限**：
   - 原 v3 编辑/揭露/用户配方接口（`/snapshot`、`/status`、`/intent-preview`、`/config`、`/undo-preview`、`/migration-preview`、`/recover`、`/settings` 等 14 个路由）均返回 `410 API_RETIRED`。
   - 若配置目录下存在未解决的旧 `.omo-coworkers/journal.json` 或 `manager-journal.json`，新服务返回 `LEGACY_RECOVERY_REQUIRED` 并拒绝接管，需先按旧版流程完成恢复。
   - 显式容量边界：私有变更台账上限 `4096` 条 `mutationId`、操作日志上限 `128` 条（超限返回 `CAPACITY`，不静默淘汰历史记录）；单次 HTTP 请求体上限 `63,000` 字节、草稿上限 `50,000` 字节、JSON 备份导入上限 `60,000` 字节、原生单文件上限 `4 MiB`。
3. **备份、原生导入与停止托管**：
   - `设置 → 数据与环境` 提供 `导出配置`（`omo-workbench` v1 JSON，附带仅供备份参考的 `invalidInputs`）、`导入配置备份`（最多 60 KB 白名单校验，导入时忽略 `invalidInputs`，仅保存至私有草稿而不发布，并保留导入期间的并发编辑）以及 `从现有配置导入`（仅导入受支持的有限托管字段并重置 `允许写入全局配置` 为 `false`）。
   - **停止托管与卸载**：卸载扩展时，OpenChamber 会删除扩展私有数据目录（`OPENCHAMBER_SERVICE_DATA_DIR`，内含私有草稿、WAL 与只写磁盘快照文件），**但不会自动回滚已写入的原生 OMO 配置文件**。如需停止托管，请先在工作台关闭 `允许写入全局配置` 并通过 `导出配置` 保存个人备份，再卸载扩展，随后按需自行维护原生文件；扩展写入原生配置的内容不包含指向私有数据目录的路径，不会在卸载后留下悬空引用。

更多实现文件、哈希与验证详情见 [SOURCES.md](SOURCES.md)。
