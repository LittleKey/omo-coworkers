# 安装、配置管理器操作、升级与故障排查指南 (Installation, Config Manager, Upgrade & Troubleshooting Guide — `v6.1.0`)

本文档面向已熟悉 OpenCode 与 OpenChamber 的仓库使用者与维护者，说明如何在不依赖此对话上下文、也不运行已退役的 `dotfiles/opencode` OMO 激活脚本的前提下，安装或更新 `omo-coworkers`（`v6.1.0`）扩展，并使用内置的 **OMO 配置管理器（Config Manager，API v2）** 查看受保护结构快照、修改常用模型/预设/ACP 普通字段、按需显式揭露提示词、按 5 族独立内置增强模板或我的模板组合应用、管理独立插件行为设置（`Claude guard`），以及执行条件撤销与显式中断恢复。

---

## 1. 前置条件、版本基线与阶段边界

1. **宿主与运行环境版本要求**：
   - **OpenChamber 扩展加载门槛**：`package.json` 声明 `engines.openchamber: ">=2.8.0"`（需要 OpenChamber `2.8.0` 及以上版本才支持 `contributes.panel`、`contributes.service`、`contributes.skills` 与 `contributes.opencodePlugin`）。
   - **原生配置 schema 与对等测试基线**：配置管理器的内置字段分类与 5 族内置增强模板基于官方 **`oh-my-opencode-slim` `3.0.8`**（本地拷贝 schema：`openchamber/native-config/schema/omo-3.0.8.json`）。仓库自动化测试在 **OpenCode `2.4.2` / OpenChamber `2.8.0` / `oh-my-opencode-slim` `3.0.8`** 环境下，通过隔离子进程调用真实 OMO `3.0.8` 加载器验证了旧版 7 份提示词 + 10 个叶节点生成产物（`test/native-config-parity.test.mjs`），并通过受认证服务 + 隔离 Chromium 验证了面板关键工作流（`test/native-config-manager.test.mjs`、`test/native-panel.test.mjs`）；**注意：上述旧版 7 提示词加载器测试并不代表对任意配置管理器差量修改或全部原生 schema 结构的运行时等价证明**。与 `v6.0.0` 不同，`v6.1.0` **已移除「手填三项精确版本号 + 七项人工勾选声明」的前置审批门槛**；凡未在 `openchamber/native-config/schema/omo-3.0.8.json` 与 `openchamber/native-config/manager.mjs`（`contextKnown`）中同时列为普通字段的原生 schema 结构在面板中会自动归入 `protected` 受保护占位符，避免被普通表单误改或破坏。
2. **严格区分六个独立阶段（切勿混同）**：
   - **阶段 A — 源码修改 / Git 提交**：修改本仓库或 `dotfiles/opencode` 中的文件仅改变仓库工作区或 Git 历史，不会自动更新 OpenChamber 已安装的扩展，也不会触碰 `~/.config/opencode`。
   - **阶段 B — 扩展安装 / 更新**：在 OpenChamber 中安装或更新 `omo-coworkers` 会把扩展文件部署到 OpenChamber 的扩展目录，加载扩展代码、配置管理器面板、本地服务入口、默认关闭的 V2 插件入口及三项通用技能（`maintaining-product-engineering-docs`、`domain-modeling`、`humanizer`）。**扩展安装、宿主启动与服务启动均不会自动写入 `~/.config/opencode` 下的任何原生 OMO 配置文件或 `.omo-coworkers/` 状态文件**。
   - **阶段 C — 本地宿主服务权限授予 (`runtime: "host"`)**：在 OpenChamber `设置 → 扩展`（`Settings → Extensions`）中批准 `omo-coworkers` 的本地服务权限，仅允许宿主在 `127.0.0.1` 随机端口拉起 `openchamber/service/main.mjs`。**该服务拥有当前操作系统用户的完整宿主 Node 权限，不是操作系统文件沙箱**；批准服务运行权限本身不会触发任何写入（自动读取快照 `GET /snapshot`、查询模板 `GET /templates`、查询扩展贡献 `GET /contributions` 与生成差异预览 `POST /preview` / `POST /template-preview` 在文件系统上均完全只读）。
   - **阶段 D — 面板显式保存配置 / 更新行为设置**：核对预览及必要的风险确认后保存（`PATCH /config`）；受保护的提示词原文可能未显示。行为设置通过独立的 `PATCH /settings` 保存。
   - **阶段 E — 手动重载 / 重启托管 OpenCode 宿主**：本地服务无权自动重启 OpenCode。配置提交可能返回 `saved-pending-reload`；迁移和恢复分别返回 `migrated`、`recovered`，行为设置使用独立响应。面板提示仅反映本地操作，不证明运行态已更新。原生配置或行为需要生效时，由操作者在 OpenChamber 中手动重载或重启 OpenCode。
   - **阶段 F — 重启后运行时核验**：宿主重启完成**不等于**新配置已在运行中会话核验通过，仓库内的隔离 OMO 加载器测试（`test/native-config-parity.test.mjs`）或隔离 Chromium 面板测试也**不等于**真实宿主会话与模型路由已对齐；必须在重启后的新会话中按第 7 节完成运行时核验。

---

## 2. 扩展安装与本地宿主服务授权

### 2.1 从本地仓库或发布包安装扩展

1. 确认本仓库位于本地工作区（例如 `/home/littlekey/github/omo-coworkers`），且 `package.json` 与 `openchamber/plugin/package.json` 版本均为 `6.1.0`。
2. 打开 OpenChamber（`>= 2.8.0`），进入 **`设置 → 扩展`（`Settings → Extensions`）**。
3. 选择从本地路径或打包产物安装/加载 `/home/littlekey/github/omo-coworkers`。
4. 安装完成后：
   - 三项通用技能（`maintaining-product-engineering-docs`、`domain-modeling`、`humanizer`）随 `contributes.skills` 注册；
   - `openchamber/plugin/index.mjs` 随 `contributes.opencodePlugin` 注册，但其中两个运行时钩子（`Claude guard` 与旧版 `writer-role` 运行时转换）**默认全部关闭**；
   - 左侧或扩展栏出现 **「OMO Coworkers」** 面板入口（`panel.id: "omo-coworkers"`）。

### 2.2 授予本地宿主服务权限并确认自动快照

1. 在 OpenChamber `设置 → 扩展` 中找到 `omo-coworkers`，检查 `contributes.service`（`openchamber/service/main.mjs`, `runtime: "host"`）的权限状态。
2. 确认当前主机是受信任的本地环境后，批准该本地服务运行。
   - **安全提示**：`runtime: "host"` 使用宿主 Node 直接运行在当前用户权限下，具有完整本地文件读写能力，不是沙箱。服务仅监听 `127.0.0.1` 随机回环端口，所有 HTTP 请求均要求宿主桥接注入的 `Authorization: Bearer <TOKEN>`（缺失或错误返回 `401 UNAUTHORIZED`），请求体上限为 **63,000 UTF-8 字节**，并仅暴露有限的配置、配方、迁移和行为设置路由。
3. 打开 **「OMO Coworkers」** 面板，顶部状态栏会立即通过 `GET /snapshot` 自动读取并显示：
   - **候选配置目录**：默认解析 `$XDG_CONFIG_HOME/opencode`（未设置时为 `~/.config/opencode`）；
   - **主配置文件**：若 `oh-my-opencode-slim.jsonc` 与 `oh-my-opencode-slim.json` 同时存在，按原生加载优先级自动选用 `.jsonc`，并在顶部诊断栏给出 `SHADOWED` 提示（指出 `.json` 已停用并被忽略，不再像 `v6.0.0` 那样直接锁定拒绝）；若主配置文件尚不存在，面板会标识将在首次保存时创建 `oh-my-opencode-slim.jsonc`；
   - **运行态提示**：固定显示 `待重启 OpenCode 后生效（无法自动确认运行态）`（`runtimeVerified: false`）。

### 2.3 配置根范围与路径安全边界

- **仅支持本机默认候选目录**：宿主不会向扩展服务透传 `OPENCODE_CONFIG_DIR`、`OPENCODE_CONFIG`、`OH_MY_OPENCODE_SLIM_PRESET` 或项目级 `.opencode/` 覆盖环境。面板顶部展示的路径仅代表本机默认候选目录，**不代表运行中 OpenCode 进程的真实配置来源证明**；自定义外部配置根在当前版本中不支持（API 请求体仅接受有限白名单字段，不接受自定义 `root`）。
- **私有祖先目录与配置根内符号链接支持（`409 UNSAFE_PATH`）**：
  - 只要配置根或其同 UID 祖先目录具备 `0700` 私有目录边界（无 group/other 写权限穿透），管理器允许其内部的配置文件与目录使用常规权限（如 `0775`/`0664`）；若整条祖先链在达不到私有目录前都是共享可写，则会报 `409 UNSAFE_PATH`。
  - 允许配置文件或提示词文件是指向**同一配置根内部**的符号链接（管理器会校验解析后的真实目标仍在配置根内，写入时保留逻辑符号链接路径且不对其调用 `chmod`）；但**指向配置根外部的符号链接、替换根路径的符号链接或多硬链接文件（`nlink > 1`）一律以 `409 UNSAFE_PATH` 拒绝**。

---

## 3. 从 `dotfiles/opencode` 或 `v6.0.0` 升级与所有权移交

### 3.1 从 `v6.0.0` 升级到 `v6.1.0`

1. 在仓库更新到 `v6.1.0` 后，在 OpenChamber `设置 → 扩展` 中重新安装或更新扩展（OpenChamber 以 `package.json` 的 semver 版本号判断扩展包更新；`6.0.0 -> 6.1.0` 会刷新扩展缓存）。
2. **显式迁移旧状态**：停止旧服务及所有旧写入流程。启动、快照和预览不会自动迁移。若存在旧 `journal.json` 或 `manager-journal.json`，先使用对应旧版恢复流程解决；新服务对旧日志返回 `LEGACY_RECOVERY_REQUIRED`，不会自动恢复它们。
3. 在「变更记录」中打开「显式迁移旧管理状态」，确认旧写入者已停止；若存在旧模板收据，另行确认放弃长期升级、永久移除及恢复首次状态的能力。预览迁移并确认保存：旧文件保留，用户模板按校验迁移，旧撤销与所有权指令不导入。迁移是独立类型的适配操作，复用预览确认，不是普通配置差量。
4. 新的 `.omo-coworkers/manager-state.json`（format 3）建立后是唯一权威；损坏或格式不明时停止并排查，不得回退旧状态继续写。`behavior.json` 独立。旧 `overrides.jsonc` 不自动删除。

### 3.2 从旧 `dotfiles/opencode` 迁移与接管

1. **确认旧 `dotfiles/opencode` OMO 写入链已退役**：
   - `~/github/dotfiles/opencode/runtime/profile.json` 已标记 `ownership.status: "retired"`（`historicalInputsOnly: true`）。
   - `runtime/lib/ownership.mjs`（`assertLegacyOwnership`）与 `runtime/lib/writer-role-update.mjs` 已在代码层硬性拦截 `oh-my-opencode-slim.json`、`oh-my-opencode-slim.jsonc` 与 `oh-my-opencode-slim/**`：运行 `oprofile plan-activation`、`activate`（含 `--replace`）、`adopt`、`rollback` 或 `update-writer-role.mjs` 均会在写入前以退出码 `2`（`OWNERSHIP_MOVED`）整条拒绝。
2. **停用旧运行时转换与外部同步守护进程**：
   - 确保未在宿主环境中设置 `OMO_COWORKERS_ENABLE_WRITER_ROLE=1`（或在 `v6.1.0` 中当 `<configRoot>/.omo-coworkers/behavior.json` 存在时，`readBehaviorSettings()` 会在 `source: "settings"` 下始终返回计算值 `writerTransformEnabled: false`，且 `updateBehaviorSettings()` 落盘时也会固定写入 `writerTransformEnabled: false`），且没有外部脚本正在并发修改 `~/.config/opencode/oh-my-opencode-slim*`。
3. **在 `v6.1.0` 配置管理器中直接纳管或按需应用模板**：
   - 打开「OMO Coworkers」面板，管理器会自动读取现有的 `oh-my-opencode-slim.json(c)` 与 `oh-my-opencode-slim/*.md`（即使其中的提示词或叶节点来自旧版 `dotfiles` 或手工编辑，也不会像 `v6.0.0` 那样因哈希不同而锁死整份配置）。
   - 如需将提示词或角色/ACP 指导更新为扩展内置版本，切换到 **「增强模板」** 页，按需选择对应的独立模板族预览并保存即可。

---

## 4. 配置管理器日常操作指南（四个标签页）

若有未保存或无效的普通编辑草稿，使用模板、用户模板增删、撤销、迁移、恢复或行为设置等不兼容操作前，请先保存或放弃草稿。请求处理期间面板暂时冻结交互，请等待完成；失败后核对保留的草稿。

### 4.1 「配置」页：普通字段编辑、快捷创建、提示词显式揭露与差量保存

1. **左侧资源列表**：
   - 包含主配置文件（`oh-my-opencode-slim.jsonc`，`resourceId: "config"`）以及已存在的受管提示词文件（`oh-my-opencode-slim/{orchestrator_append,oracle_append,explorer_append,designer_append,fixer_append,document-writer,lark-operator}.md`）。
2. **常用设置表单、快速添加/复制与 schema 识别边界**：
   - **全局与预设**：可编辑当前激活 `preset`、`autoUpdate`、`presets.<preset>.extends`，或基于已有 Preset 复制出新 Preset（仅复制其下可编辑的普通字段）。未知或未分类字段仍受保护。
   - **角色与模型（Agents）**：可编辑现有角色字段，或输入新角色名与模型加入草稿。已识别字段包括 `model`（字符串或字符串数组）、`variant`、`inheritModelFrom`（`"session"` | `"orchestrator"`）、`temperature`（`0`–`2`）、`skills`、`skills_add`、`skills_remove`、`skills_include_local`、`mcps` 以及 `permission`（标量 `"allow"` / `"ask"` / `"deny"` 或 `permission.<tool>` 叶节点）。
   - **外部 ACP 代理（ACP Agents）**：可选择或新建 ACP 代理（如 `claude`、`antigravity`），编辑已识别的 `command`、`args`、`cwd`、`wrapperModel`、`timeoutMs`（0–2147483647 的整数毫秒）与 `permissionMode`（`"ask"`、`"allow"` 或 `"reject"`）。已有可编辑字段的面板控件提供相应数值约束与选项；**内置模板不会把旧 `dotfiles` 的 `"reject"` 设为默认**。
   - **勾选导出到我的模板**：每个普通字段右侧均提供「选入模板」复选框，勾选后可在「增强模板」页一键保存为数据型用户模板（执行命令/路径字段 `command`、`args`、`cwd` 与提示词/受保护字段不提供勾选，服务端也会以 `409 PROTECTED_FIELD` 硬性拒绝导出）。
3. **受保护字段与提示词显式揭露（`POST /reveal`）**：
   - 凡被归类为 `protected` 的字段（基于启发式规则识别已知敏感键名 `env`/`headers`/`authorization`/`apiKey`/`token`/`secret`/`password`/`credentials`/`provider`/`mcpServers`、已知凭据/令牌特征值如 `{env:...}`、`Bearer`/`Basic`、`-----BEGIN`、`sk-`/`ghp_`/`github_pat_`/`xox*-`、含内嵌凭据的 URL 或查询参数，以及未在 `omo-3.0.8.json` 与 `contextKnown` 中同时登记的结构）在界面中仅显示 `受保护字段（已隐藏，不可在此直接读取或覆盖）` 与哈希占位符，无法在面板中查看或覆盖（尝试揭露或写入会返回 `409 PROTECTED_FIELD`）。**注意：启发式规则无法识别被伪装成普通文本并写入普通可编辑字段的任意自定义秘密**。
   - 凡被归类为 `prompt` 的文本（角色/ACP 的 `prompt`、`appendPrompt`、`orchestratorPrompt`、`description` 或 `.md` 提示词资源），默认显示 `默认隐藏提示词正文；点击下方按钮后才向本地服务请求该字段`；点击 **「查看并编辑这段提示词」** 会调用 `POST /reveal`（需携带 `confirm: true` 且通过服务端无敏感模式核查；若含敏感凭据特征会返回 `409 PROTECTED_FIELD`），揭露后方可在文本框中编辑并加入草稿（未揭露直接提交修改会返回 `409 REVEAL_REQUIRED`）。
4. **高级 · 完整受保护结构与新增字段**：
   - 展开底部「高级 · 完整受保护结构与新增字段」可查看结构投影；新增字段时输入 JSON 字符串数组路径（如 `["agents","custom","model"]`）与 JSON 值，再加入草稿。
   - **边界说明**：此视图仅对已分类的普通字段生成单字段差量操作（单次最多 **32** 项操作、总请求体不超过 **63,000 UTF-8 字节**），**不是原始全文 JSONC 编辑器**；尝试写入受保护路径、未知根级字段或未揭露的提示词会在预览/保存时被服务端拒绝。
5. **预览真实差异、冲突变基与保存（`POST /preview` → `PATCH /config`）**：
   - 修改任意字段后，底部浮层会提示 `存在 N 项未保存草稿`。点击 **「预览差异」**，面板调用只读的 `POST /preview` 并展示变更及风险标签。普通字段显示前后值；提示词在同一有效快照显式揭露后显示前后正文，否则旧个人正文仅显示摘要，公开配方目标正文可显示。存在标志区分缺失与未揭露；揭露授权只保存在内存。
   - 若变更包含删除字段（`risk: "delete"`）、修改 ACP 执行命令/参数/目录（`risk: "execution"`）或放宽权限/自动批准（`risk: "permission"`），必须在预览区勾选 **`我已核对上述删除、执行命令或权限放宽变更`**（`confirmRisk: true`），「保存到配置文件」按钮才会解锁。
   - 点击 **「保存到配置文件」** 调用 `PATCH /config`：
     - 服务端通过 `jsonc-parser` 对 JSONC 执行最小 AST 局部修改，**完整保留原有的 JSONC 注释、缩进及未触碰的个人模型、权限、环境变量与秘密字段**；
     - **非冲突自动变基（Rebase）**：若在生成预览后、点击保存前，外部编辑器修改了配置文件中的**其他无关字段**，服务端会自动在最新文件状态上变基应用本次变更；
     - **同字段冲突保护（`409 CONFLICT`）**：若外部修改了本次预览所涉及的**同一字段**，服务端会拒绝覆盖并精确列出冲突字段（`conflicts`）；此时点击 **「重新读取」** 会刷新最新快照并**保留你当前的本地草稿**，以便重新生成预览或点击「放弃草稿」。

### 4.2 「增强模板」页：内置配方与我的模板

1. **5 族独立内置增强模板（按需组合，互不捆绑）**：
   - **`document-role`（文档写作角色与路由）**：配方包含 `agents.document-writer` 的 `description`、`orchestratorPrompt` 和 `oh-my-opencode-slim/document-writer.md` 提示词文件（复用唯一冻结源 `openchamber/plugin/roles/document-writer.md`）。可选 `inheritModelFrom`（`session` 或 `orchestrator`）；已有个人模型保留，缺少模型时提示 `MISSING_MODEL`，不要求配置无关的角色或 ACP 代理。
   - **`lark-role`（飞书操作角色与路由）**：配方包含 `agents.lark-operator` 的 `description`、`orchestratorPrompt` 和 `oh-my-opencode-slim/lark-operator.md` 提示词文件；可选 `inheritModelFrom`（`session` 或 `orchestrator`），并检查该角色的 `MISSING_MODEL` 提示。
   - **角色模型继承的保守限制**：选择了 `inheritModelFrom` 且选中 preset 包含 `extends`（无论其值为何），或 preset 选择器无法解析时，配方不会自动加入该继承字段，并提示 `PRESET_MODEL_INHERITANCE_UNRESOLVED`。请自行核对有效模型后手动配置；其他描述和提示词配方仍可预览。
   - **`collaboration`（核心角色协作附加提示词）**：支持按需选择 `orchestrator`、`oracle`、`explorer`、`designer`、`fixer` 的子集，为所选角色提供对应的 `oh-my-opencode-slim/<agent>_append.md` 提示词文件；不写入 `appendPrompt` 配置字段，也不依赖新角色模型或 ACP 传输配置。
   - **`claude-acp-guidance`（Claude ACP 委派指导）**：为 `acpAgents.claude` 设置内置 `prompt`、`description` 与 `orchestratorPrompt`（不写入 `command`/`args` 或 `permissionMode`）；若尚未配置 `acpAgents.claude.command` 仅给出 `MISSING_TRANSPORT` 提醒。
   - **`antigravity-acp-guidance`（Antigravity ACP 委派指导）**：为 `acpAgents.antigravity` 设置内置 `prompt`、`description` 与 `orchestratorPrompt`（不导入旧 `dotfiles` 的 `permissionMode: "reject"`）；若尚未配置 `acpAgents.antigravity.command` 仅给出 `MISSING_TRANSPORT` 提醒。
2. **应用配方**：点击「选择并查看差异」。完全匹配时返回 `NO_CHANGES`，不建立所有权。若已有个人值不同，先核对冲突，逐个勾选愿意替换的资源与字段并重新预览；确认风险后保存。模板没有永久移除或自动恢复首次状态功能。
3. **我的模板**：可复制内置配方及参数，或勾选普通字段后点击「从选中配置项保存模板」；创建、更新和删除都先预览，再统一保存。最多 20 个；不复制当前个人提示词，字段选择排除命令、路径和受保护内容。角色模板继承值仅 `session` / `orchestrator`，无需存在同名 `agents`，已有个人模型不覆盖。

### 4.3 「扩展内容」页：随包贡献查看与 `Claude guard` 独立行为设置

1. **区分「声明贡献」「行为设置已启用」与「宿主运行态（未知）」**：
   - `GET /contributions` 列出本扩展随包声明的四类能力：`omo-coworkers` 配置管理器面板与本地服务、三项通用技能（`maintaining-product-engineering-docs`、`domain-modeling`、`humanizer`）、`Claude guard` 运行时派发守卫钩子，以及 `document-writer` 角色资产（推荐使用 `document-role` 原生模板；旧版运行时 `writer-role` 转换保持停用 `writerTransformEnabled: false`）。
   - 所有条目均标记 `runtimeConfirmed: false`：面板展示的是扩展清单与 `.omo-coworkers/behavior.json` 设置状态，**无法直接观测运行中 OpenCode 实例的实际插件加载状态**。
2. **`Claude guard` 独立 CAS 开关与优先级（`PATCH /settings`）**：
   - 在「Claude 顾问守卫（运行时插件行为）」卡片中，必须先勾选 **`我已知晓该开关需要重载宿主，且本地服务无法自动确认是否与独立 claude-advisor 重复`**（`confirmEnable: true`），然后点击 **「开启 Claude 守卫」**（或点击 **「关闭 Claude 守卫」**）。
   - 该操作写入 `<configRoot>/.omo-coworkers/behavior.json`（`version: 1`，`updateBehaviorSettings` 落盘时写入 `{"version":1,"claudeGuardEnabled":...,"writerTransformEnabled":false}`；`readBehaviorSettings` 仅允许 `writerTransformEnabled` 缺省或为 `false`，并在 `source: "settings"` 下始终返回计算值 `writerTransformEnabled: false`），使用独立的 SHA-256 `revision` CAS 与专用锁 `.omo-coworkers/behavior.lock`，**不写入 `oh-my-opencode-slim.jsonc`，也不进入配置变更历史或配置撤销/恢复链**。
   - **优先级与失败关闭规则**：
     - 默认全部关闭（`claudeGuardEnabled: false`, `writerTransformEnabled: false`）；
     - 若 `<configRoot>/.omo-coworkers/behavior.json` 存在（`source: "settings"`），**以该文件设置为准，优先于任何进程环境变量**（即使宿主环境设置了 `OMO_COWORKERS_ENABLE_CLAUDE_GUARD=1` 或 `OMO_COWORKERS_ENABLE_WRITER_ROLE=1`，只要 `behavior.json` 存在，`writerTransformEnabled` 即固定返回 `false`，`claudeGuardEnabled` 以文件布尔值为准）；
     - 仅当 `behavior.json` **不存在**（`ENOENT`）时，插件才回退读取旧版精确环境变量 `OMO_COWORKERS_ENABLE_CLAUDE_GUARD=1` 与 `OMO_COWORKERS_ENABLE_WRITER_ROLE=1`（`source: "legacy-environment"`）；
     - 若 `behavior.json` JSON 格式损坏、包含非法键或 `writerTransformEnabled: true`、超过 4096 字节或路径不安全（符号链接/多硬链接），插件立即**失败关闭**（两项钩子均为 `false`，`source: "blocked"`）。
   - **独立插件重复提示（`DUPLICATE_OBSERVABILITY_UNKNOWN`）**：若你同时在 `opencode.json` 中单独加载了 `plugins/claude-advisor`，开启本开关会导致守卫重复执行；本地服务无法自动探测 `opencode.json` 的运行态插件列表（`duplicateObservation: "unknown"`），请勿同时启用两处。

### 4.4 「变更记录」页：有条件撤销与显式恢复

- `manager-state.json`（format 3）保存 `userTemplates`、最近 **10** 次 `undo` 和 `pending`，无七天期限；低频使用时历史文本可能保存更久。受 4 MiB 字节上限约束，保存或撤销可能被拒绝，不保证无限重做。
- 点击「预览撤销本次修改」（`POST /undo-preview`），核对差异后用 `PATCH /config` 保存；若相关字段已变化，返回 `CONFLICT`，无关字段保留。
- 提交先写 pending，再写原生文件，最后提交新状态；跨文件不是原子操作。中断后显式 `POST /recover`：已是 before 的不改、仍为 after 的条件还原，遇第三种值停止并保留 pending。旧 journal 使用旧版恢复流程，见 §3.1。

---

## 5. 故障排查与常见诊断码 (Troubleshooting)

| 诊断码 / 错误码 | 触发原因 | 排查与解决步骤 |
| :--- | :--- | :--- |
| `SHADOWED`（非阻塞快照诊断） | 配置根下同时存在 `oh-my-opencode-slim.jsonc` 与 `oh-my-opencode-slim.json`。 | 管理器已按原生优先级自动选用 `.jsonc` 并忽略 `.json`。建议核对后手动归档或移除停用的 `.json` 文件以消除歧义。 |
| `CUSTOM_ROOT_UNAVAILABLE` / `RUNTIME_UNCONFIRMED`（快照提示，非 HTTP 错误） | 仅管理默认候选目录；服务无法确认运行中宿主使用的配置。 | 面板以范围与运行状态说明呈现；核对实际宿主配置来源，重载后另行验证运行态。 |
| `INVALID_JSONC`（快照诊断 / `409`） | `oh-my-opencode-slim.json(c)` 存在语法错误，或根节点不是 JSON 对象。 | 诊断信息仅报告错误码与偏移位置，**不会在报错中回显文件中的秘密原文**。请在本地编辑器中修复 JSONC 语法错误后，回面板点击「重新读取」。 |
| `RECOVERY_REQUIRED` / `LEGACY_RECOVERY_REQUIRED` | 新状态 pending 或旧 journal 未完成。 | 新 pending 在「变更记录」显式恢复；第三值冲突时停止并核对。旧 journal 须按旧版流程处理，不能由新服务自动恢复。 |
| `MIGRATION_REQUIRED` / `LEGACY_STATE` | 存在旧状态而新状态尚未建立。 | 停止旧写入者并按 §3.1 显式迁移；旧收据须单独确认放弃长期撤回能力。 |
| `REVEAL_REQUIRED` (`409`) | 尝试直接修改尚未在当前服务会话中显式揭露（`POST /reveal`）的提示词字段或 `.md` 资源。 | 先在「配置」页选中对应角色或提示词文件，点击 **「查看并编辑这段提示词」** 显式揭露正文，再编辑并生成预览。 |
| `PROTECTED_FIELD` (`409`) | 尝试揭露或修改受保护字段（如含 `{env:...}`、凭据特征、`env`/`headers`/`apiKey`/`token`/`secret`/`password`/`credentials`、未在 `omo-3.0.8.json` 与 `contextKnown` 同时登记的字段），或在用户模板中包含禁止导出的提示词/命令/受保护字段。 | 受保护字段与凭据只能在本地配置文件中通过 `{env:VAR_NAME}` 或编辑器维护；用户模板仅支持复制内置模板引用或勾选已识别的普通数据字段。 |
| `CONFIRMATION_REQUIRED` (`409`) | 有风险的预览在统一提交时未确认，或揭露提示词、开启 `Claude guard`、显式恢复或迁移时缺少相应确认。撤销预览本身不需要额外确认标志。 | 核对预览及风险标签后确认保存；按具体操作确认揭露、行为开关、恢复或迁移。 |
| `CONFLICT` (`409`) | 目标字段、撤销目标或迁移源发生变化，或配方遇到不同的个人值。 | 重新读取并核对；配方仅逐项选择愿意替换的字段，再预览。 |
| `STALE_REVISION` (`409`) / `STALE_PREVIEW` (`409`) | 生成预览时依赖的快照 `revision` 已不存在于最近缓存，或预览已超过 5 分钟有效期、已被消费过、服务已重启。 | 点击面板顶部 **「重新读取」**（保留草稿）后，重新点击底部浮层的 **「预览差异」**。 |
| `BUSY` (`409`) / `LOCKED` (`409`) | 配置事务锁（`.omo-coworkers/lock`）或独立行为设置锁（`.omo-coworkers/behavior.lock`）正在被同一进程或存活进程占用。 | 等待正在进行的保存完成。注意：**行为设置锁 `behavior.lock` 独立于配置事务**，执行配置「中断恢复」不会清理 `behavior.lock`；若确认无存活进程占用，可检查 `.omo-coworkers/behavior.lock`。 |
| `UNSAFE_PATH` (`409`) | 候选配置根缺少同 UID `0700` 私有祖先边界、包含指向配置根外部的符号链接或多硬链接文件。 | 确保 `~/.config` 或 `~/.config/opencode` 归当前用户所有且具备 `0700` 权限，且配置文件/提示词未软链到配置根外部。 |
| `CAPACITY` (`409`) / `TOO_LARGE` (`413`) | 目标文件/历史超过 4 MiB 上限、用户模板数量超过 20 个上限（`409 CAPACITY`），或单次 HTTP 请求体超过 63,000 UTF-8 字节（`413 TOO_LARGE`）。 | 拆分单次修改（每次 1–32 项操作），或先删除不再使用的「我的模板」。 |
| `INVALID_VALUE` (`409`) / `INVALID_REQUEST` (`400`) | 字段值类型或枚举不合法（如 `temperature` 超出 `0`–`2`、`permissionMode` 非 `ask`/`allow`/`reject`），或请求 JSON 参数结构不满足白名单。 | 核对字段类型与取值范围后重新预览。 |
| 在旧 `dotfiles/opencode` 运行 `oprofile` 或 `update-writer-role.mjs` 报 `OWNERSHIP_MOVED` (exit 2) | `dotfiles/opencode` 的 OMO 写入链已永久退役。 | 请勿再通过 `dotfiles/opencode` 激活或更新 OMO 文件；统一使用 OpenChamber 中的 `omo-coworkers` 配置管理器面板。 |

---

## 6. 重要边界、非整份配置备份与卸载行为说明

1. **`.omo-coworkers/` 不是完整个人配置备份**：
   - `<configRoot>/.omo-coworkers/manager-state.json` 保存用户配方、撤销差量与 pending，`behavior.json` 独立保存行为开关；它们不是完整个人配置备份，旧文件可能仍留存。重要配置请自行备份。
2. **单文件原子替换与跨文件非原子边界**：
   - 单文件使用同目录临时文件、`fsync` 和 `rename`；跨文件不原子，依靠 format 3 pending 与显式 `POST /recover` 有条件恢复。
3. **卸载或禁用扩展的留存行为**：
   - 在 OpenChamber 中禁用或卸载 `omo-coworkers` 扩展**不会自动回滚或删除** `<configRoot>/oh-my-opencode-slim.json(c)`、`<configRoot>/oh-my-opencode-slim/*.md` 以及 `<configRoot>/.omo-coworkers/` 目录。
   - 卸载前如需撤销近期应用，请在「变更记录」预览并有条件撤销对应记录；超过最近十次不保证可撤销。核对后再决定是否卸载或清理状态。

---

## 7. 手动重载 OpenCode 后的运行时核验清单

每次在面板保存配置、应用模板、条件撤销、显式恢复或切换 `Claude guard` 后，请按顺序执行以下核验（**面板显示 `已写入本地配置文件` 或宿主重启成功均不代表运行态核验通过**）：

1. **检查磁盘落盘结果与注释保留**：
   - 在终端或编辑器中查看 `~/.config/opencode/oh-my-opencode-slim.jsonc`（或 `$XDG_CONFIG_HOME/opencode/oh-my-opencode-slim.jsonc`），确认只有预览中列出的字段发生了变化，原有的 JSONC 注释、个人模型、权限、ACP `command`/`args` 及 `{env:...}` 引用均完好无损。
   - 若应用了内置模板，确认对应的 `~/.config/opencode/oh-my-opencode-slim/*.md` 文件已生成且内容完整。
2. **手动重载 / 重启托管 OpenCode 宿主**：
   - 在 OpenChamber 界面中执行 OpenCode 重载或重启宿主服务，等待新进程就绪。
3. **在新会话中核验实际运行态行为**：
   - 开启一个**全新的** OpenCode 会话（旧会话可能缓存了重载前的角色或系统提示词）；
   - 验证所改角色的模型路由、Preset 切换或新增的 `document-writer` / `lark-operator` 子代理委派是否按新配置工作；
   - 若在「扩展内容」页开启或关闭了 `Claude guard`，验证向 Claude 子代理派发任务时的守卫拦截行为是否与 `.omo-coworkers/behavior.json` 的当前开关一致。
