# 安装与交接指南（`omo-coworkers` 6.0.0 — OpenChamber 2.8.0+ 扩展与 OMO 原生配置交付）

自 `6.0.0` 起，`omo-coworkers` 是面向 **OpenChamber 2.8.0+** 的根级扩展包（`panel.id: "omo-coworkers"`）。除提供三项通用协作技能（`skills/`）、四份冻结的 `document-writer` 上游语义载荷（`openchamber/plugin/roles/`）以及默认关闭的两项 OpenCode V2 插件钩子（`openchamber/plugin/index.mjs`）外，**`6.0.0` 新增了本地宿主服务（`openchamber/service/main.mjs`）与中文操作面板（`openchamber/panel/index.html`），正式接管原 `dotfiles/opencode` 的 OMO（`oh-my-opencode-slim`）原生提示词与受管配置叶节点交付**。

> **`6.0.0` 核心变更与跨版本边界提示**：
> - **原生配置生成（非运行时转换）**：`6.0.0` 采用向用户配置根直接生成/局部编辑原生 OMO 文件的方式（7 份提示词 + `oh-my-opencode-slim.json(c)` 的 10 个文本叶节点），**不**使用运行时 prompt 注入。旧版 `OMO_COWORKERS_ENABLE_WRITER_ROLE=1` 运行时转换钩子默认关闭，使用原生配置交付时**必须保持关闭**。
> - **旧 `dotfiles/opencode` OMO 写入链已退役**：`dotfiles/opencode/runtime/profile.json` 已将 `oh-my-opencode-slim.json(c)` 与 `oh-my-opencode-slim/**` 标记为 `retired` 并移交本扩展；旧 `oprofile plan-activation`、`activate`（含 `--replace`）、`adopt`、`rollback` 及 `update-writer-role.mjs` 在触及已移交路径时整条工作流写入前直接拒绝，仅保留离线历史暂存（staging）与配置参考。
> - **保留用户自有配置与实时策略**：各角色的 `model` / `inheritModelFrom`、`permissions`、`skills`、`mcps`、ACP 传输命令（`acpAgents.{antigravity,claude}.command` 等）及实时 `permissionMode`（如本机 `acpAgents.antigravity.permissionMode: "ask"`）均归用户所有；旧 `dotfiles` 中的 `"reject"` **不会**被设为新默认值。
> - **安装扩展 ≠ 授权本地服务 ≠ 写入原生配置 ≠ 重启生效 ≠ 运行时验证通过**：安装、启动或更新扩展不会自动修改任何磁盘配置文件；所有写入均须在面板完成 7 项声明与精确版本核对（仅限已验证矩阵 `OMO 3.0.8` / `OpenCode 2.4.2` / `OpenChamber 2.8.0`）并审阅哈希预览后手动触发。
> - **`5.0.0` / `4.0.0` 历史移除项保持不变**：`supervisor` 插件与 CLI（`5.0.0` 移除）以及 `3.x` CLI 安装器 `coworkers-install` / `dw-install`（`4.0.0` 移除）均不恢复；任何历史已落地文件或外部记忆目录不会被自动删除或改写。

---

## 1. 前置条件、扩展安装与宿主本地服务授权

仓库根目录（`package.json` 版本 `6.0.0`）是零外部 npm 运行时依赖、无 `install`/`build` 钩子的预构建 OpenChamber 扩展（`engines.openchamber: ">=2.8.0"`, `engines.node: ">=20"`, `apiVersion: 1`）。

1. **安装扩展（GitHub 根仓库 URL，可选分支或标签 `#ref`）**：
   在 OpenChamber（`>=2.8.0`）扩展管理中，使用仓库根 URL 安装：
   ```text
   https://github.com/LittleKey/omo-coworkers.git
   ```
   或固定到具体分支/发布标签（例如 `#v6.0.0`）：
   ```text
   https://github.com/LittleKey/omo-coworkers.git#v6.0.0
   ```
   *注意*：OpenChamber Git URL 安装仅支持仓库根路径与可选 `#<branch-or-tag>`，不支持子目录语法。本地工作区修改或未推送的提交不会出现在远端 GitHub URL 中。

2. **扩展注册的完整能力（`package.json` → `openchamber.contributes`）**：
   - `contributes.panel`: `{ "id": "omo-coworkers", "name": "OMO Coworkers", "icon": "ri-team-line", "entry": "openchamber/panel/index.html" }` — 提供 OMO 原生配置核对、预览、应用、条件回滚与中断恢复面板（前端脚本为 `openchamber/panel/app.js` 与 `model.js`，符合 OpenChamber 2.8.0 对已构建面板脚本 `.js` 扩展名的要求）。
   - `contributes.service`: `{ "entry": "openchamber/service/main.mjs", "runtime": "host" }` — 注册宿主本地回环 HTTP 服务（无 `exec`、`sockets`、`provides`、`keepRunning` 或 `schedule` 额外声明，空闲 10 分钟自动停止）。
   - `contributes.skills`: `"skills"` — 贡献 `maintaining-product-engineering-docs`、`domain-modeling` 与 `humanizer` 三项通用技能。
   - `contributes.opencodePlugin`: `"openchamber/plugin"` — 注册 `openchamber/plugin/index.mjs`（插件 ID `"omo-coworkers"`；默认两项运行时钩子均关闭，仅在宿主进程环境显式设置 `OMO_COWORKERS_ENABLE_CLAUDE_GUARD=1` 或 `OMO_COWORKERS_ENABLE_WRITER_ROLE=1` 时分别启用）。

3. **显式批准宿主本地服务（必做，且需知悉非沙箱权限边界）**：
   - **`runtime: "host"` 权限实质**：该服务由宿主使用 `process.execPath` 直接拉起，以当前操作系统用户的**完整宿主 Node 权限**运行，**不是操作系统文件沙箱**。
   - **单独授权**：安装扩展后，必须在确认信任本扩展的前提下，前往 OpenChamber **「设置 → 扩展」（`Settings → Extensions`）** 显式批准本扩展的本地服务权限（`service` capability）。未批准时，宿主会以 `NO_SERVICE` 拒绝面板发起的一切服务请求。
   - **授权不触发写入**：批准并启动本地服务仅开放 `GET /health` 与 `GET /status` 等受宿主随机 `OPENCHAMBER_SERVICE_TOKEN`（Bearer Token）保护的回环接口，服务启动时绝不写入任何配置文件。

---

## 2. 原生 OMO 配置接管、预览与应用流程（主工作流）

### 2.1 受管范围与用户自有配置前置条件

扩展仅管理默认候选配置根（`$XDG_CONFIG_HOME/opencode` 或 `~/.config/opencode`）下的以下固定白名单路径：

1. **7 份提示词文件（完全受管，写入时权限默认保持原文件 mode 或新建 `0600`）**：
   - `oh-my-opencode-slim/orchestrator_append.md`
   - `oh-my-opencode-slim/oracle_append.md`
   - `oh-my-opencode-slim/explorer_append.md`
   - `oh-my-opencode-slim/designer_append.md`
   - `oh-my-opencode-slim/fixer_append.md`
   - `oh-my-opencode-slim/document-writer.md`（直接复用扩展内唯一冻结源 `openchamber/plugin/roles/document-writer.md`）
   - `oh-my-opencode-slim/lark-operator.md`
2. **`oh-my-opencode-slim.json` 或 `oh-my-opencode-slim.jsonc` 中的 10 个精选文本叶节点（局部 AST 更新）**：
   - `agents.document-writer.description`
   - `agents.document-writer.orchestratorPrompt`
   - `agents.lark-operator.description`
   - `agents.lark-operator.orchestratorPrompt`
   - `acpAgents.antigravity.prompt`
   - `acpAgents.antigravity.description`
   - `acpAgents.antigravity.orchestratorPrompt`
   - `acpAgents.claude.prompt`
   - `acpAgents.claude.description`
   - `acpAgents.claude.orchestratorPrompt`

   *配置文件选择规则*：若候选根下已存在 `oh-my-opencode-slim.json` 或 `oh-my-opencode-slim.jsonc` 之一，则就地对该文件做无格式化（no formatting pass）的最小 JSONC AST 编辑，保留所有其他字段与注释；若两者均不存在，则默认新建 `oh-my-opencode-slim.jsonc`；若 `.json` 与 `.jsonc` 同时存在，则报 `SHADOWED` 拒绝写入。

3. **必须已存在的用户自有配置前置项（扩展绝不代填或覆盖）**：
   在生成预览前，候选根的 `oh-my-opencode-slim.json(c)` 中必须已由用户配置好：
   - **模型绑定（否则报 `MISSING_MODEL`）**：`document-writer` 与 `lark-operator` 必须在 `agents.<name>` 或当前激活的 `presets.<preset>.agents.<name>`（或 `presets.<preset>.<name>`）中具备 `model` 或 `inheritModelFrom`。
   - **ACP 传输命令（否则报 `MISSING_TRANSPORT`）**：`acpAgents.antigravity.command` 与 `acpAgents.claude.command` 必须为非空字符串。
   - **其余个人字段原样保留**：各角色的 `permissions`、`skills`、`mcps`、`acpAgents.*.args`/`cwd`/`env` 以及 `acpAgents.antigravity.permissionMode`（例如用户在线上使用的 `"ask"`）全部保持不变。

### 2.2 从旧 `dotfiles/opencode` 交接并应用配置的完整步骤

1. **停止旧写入流程并暂停并发编辑**：
   - 确认不再运行旧 `dotfiles/opencode` 的 `oprofile activate` / `adopt` / `rollback` 或 `update-writer-role.mjs`（新版 `dotfiles/opencode` 已在代码层硬拒绝触及 `oh-my-opencode-slim*` 的激活、回滚与更新）。
   - 暂停相关 OpenCode 会话以及对 `oh-my-opencode-slim*` 的手动编辑，避免同一 UID 下的并发写入竞争。
2. **核查宿主与托管 OpenCode 进程的实际环境（服务无法代查）**：
   由于 OpenChamber 仅向扩展服务进程传递 `HOME`、`XDG_CONFIG_HOME`、`PATH` 等基础系统环境变量白名单，扩展服务**无法读取**宿主进程或托管 OpenCode 子进程的真实环境变量。操作者需自行核查：
   - 登录 shell 环境（如 `~/.zshrc`）、`<configRoot>/service.json` 中的 `env` 字段、以及 OpenChamber 设置存储中的用户变量（User Variables），确认**没有**设置指向其他目录的 `OPENCODE_CONFIG_DIR` 或覆盖预设的 `OH_MY_OPENCODE_SLIM_PRESET`；
   - 确认使用的是本机默认 `HOME`/`XDG_CONFIG_HOME` 配置根与 OpenChamber 托管的本地 OpenCode 服务，而非自定义配置根或外部 OpenCode 服务器；
   - 确认托管 OpenCode 进程未启用 `OMO_COWORKERS_ENABLE_WRITER_ROLE=1`；
   - 注意项目级配置（工作目录向上查找的 `.opencode/oh-my-opencode-slim.{jsonc,json}` 与 `.opencode/oh-my-opencode-slim/`）在 OMO 运行时优先级高于用户配置根。
3. **检查即将接管的现有受管值不含秘密**：
   在本机检查候选根下现有的 7 份提示词文件与 10 个受管 JSON/JSONC 文本叶节点，确认其中未写入 API 密钥、访问令牌或其他敏感秘密（应用时会将这些受管项的变更前原文存入 `<configRoot>/.omo-coworkers/journal.json` 与 `state.json` 以便回滚）。
4. **在面板填写 7 项声明与精确版本矩阵**：
   打开 OpenChamber 的 **OMO Coworkers** 面板，点击「刷新状态」确认候选配置根路径后，逐项勾选全部 7 项必选声明（面板从不预勾选，每次刷新或写入后均会清空重置）：
   - `candidateRootConfirmed`：已核对候选目录，确认它是当前 OMO 的用户配置根。
   - `defaultManagedLocalHost`：使用本机默认 HOME/XDG 配置根和 OpenChamber 托管服务，不使用自定义根或外部服务器。
   - `hostEnvironmentChecked`：已核对宿主及托管 OpenCode 的实际环境（含 shell、`service.json` 和用户变量），没有指向其他根的覆盖。
   - `writerRuntimeDisabled`：已确认托管进程未启用 `OMO_COWORKERS_ENABLE_WRITER_ROLE=1`。
   - `oldWriterStopped`：旧 dotfiles/安装器等写入流程已停止，不会并发覆盖这些文件。
   - `workPaused`：相关会话及配置编辑已暂停。
   - `managedBeforeValuesContainNoSecrets`：已在本机检查将接管的现有提示词及托管字段，确认不含密钥、令牌或其他秘密；允许保存这些值以便回滚。

   随后在版本输入框中手动填写当前实际运行的精确版本（**仅支持已验证兼容矩阵**，非自动探测值）：
   - `omo`: `3.0.8`
   - `opencode`: `2.4.2`
   - `openchamber`: `2.8.0`
5. **生成只读预览并审阅哈希摘要（`POST /preview`）**：
   - 点击「**预览应用**」。预览请求在文件系统上**完全只读**，不会创建锁、日志或修改任何文件。
   - 审阅面板展示的变更摘要：每项变更列出动作（新增 `create` / 更新 `update` / 删除 `delete`）、受管路径（叶路径或提示词文件相对路径）以及变更前后的 SHA-256 哈希（`beforeHash` / `afterHash`）。
   - **隐私与安全设计**：预览摘要**仅展示 SHA-256 哈希，不是文本 diff**，服务绝不向面板返回你原有的个人配置或提示词正文；随包提示词原文可在仓库 `openchamber/native-config/prompts/` 与 `openchamber/plugin/roles/document-writer.md` 中直接审阅。
   - 预览 ID 单次有效、5 分钟后自动过期（服务端最多缓存 16 个未过期预览）；任何磁盘文件变化、服务重启或表单改动都会使预览立即失效。
6. **确认应用（`POST /apply`）**：
   - 勾选「我已审阅此预览，确认执行本次写入」，点击「**确认应用**」。
   - 服务仅根据 `{previewId}` 消费该预览，获取 `<configRoot>/.omo-coworkers/lock`，二次核验全部快照（文件 hash、inode、dev、mode、size、mtimeMs 与根目录身份）无并发漂移后，先原子写入 `.omo-coworkers/journal.json`（`phase: "prepared"`），再逐个文件通过同目录 `.omo-<24hex>` 临时文件 + `fsync` + `rename` + 父目录 `fsync` 写入，复核写入结果后提交 `.omo-coworkers/state.json`（`phase: "committed"`）并删除 `journal.json`。
   - 写入完成后，面板状态更新为 **「已写入，待重启」（`applied-pending-restart`）**，所有确认勾选自动清空，旧快照哈希标记为「待刷新」。
7. **手动重启托管 OpenCode 并刷新核验**：
   - **写入不等于生效**：扩展服务与面板无权自动重启 OpenCode。请通过 OpenChamber 宿主 UI 手动重启或重载 OpenCode。
   - 重启后在面板点击「刷新状态」核对 `appliedContentVersion`、`appliedContentHash` 与 `diskDrift`（应为「未发现漂移」），并按 §6 在真实会话中核验运行时代理定义。

### 2.3 本地受管覆盖配置（`.omo-coworkers/overrides.jsonc`，可选）

若需在不脱离扩展管理的前提下定制个别受管叶节点或提示词，或将个别受管项排除出自动更新，可在本机直接编辑 `<configRoot>/.omo-coworkers/overrides.jsonc`（服务 API 不接受远程上传或修改此文件）：

```jsonc
{
  // 可选：替换指定受管叶节点的非空字符串值（键必须在 10 个受管叶白名单内）
  "leaves": {
    "agents.document-writer.description": "自定义描述文本"
  },
  // 可选：替换指定受管提示词的非空全文字符串（键必须在 7 个受管提示词路径白名单内）
  "prompts": {
    "oh-my-opencode-slim/fixer_append.md": "# Custom fixer append\n"
  },
  // 可选：将指定受管叶或提示词排除出扩展管理（不生成变更，不覆盖现有值）
  "unmanaged": [
    "oh-my-opencode-slim/lark-operator.md"
  ]
}
```

*校验约束*：`overrides.jsonc` 仅允许 `leaves`、`prompts`、`unmanaged` 三个顶层键，所有键名必须属于 `manifest.json` 与 `fragments/leaves.json` 的受管白名单，且替换值必须为非空字符串；任何未知键、重复键或非白名单路径均会触发 `INVALID_OVERRIDES` / `AMBIGUOUS_KEYS` 拒绝。

---

## 3. 条件回滚、中断恢复与故障排查

### 3.1 条件回滚（`POST /rollback-preview` → `POST /rollback`）

当状态为 `applied-pending-restart` 且存在已提交的 `.omo-coworkers/state.json` 时，可执行条件回滚：

1. 在面板完成全部 7 项声明与 3 项精确版本填写后，点击「**预览回滚**」（`POST /rollback-preview`）。
2. **回滚范围与基线保留**：
   - 仅回滚 `.omo-coworkers/state.json` 记录的受管叶节点与受管提示词文件：首次应用前已存在的项还原为首次接管前的 `before` 值（`action: "update"`），首次应用时新建的项则予以删除（`action: "delete"`）。
   - 若在当前兼容状态记录下重复执行应用（`apply` 覆盖已应用的 `state.json`），`state.json` 会保留首次接管时的原始 `before` / `beforeExists` 基线，以便回滚能回到扩展接管前的初始受管值（注：通过 OpenChamber 更新已安装扩展源码本身并不自动建立或验证跨 semver 的 `state.json` 状态迁移兼容性，详见 §5）。
   - **不回滚非受管配置**：你在 `oh-my-opencode-slim.json(c)` 中对 `model`、`permissions`、`skills` 等非受管字段的修改完全保留，绝不会用旧整份 JSON 文件覆盖。
3. **条件漂移保护（`DRIFT`）**：
   - 回滚前会逐项校验当前磁盘上的受管值是否与 `state.json` 记录的 `after` 值完全一致。若任何受管提示词或叶节点在应用后被外部手动修改，`POST /rollback-preview` 与 `POST /rollback` 均会以 `DRIFT` 拒绝，绝不强制覆盖。
4. 审阅回滚哈希摘要后，勾选确认并点击「**确认回滚**」（`POST /rollback`）。完成后状态变为 **「已回滚，待重启」（`rolled-back-pending-restart`）**，请再次通过宿主 UI 手动重启 OpenCode。

### 3.2 中断写入恢复（`recovery-required` 与显式 `POST /recover`）

单次应用或回滚需要依次更新配置文件与多份提示词文件，**跨文件更新不是原子事务**。若写入中途遭遇进程崩溃、断电或 I/O 故障，磁盘上会保留 `.omo-coworkers/journal.json`。

1. **严格只读隔离（绝不隐式恢复）**：
   - 当检测到 `journal.json` 存在时，`GET /status` 返回 `state: "recovery-required"`，面板中的「预览应用」与「预览回滚」按钮均被禁用，且 `POST /preview` / `POST /rollback-preview` 会直接返回 `409 RECOVERY_REQUIRED`。
   - 服务启动、`GET /status`、`POST /preview` 或 `POST /rollback-preview` **绝不会**在后台自动恢复或改写磁盘。
2. **显式恢复操作步骤**：
   - 在面板完成全部 7 项确认声明与 3 项精确版本填写；
   - 在面板显示的「**恢复中断的写入**」区域，额外勾选「**我确认恢复将写入磁盘，并请求还原中断事务。**」；
   - 点击「**确认恢复中断写入**」（调用 `POST /recover`）。
3. **`POST /recover` 的执行逻辑与安全边界**：
   - **死锁回收**：仅在 `POST /recover` 执行期间，若 `.omo-coworkers/lock` 存在且其中记录的 `{ "pid": <number> }` 经 `process.kill(pid, 0)` 检测确认进程已不存在（`ESRCH`），才安全移除死锁；若锁持有进程仍存活或锁文件格式异常，仍返回 `LOCKED`。
   - **条件还原或完成确认**：
     - 若 `state.json` 的 `id` 已与 `journal.json` 一致且 `phase === "committed"`，服务会核验所有受管项当前值等于 `after`，确认无误后移除 `journal.json` 与残留 `.omo-<24hex>` 临时文件；
     - 若事务尚未提交到 `state.json`，服务会逐项检查每个受管条目：已处于 `before` 状态的跳过，已写入 `after` 状态的按逆序还原回 `before`，核验全部回到 `before` 后移除 `journal.json` 与 `.omo-<24hex>` 临时文件；
     - **冲突停机**：若任何受管项的当前磁盘值既不等于 `before` 也不等于 `after`（或日志记录格式不合法），恢复立即以 `DRIFT` 或 `RECOVERY_REQUIRED` 终止，绝不盲目覆盖。
   - **恢复后状态**：`POST /recover` 返回 `{ ok: true, state: "<恢复后状态>", runtimeVerified: false }`（不会自动应用新载荷，也不会自动重启宿主）。恢复完成后，请点击「刷新状态」并重新生成预览。

### 3.3 错误码与故障排查对照表

| 错误码 / 状态 | 触发原因 | 排查与解决步骤 |
|---|---|---|
| `NO_SERVICE` / `SERVICE_UNAVAILABLE` | 尚未在 OpenChamber 中批准本扩展的本地服务权限，或服务被禁用 | 前往 OpenChamber「设置 → 扩展」（`Settings → Extensions`），启用扩展并批准本地服务（`service`）权限后刷新面板。 |
| `CONFIRMATION_REQUIRED` (409) | 7 项必选声明未全部勾选，或请求体包含未知字段 | 核实运行环境后逐项勾选全部 7 个复选框。 |
| `UNSUPPORTED_VERSION` (409) | 输入的 `omo`、`opencode` 或 `openchamber` 版本与已验证矩阵（`3.0.8` / `2.4.2` / `2.8.0`）不一致 | 本版本原生配置仅支持该精确版本矩阵；若宿主或插件版本不符，请勿写入。 |
| `MISSING_MODEL` (409) | `oh-my-opencode-slim.json(c)` 中 `document-writer` 或 `lark-operator` 未配置 `model` / `inheritModelFrom` | 先在 `oh-my-opencode-slim.json(c)` 的 `agents.<name>` 或当前激活 preset 中为这两个角色配置个人 `model` 或 `inheritModelFrom`，再重新预览。 |
| `MISSING_TRANSPORT` (409) | `acpAgents.antigravity.command` 或 `acpAgents.claude.command` 缺失或为空 | 先在 `oh-my-opencode-slim.json(c)` 中配置好 `antigravity` 与 `claude` 的本地 CLI 启动 `command` 字符串，再重新预览。 |
| `SHADOWED` (409) | 存在遮蔽冲突：①同时存在 `.json` 与 `.jsonc`；②激活的 `preset` 不存在或含 `extends` 继承；③受管角色在 JSON 中定义了内联 `prompt`/`appendPrompt`；④存在 `oh-my-opencode-slim/<preset>/<file>` 子目录文件或相反的 `<role>.md` / `<role>_append.md` 变体文件 | 移除重复配置文件、内联 `prompt`/`appendPrompt` 或遮蔽的变体文件；若使用带 `extends` 的 preset，需先简化为无 `extends` 的直列 preset。 |
| `DRIFT` (409) | ①上次应用后受管叶节点或受管提示词被外部手动修改（`generator.mjs:75` 校验当前磁盘值与上次已应用基线 `state.json` `entries[].after` 不一致；**即使 `overrides.jsonc` 的 `leaves`/`prompts` 填写了与手动修改相同的文本，生成器也不会自动采纳磁盘漂移**）；②预览与实际写入之间文件发生并发变化；③回滚/恢复时当前磁盘值与预期 `after`/`before` 不符 | 点击「刷新状态」。若需通过 `overrides.jsonc`（`leaves`/`prompts`）保留该手动定制，请按完整安全流程操作：①**先在本地另行记录**希望保留的个人文本；②在确认理解保留边界、**绝不整份覆盖 `oh-my-opencode-slim.json(c)` 且不执行全局批量恢复命令**的前提下，仅将偏离的受管叶节点或受管提示词恢复为上次已应用的受管值（`.omo-coworkers/state.json` 对应条目的 `after`）；③将第①步记录的个人文本写入 `<configRoot>/.omo-coworkers/overrides.jsonc` 白名单的 `leaves` 或 `prompts`（若希望该项脱离扩展管理，也可将其路径加入 `unmanaged`）；④重新执行「预览应用」与「确认应用」。若仅需放弃手动修改并恢复受管值，直接执行第②步对齐到上次应用的 `after`（或回滚要求的基线）后再操作。 |
| `STALE_PREVIEW` (409) | 预览已超过 5 分钟、已被消费过、服务重启过，或磁盘文件/快照在预览后发生了变化 | 重新核对声明并点击「预览应用」或「预览回滚」生成新预览。 |
| `LOCKED` (409) | `<configRoot>/.omo-coworkers/lock` 存在（有另一写入/恢复操作正在进行，或留有未清理的锁） | 确认无并发操作。若处于 `recovery-required` 且原进程已退出，可通过面板显式执行「确认恢复中断写入」（`POST /recover` 会自动核验 `ESRCH` 并回收死锁）；若锁进程仍存活，等待其结束。 |
| `RECOVERY_REQUIRED` (409) | `<configRoot>/.omo-coworkers/journal.json` 存在（上次写入中断）或状态文件损坏 | 按照 §3.2 在面板勾选恢复磁盘写入确认并点击「确认恢复中断写入」（`POST /recover`）。 |
| `UNSAFE_PATH` (409) | 候选根、祖先路径或目标文件存在符号链接（symlink）、多硬链接（`nlink !== 1`）、非当前 UID/root 所有权，或存在 group/world 写权限（`mode & 0o022`，且未被私有的 `0700` 同 UID 祖先目录保护） | 检查 `<configRoot>` 及其下 `oh-my-opencode-slim*`、`.omo-coworkers/*` 的文件类型与权限：移除符号链接/硬链接，并将目录权限收紧为 `0700`、文件收紧为 `0600`。 |
| `INVALID_JSONC` / `AMBIGUOUS_KEYS` (409) | `oh-my-opencode-slim.json(c)` 或 `overrides.jsonc` 存在 JSONC 语法错误、顶层不是对象、包含重复键，或包含 `__proto__`/`prototype`/`constructor` | 修复对应 JSON/JSONC 文件的语法错误或重复键后重试。 |
| `INVALID_OVERRIDES` / `INVALID_MANAGED_VALUE` (409) | `.omo-coworkers/overrides.jsonc` 包含未知顶层键、非白名单路径，或覆盖值为空/非字符串 | 按 §2.3 检查 `overrides.jsonc`，仅保留合法白名单键与非空字符串值。 |
| `PAYLOAD_CHANGED` / `BLOCKED` / `IO_FAILURE` | 随包提示词哈希与 `manifest.json` 不符、回滚时无有效 `apply` 状态记录、配置文件超过 4 MiB 上限，或底层文件系统 I/O 报错 | 检查扩展包完整性、磁盘空间与目录权限后刷新状态重试。 |

---

## 4. 默认关闭的旧版运行时转换与可选 Claude 派发守卫（`openchamber/plugin`）

`openchamber/plugin/index.mjs` 中的两项 OpenCode V2 插件运行时钩子**默认均处于关闭状态**，且仅受宿主进程环境变量（`process.env`）精确字面量 `"1"` 控制（忽略 `ctx.options` 与会话状态）：

1. **可选 Claude 派发守卫（`OMO_COWORKERS_ENABLE_CLAUDE_GUARD=1`，默认关闭，独立生效）**：
   - 在启动 OpenChamber / OpenCode V2 宿主进程前设置：
     ```bash
     export OMO_COWORKERS_ENABLE_CLAUDE_GUARD=1
     ```
   - 启用后会加载 `plugins/claude-advisor/index.js`（`ctx.tool.hook("execute.before", ...)`），对发往 `claude` 的 `task`/`subagent` 及 `acp_run`（仅允许 `{ agent, prompt }` 参数）强制执行可见 ASCII 与 524,288 字节上限检查。
   - 若你已通过本地配置目录（如 `plugins/claude-advisor`）直接加载了 `claude-advisor`，请保持 `OMO_COWORKERS_ENABLE_CLAUDE_GUARD` 未设置，以免重复注册同一钩子。

2. **旧版保留的运行时 `document-writer` 转换（`OMO_COWORKERS_ENABLE_WRITER_ROLE=1`，默认关闭）**：
   - **使用 `v6.0.0` 原生配置交付时，必须保持 `OMO_COWORKERS_ENABLE_WRITER_ROLE` 未设置（关闭）**——面板的 7 项确认之一（`writerRuntimeDisabled`）即要求确认该开关未启用，避免运行时 `ctx.agent.transform` 与已落盘的原生静态文件叠加或因路由段已被原生接管而报 `ROUTING_CONFLICT`。
   - 仅在不使用原生配置落盘、且已有非禁用 `document-writer` 角色的旧版环境中，显式设置 `export OMO_COWORKERS_ENABLE_WRITER_ROLE=1` 才会调用 `setupWriterRole(ctx)`（`openchamber/plugin/writer-role.mjs`）。

---

## 5. 扩展更新、卸载语义与本地状态留存边界

1. **源码修改 → 提交发布 → 扩展更新 → 面板重新应用**：
   - 在本仓库修改 `openchamber/native-config/` 或 `openchamber/plugin/roles/document-writer.md` 后，必须同步 `openchamber/native-config/manifest.json` 中的 `sha256` 并提升根 `package.json` 与 `openchamber/plugin/package.json` 的 semver `version`。
   - OpenChamber 仅通过对比远端根 `package.json` 的更高 semver `version` 检测扩展更新（检查结果缓存 1 小时，且需用户在宿主 UI 手动点击应用更新）。
   - **扩展更新绝不自动改写磁盘上的原生配置文件，也不自动代表跨 semver 状态兼容**：通过 OpenChamber 安装或更新扩展源码仅替换已安装的扩展包文件，本身并不自动建立或证明跨 semver 版本的 `.omo-coworkers/state.json` 状态迁移兼容（跨版本状态记录与内容版本兼容需由后端状态契约及「旧状态 → 新内容 → 原始基线回滚」专项验证支撑）。在受支持的状态版本范围内更新扩展后，面板会显示新的「已安装扩展 / 随包内容版本 / 随包清单哈希」以及旧的「已应用版本 / 已应用内容哈希」；操作者需在面板重新勾选确认、生成预览并点击「确认应用」，随后手动重启 OpenCode 才会使新内容生效。
2. **`.omo-coworkers/` 状态目录与备份边界**：
   - `<configRoot>/.omo-coworkers/` 目录包含 `state.json`（上次已提交事务的受管项 `before`/`after` 记录）、事务进行中的 `journal.json`、`lock` 锁文件，以及用户可选创建的 `overrides.jsonc`。
   - **非完整个人配置备份**：`state.json` 与 `journal.json` **仅保存 7 份受管提示词和 10 个受管叶节点的变更前后文本**，不包含 `oh-my-opencode-slim.json(c)` 的完整文件副本，也不备份 `opencode.json` 或其他目录。
3. **卸载或禁用扩展的留存行为**：
   - 在 OpenChamber 中卸载或禁用 `omo-coworkers` 会移除扩展包、贡献的三项技能、面板及本地服务进程（需宿主刷新或重启插件生命周期）。
   - **卸载扩展不会自动删除或回滚 `<configRoot>` 下已写入的 `oh-my-opencode-slim*` 文件，也不会删除 `<configRoot>/.omo-coworkers/` 目录**。
   - 如希望在卸载扩展前还原受管配置，请先在面板执行「预览回滚 → 确认回滚」，待状态变为 `rolled-back-pending-restart` 后再卸载扩展并重启 OpenCode。
4. **与已有全局技能或插件的共存注意**：
   - 若主机 `~/.config/opencode/skills/` 或 `~/.agents/skills/` 中仍存有早期安装的 `maintaining-product-engineering-docs`、`domain-modeling` 或 `humanizer` 副本，会与扩展贡献的同名技能并存；请由操作者显式决定保留哪一处来源，扩展不会自动删除已有目录。

---

## 6. 仓库验证与部署后运行时边界

### 6.1 仓库离线单元与包验证测试（不触碰本机全局配置）

在仓库检出目录（Node `>=20`）下，所有测试均在仓库内忽略目录（`.opencode/work/validation/`）或隔离沙箱中运行，不读写 `~/.config/opencode`：

1. **运行完整仓库测试套件**：
   ```bash
   npm test
   ```
2. **运行原生配置生成器、事务故障注入、服务 API 及真实 OMO 3.0.8 加载器对齐测试**：
   ```bash
   OMO_SLIM_PACKAGE_ROOT=/path/to/installed/oh-my-opencode-slim@3.0.8 \
   TMPDIR="$PWD/.opencode/work/validation" \
   node --test test/native-config-generator.test.mjs test/native-config-transaction.test.mjs test/native-config-service.test.mjs test/native-config-parity.test.mjs
   ```
   - `test/native-config-parity.test.mjs` 在隔离的 `HOME`/`XDG_CONFIG_HOME` 子进程中调用真实安装的 `oh-my-opencode-slim@3.0.8` 导出的 `loadPluginConfig` 与 `loadAgentPrompt`，核验生成的配置通过 OMO 3.0.8 运行时 Zod schema 且 7 份提示词读取字节完全一致。
3. **运行面板、搬迁发布包与宿主解析器测试**：
   ```bash
   OPENCHAMBER_WEB_ROOT=/path/to/installed/@openchamber/web \
   node --test test/native-panel.test.mjs test/openchamber-package.test.mjs test/writer-role.test.mjs
   ```
   - `test/openchamber-package.test.mjs` 将 `package.json` 的 `files` 发布白名单复制到无 `node_modules` 的隔离目录，使用真实 OpenChamber `2.8.0` 的 `inspectGuestPackage` 与 `resolveOpenCodePluginFolder` 校验 `panel`（`.js` 入口脚本）、`service`、`skills`、`opencodePlugin` 清单合规性、本地 SDK 浏览器桥闭包可搬迁性，以及 20 组合插件环境变量冷加载矩阵。

### 6.2 离线测试与面板写入无法替代的运行时核验边界

仓库测试与 `native-config-parity.test.mjs` **仅证明离线确定性生成、故障恢复状态机以及隔离环境下 OMO 3.0.8 配置文件加载器兼容性**；它们**不证明**运行中宿主的最终服务代理定义、ACP 外部进程连通性、模型实际推理表现或上游 LLM 提示词缓存命中率。同理，面板显示写入完成或宿主进程重启成功**不等于**运行时验证通过（API 与面板始终标注 `runtimeVerified: false`）。

在每次经授权执行面板写入/回滚并通过宿主 UI 手动重启 OpenCode 后，操作者必须在运行中的宿主上单独核验：

1. **最终生效的代理定义（Served Agent Definitions）**：确认运行中服务的 `document-writer`、`lark-operator`、`orchestrator`、`oracle`、`explorer`、`designer`、`fixer` 及 `acpAgents`（`antigravity`、`claude`）的生效提示词、描述、`model`、`permissions`、`skills` 与预期一致，且未被项目级 `.opencode/oh-my-opencode-slim*` 意外覆盖。
2. **新会话派发行为**：在新建会话中确认 `orchestrator` 能按预期向 `document-writer` 派发 `MODE` 与 `PROFILE`（`COMMUNICATION` / `FORMAL`），且外部 ACP 代理与权限模式（如 `antigravity` 的 `"ask"`）符合个人配置。

---

## 7. 历史归档：旧 `dotfiles/opencode` 写入链退役与 `3.x` / `2.x` 安装清理参考

### 7.1 旧 `dotfiles/opencode` OMO 写入链退役说明（`6.0.0`）

- 自 `6.0.0` 起，`dotfiles/opencode` 中的 `runtime/profile.json` 已将 `oh-my-opencode-slim.json`、`oh-my-opencode-slim.jsonc` 和 `oh-my-opencode-slim/**` 标记为 `ownership.status: "retired"`（`owner: "omo-coworkers OpenChamber extension"`, `historicalInputsOnly: true`）。
- `dotfiles/opencode/runtime/lib/ownership.mjs`（`assertLegacyOwnership`）与 `activate.mjs`、`writer-role-update.mjs` 已在代码层锁定：凡涉及 `oh-my-opencode-slim*` 路径，`oprofile plan-activation`、`oprofile activate`（含 `--replace`）、`oprofile adopt`、`oprofile rollback` 及 `node opencode/runtime/bin/update-writer-role.mjs` 均在任何写入前直接拒绝退出（退出码 `2`）。
- `dotfiles/opencode` 仓库中保留的 `oh-my-opencode-slim*`、`runtime/resources/writer-role/` 与 `oprofile stage` 仅作为离线历史暂存（staging）与个人模型/权限/技能参考，不得再用于向实时配置根部署 OMO 配置。

### 7.2 早期 `3.x` / `2.x` CLI 安装器遗留文件清理参考

> **仅作历史归档参考——`4.0.0` 起仓库已移除 `coworkers-install` 与 `dw-install` 命令**。

若目标机器或项目目录中仍留有早期 `3.x` / `2.x` CLI 安装器写入的清单（项目级 `.opencode/omo-coworkers-install.json` 或全局 `<configDir>/omo-coworkers-install.json` 及 `omo-coworkers-backup/<stamp>/`），扩展升级不会自动删除这些文件。如需清理，请先核对当时清单记录的文件哈希与所有权，在确认不误删个人修改的前提下按路径归档或移交本扩展面板管理，切勿盲目删除未核实的配置文件。
