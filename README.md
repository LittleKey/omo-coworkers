# omo-coworkers

**面向 OpenChamber 2.8.0+ 的扩展包（`v6.1.0`）：内置 OMO（`oh-my-opencode-slim`）原生配置管理器面板与本地宿主服务（在 `v6.0.0` 接管原 `dotfiles/opencode` OMO 提示词与受管字段的基础上，以自动读取受保护结构快照、真实变更差异预览、同字段冲突检测与非冲突自动变基、5 族独立内置增强模板与用户模板、显式提示词揭露、条件撤销/恢复以及独立插件行为设置取代了 `v6.0.0` 的七项人工声明审批面板）、三项通用协作技能、唯一冻结的 `document-writer` 上游角色载荷，以及默认关闭的运行时钩子（`Claude guard` 与旧版 `writer-role` 运行时转换）。**

*OpenChamber 2.8.0+ extension (`v6.1.0`) shipping the native OMO Config Manager, protected snapshots, differential edits, prompt reveal, recipe templates, conditional undo/recovery and separate behavior settings. Prompt previews may withhold personal text until deliberately revealed.*

## `v6.1.0` 交付内容与所有权边界 (What `v6.1.0` ships & ownership split)

`omo-coworkers` 在 `4.0.0` 重构为仓库根级 OpenChamber 扩展（`panel.id: "omo-coworkers"`），在 `5.0.0` 移除旧版 `supervisor` 插件与 CLI，在 `6.0.0` 接管原 `dotfiles/opencode` 的 OMO 原生提示词与配置叶节点交付并退役 `dotfiles` 写入链，并在 **`6.1.0`** 将 `6.0.0` 的「七项声明 + 三项手填精确版本 + 仅哈希预览」审批面板升级为直接管理原生 OMO 文件的 **OMO 配置管理器（Config Manager，API v2）**：

- **OMO 原生配置管理器（`openchamber/native-config/{manager,templates,generator,transaction}.mjs` + `openchamber/service/` + `openchamber/panel/`）**：
  - **打开即读受保护结构快照，无七项声明或手填精确版本门槛（`GET /snapshot`）**：
    - 面板连接本地服务后自动发现并读取默认候选配置根（`$XDG_CONFIG_HOME/opencode` 或 `~/.config/opencode`）下的 `oh-my-opencode-slim.jsonc` / `oh-my-opencode-slim.json`（`.jsonc` 与 `.json` 并存时按原生优先级选择 `.jsonc` 并给出 `SHADOWED` 诊断，不再整库锁定）及 `oh-my-opencode-slim/**/*.md` 提示词文件。
    - 服务端将字段分为 `ordinary`（普通可编辑字段）、`prompt`（提示词文本）与 `protected`（受保护字段）：普通字段返回当前值；提示词与受保护字段（基于启发式规则识别已知敏感键名 `env`/`headers`/`authorization`/`apiKey`/`token`/`secret`/`password`/`credentials`/`provider`/`mcpServers`、已知凭据/令牌特征值如 `{env:...}`、`Bearer`/`Basic`、`-----BEGIN`、`sk-`/`ghp_`/`github_pat_`/`xox*-`、含内嵌凭据的 URL 或查询参数，以及未在 `openchamber/native-config/schema/omo-3.0.8.json` 与 `contextKnown` 中同时登记的结构）仅返回 `{ "protected": true, "placeholder": "<hash>" }` 占位符，不向浏览器发送原始 JSONC 全文/注释，也不展开环境变量；**注意：启发式规则无法识别被伪装成普通文本并写入普通可编辑字段的任意自定义秘密**。
    - 由 `openchamber/native-config/manager.mjs` 与 `openchamber/native-config/schema/omo-3.0.8.json` 共同认定的可编辑 `ordinary` 字段包括：顶层 `preset` 与 `autoUpdate`、`presets.<preset>.extends`、`agents.<agent>.*`（及 `presets.<preset>.agents.<agent>.*`）下的 `model`、`variant`、`inheritModelFrom`（`"session"` | `"orchestrator"`）、`temperature`（`0`–`2`）、`skills`、`skills_add`、`skills_remove`、`skills_include_local`、`mcps`、`permission`（`"ask"` | `"allow"` | `"deny"` 或 `permission.<tool>` 叶节点），以及 `acpAgents.<agent>.*` 下的 `command`、`args`、`cwd`、`wrapperModel`、`timeoutMs`（整数毫秒）、`permissionMode`（`"ask"` | `"allow"` | `"reject"`）。「高级 · 完整受保护结构与新增字段」视图仅展示受保护结构投影并提交单字段差量操作（每次 1–32 项修改，请求体上限 63,000 UTF-8 字节），**不是原始全文 JSONC 编辑器，也不允许回写整份投影或任意未分类 schema 结构**。
  - **提示词按需显式揭露与编辑（`POST /reveal`）**：
    - 角色/ACP 内联提示词字段（`prompt`、`appendPrompt`、`orchestratorPrompt`、`description`）与 `oh-my-opencode-slim/**/*.md` 提示词资源默认不传输正文；仅当操作者在当前服务会话中针对具体资源/字段点击「查看并编辑这段提示词」（`POST /reveal`，需 `confirm: true` 且通过服务端无敏感模式核查；若命中敏感特征则以 `409 PROTECTED_FIELD` 拒绝）后才返回正文并允许加入草稿（未揭露直接提交修改会报 `409 REVEAL_REQUIRED`）。
  - **5 族独立内置增强模板与有界用户模板（`GET /templates`、`POST /template-preview`、`POST /user-templates`、`DELETE /user-templates`）**：
    - 原 `6.0.0` 捆绑应用的 7 份提示词与 10 个文本叶节点在 `6.1.0` 中拆分为 **5 族按需独立组合的内置模板**（`openchamber/native-config/templates.mjs`，仍以 `manifest.json`、`fragments/leaves.json`、`prompts/` 及唯一冻结源 `openchamber/plugin/roles/document-writer.md` 为单一事实来源）：
      1. `document-role`（`document-writer` 角色提示词与路由描述，可选参数 `inheritModelFrom`；仅检查 `document-writer` 的 `MISSING_MODEL` 前置提示，不要求配置无关的 `lark-operator` 或 ACP 传输）；
      2. `lark-role`（`lark-operator` 角色提示词与路由描述，可选参数 `inheritModelFrom`；仅检查 `lark-operator` 的 `MISSING_MODEL` 前置提示）；
      3. `collaboration`（按所选 `agents` 子集独立生成 `orchestrator`、`oracle`、`explorer`、`designer`、`fixer` 的 `*_append.md` 协作提示词，无模型或 ACP 前置门槛）；
      4. `claude-acp-guidance`（`acpAgents.claude` 的 `prompt`/`description`/`orchestratorPrompt`，仅提示 `claude` 的 `MISSING_TRANSPORT`）；
      5. `antigravity-acp-guidance`（`acpAgents.antigravity` 的 `prompt`/`description`/`orchestratorPrompt`，仅提示 `antigravity` 的 `MISSING_TRANSPORT`；绝不导入旧 `dotfiles` 中的 `permissionMode: "reject"`）。
    - **模板是配方**：匹配内容返回 `NO_CHANGES`，不建立长期所有权或收据。不同的个人值默认冲突；仅在面板逐项勾选愿意替换的资源与字段后重新预览。没有永久按模板移除或自动恢复首次状态的承诺。
    - 角色模板的 `inheritModelFrom` 可选 `session` 或 `orchestrator`，不要求对应 `agents` 条目，也不覆盖已有个人模型或继承设置。
    - **我的模板**：可复制内置配方及参数的引用，或从普通安全字段创建（排除提示词、命令、路径与受保护字段）；创建和删除均须先预览再保存，最多 20 个。
  - **统一预览、保存、撤销与恢复**：普通编辑、配方、用户模板增删及撤销先预览，再通过 `PATCH /config` 保存；风险变更须确认。普通字段展示前后值；提示词在同一有效快照中显式揭露后可显示前后正文，否则旧个人正文仅显示摘要，公开配方目标正文可显示。`beforeExists` / `afterExists` 区分不存在与未揭露，揭露授权仅存在内存。
    - 最近 **10** 次变更可条件撤销，无七天期限；低频操作时历史文本可能保存更久，受字节上限和冲突限制，不保证无限重做。`manager-state.json`（format 3）先记录 pending，再写原生文件并提交最终状态；跨文件不原子，显式恢复遇到第三种值会停止。
    - 启动和读取不迁移旧状态。迁移前停止旧写入者；存在旧收据须单独确认放弃长期撤回能力。未完成旧 journal 阻止迁移，需按旧版流程处理；旧文件保留，新状态建立后是唯一权威，损坏时不能回退旧状态继续写。
- **独立 CAS 行为设置与随扩展贡献内容视图（`GET /contributions`、`PATCH /settings`、`openchamber/plugin/behavior-settings.mjs`）**：
  - 面板「扩展内容」页清晰区分「随包声明贡献」「行为设置已开启」与「运行中宿主实际已加载（`runtimeConfirmed: false`）」。
  - `Claude guard` 开关持久化于 `<configRoot>/.omo-coworkers/behavior.json`（`version: 1`，存储 `claudeGuardEnabled: boolean` 与 `writerTransformEnabled: false`；`readBehaviorSettings()` 仅接受 `writerTransformEnabled` 缺省或为 `false`，并在 `source: "settings"` 下始终返回计算值 `writerTransformEnabled: false`），由专用排他锁 `.omo-coworkers/behavior.lock` 与 SHA-256 `revision` CAS 原子更新保护，**独立于配置事务的 WAL 日志、条件撤销与恢复**（若遇 `409 BUSY` 需单独检查 `behavior.lock`，配置恢复不会清理行为锁）。
  - **严格优先级与失败关闭（Fail-Closed）**：插件冷加载时默认全部关闭；若 `.omo-coworkers/behavior.json` 存在（`source: "settings"`），**文件设置优先于环境变量**；仅当 `behavior.json` **不存在**（`ENOENT`）时，才回退读取旧版精确进程环境变量 `OMO_COWORKERS_ENABLE_CLAUDE_GUARD=1` 与 `OMO_COWORKERS_ENABLE_WRITER_ROLE=1`（`source: "legacy-environment"`）。若 `behavior.json` 损坏、超过 4096 字节或路径不安全（如符号链接/多硬链接），立即失败关闭（两项钩子均为 `false`，`source: "blocked"`）。
  - **独立插件重复可见性边界（`DUPLICATE_OBSERVABILITY_UNKNOWN`）**：本地服务无法直接观测宿主是否同时加载了独立部署的 `plugins/claude-advisor`（`duplicateObservation: "unknown"`；未报告重复**不等于**不存在重复），因此在面板开启 `Claude guard` 前必须勾选单次风险与重复核对确认（`confirmEnable: true`）。
- **旧 `dotfiles/opencode` OMO 写入链保持退役**：
  - `dotfiles/opencode/runtime/profile.json`（`ownership.status: "retired"`, `historicalInputsOnly: true`）与 `dotfiles/opencode/runtime/lib/{ownership,activate,writer-role-update}.mjs` 的代码层硬围栏保持不变：凡触及 `oh-my-opencode-slim.json(c)` 或 `oh-my-opencode-slim/**`，`oprofile plan-activation`、`activate`（含 `--replace`）、`adopt`、`rollback` 及 `update-writer-role.mjs` 均在写入前整条工作流拒绝。
- **三项通用协作技能 (`contributes.skills: "skills"`) 与唯一冻结 `document-writer` 上游载荷 (`openchamber/plugin/roles/`)**：
  - 原样提供 `skills/maintaining-product-engineering-docs`、`skills/domain-modeling` 与 `skills/humanizer`；`openchamber/plugin/roles/{document-writer.md,routing.json,audience.md,oracle-line.txt}` 保持冻结 SHA-256 不变。
- **`4.0.0`–`5.0.0` 历史移除边界**：
  - `5.0.0` 已移除 `plugins/supervisor/`、`bin/supervisor-memory.mjs` 及 `docs/supervisor-*`；`4.0.0` 已移除 `3.x` CLI 安装器（`coworkers-install` / `dw-install`、`installer/`、根目录 `oh-my-opencode-slim.json` 覆盖层与 `prompts/`）。扩展安装或升级不会自动删除外部记忆目录或历史遗留文件。

## 仓库结构 (`v6.1.0` Layout)

```text
package.json               根级 OpenChamber 2.8.0+ 扩展清单 (v6.1.0; panel/service/skills/opencodePlugin)
openchamber/
  panel/
    index.html             OMO 配置管理器入口页面 (中文 UI：配置 / 增强模板 / 扩展内容 / 变更记录)
    panel.css              面板响应式样式表
    app.js                 受保护结构快照编辑、提示词显式揭露、模板组合、行为设置与撤销/恢复交互逻辑
    model.js               API v2 有限路由白名单、63,000 字节上限、1–32 项安全差量校验与预览时效判断
    vendor/                本地 vendored @openchamber/sdk 2.8.0 浏览器 host.js 最小导入闭包及 MIT 许可说明
  service/
    main.mjs               宿主本地 loopback HTTP 服务 (API v2、Bearer 鉴权、63,000 字节上限、有限路由)
    behavior-settings.mjs  独立 CAS 行为设置更新器 (.omo-coworkers/behavior.json 与专用 behavior.lock)
  native-config/
    manager.mjs            ConfigManager：安全路径/内部链接核查、字段分类投影、提示词揭露、差量变基、条件撤销与配方事务
    recipe-state.mjs       format 3 状态、预览、提交、撤销、迁移与恢复
    recipe-intents.mjs     模板与用户配方差量编译
    templates.mjs          5 族独立内置增强模板 (listTemplates / composeTemplate) 与按需前置依赖提示
    manifest.json          内置提示词来源清单与 SHA-256 校验值 (7 份提示词)
    fragments/leaves.json  内置角色与 ACP 指导文本叶节点定义 (10 个叶节点)
    prompts/               6 份迁入的提示词源文件 (*_append.md 与 lark-operator.md；document-writer.md 复用 ../plugin/roles/)
    generator.mjs          JSONC AST 解析与无格式化局部编辑、旧版兼容编译器与错误定义
    transaction.mjs        NativeStore 底层安全路径/私有祖先权限核查、排他锁、原子写等复用底层原语
    schema/                本地拷贝的官方 oh-my-opencode-slim 3.0.8 schema 与来源校验记录 (PROVENANCE.md)
    vendor/jsonc-parser/   本地 vendored Microsoft jsonc-parser 3.3.1 UMD 实现与 MIT 许可 (零外部 npm 依赖)
  plugin/
    package.json           嵌套 ESM 插件清单 (omo-coworkers-openchamber-plugin v6.1.0)
    index.mjs              OpenChamber V2 插件入口 (通过 readBehaviorSettings 读取默认关闭的行为设置及旧版环境变量回退)
    behavior-settings.mjs  零依赖安全行为设置读取器 (默认关闭、文件优先于旧环境变量、异常失败关闭)
    writer-role.mjs        旧版可选运行时 ctx.agent.transform 加载器与 SHA-256 校验器
    roles/                 4 份冻结上游 document-writer 语义载荷 (document-writer.md, routing.json, audience.md, oracle-line.txt)
skills/                    3 项通用技能目录：maintaining-product-engineering-docs, domain-modeling, humanizer
plugins/
  claude-advisor/          无状态 Claude 派发守卫 (guard.mjs, index.js, index.v1.mjs, guard.test.mjs, README.md)
test/
  native-config-manager.test.mjs      配置管理器受保护投影、揭露、差量变基/冲突、配方、撤销与故障注入测试
  native-templates.test.mjs           5 族独立内置模板组合、前置依赖、个人值保留与来源保真测试
  native-behavior.test.mjs            行为设置默认关闭、优先级、CAS 锁冲突、失败关闭与插件冷加载测试
  native-config-service.test.mjs      本地服务 API v2 鉴权、路由白名单、请求体上限与恢复门控测试
  native-config-generator.test.mjs    底层 JSONC AST 编辑与旧版生成器兼容测试
  native-config-transaction.test.mjs  底层事务存储、权限边界与旧版恢复兼容测试
  native-config-parity.test.mjs       隔离子进程调用真实安装的 OMO 3.0.8 加载器验证 schema 与提示词读取一致性
  native-panel.test.mjs               面板 API v2 路由、受保护占位拦截、草稿/预览门控与静态安全检查
  openchamber-package.test.mjs        发布白名单搬迁、零 node_modules、OpenChamber 2.8.0 真解析器及插件加载测试
  writer-role.test.mjs                旧版可选 writer-role 运行时转换单元测试
README.md / INSTALL.md / SOURCES.md / LICENSE
```

## 环境要求、交付阶段与安全边界 (Requirements, Delivery Stages & Boundaries)

- **严格区分各交付阶段（源码修改 ≠ Git 提交 ≠ 扩展安装/更新 ≠ 本地服务授权 ≠ 面板保存/行为设置更新 ≠ 宿主手动重载 ≠ 运行时核验）**：
  - 修改或提交本仓库不会自动更新已安装的 OpenChamber 扩展，也不会自动改写 `~/.config/opencode`。
  - 在 OpenChamber 中安装或更新本扩展会将扩展文件部署至 OpenChamber 的扩展目录，但**对 `~/.config/opencode` 下的受管原生 OMO 配置（`oh-my-opencode-slim.json(c)`、`oh-my-opencode-slim/**` 及 `.omo-coworkers/**`）不做任何自动写入**；宿主启动、服务启动、自动读取快照（`GET /snapshot`）或生成差异预览（`POST /preview`、`POST /template-preview`）在文件系统上均只读。
  - 面板声明了随包插件与技能贡献，**不等于**运行中宿主已加载该行为，也**不等于** `Claude guard` 已启用（`Claude guard` 默认关闭，且修改 `.omo-coworkers/behavior.json` 后需通过宿主 UI 手动重载 OpenCode 才会在新会话生效）。
- **宿主本地服务权限与默认候选配置根边界（`runtime: "host"` 并非沙箱）**：
  - `contributes.service`（`openchamber/service/main.mjs`）由宿主 Node 直接在本地回环端口拉起，拥有当前操作系统用户的**完整宿主 Node 权限，不是操作系统文件沙箱**；用户必须在 OpenChamber `设置 → 扩展`（`Settings → Extensions`）中单独批准本地服务权限。
  - 宿主仅向扩展服务传递 `HOME`、`XDG_CONFIG_HOME`、`PATH` 等基础环境变量白名单，扩展服务**无法观测**宿主或托管 OpenCode 子进程的实际 `OPENCODE_CONFIG_DIR`、`OPENCODE_CONFIG`、`OH_MY_OPENCODE_SLIM_PRESET`、项目级 `.opencode/oh-my-opencode-slim*` 覆盖或外部服务器状态，也**无权自动重启** OpenCode。因此 P0 仅管理本机默认候选目录（`$XDG_CONFIG_HOME/opencode` 或 `~/.config/opencode`，不支持自定义配置根）；快照含 `CUSTOM_ROOT_UNAVAILABLE` 与 `RUNTIME_UNCONFIRMED` 提示，面板以范围说明呈现。磁盘已保存状态（`saved-pending-reload`）不代表运行中实例已确认生效（`runtimeVerified: false`）。
- **路径安全、非整份配置备份与卸载留存边界**：
  - 管理器支持私有同 UID 祖先目录（`0700`）保护下的常规文件权限（如 `0775`/`0664`）及指向配置根内部的符号链接（解析并校验目标仍在根内，保留逻辑链接且不执行 `chmod`），但**拒绝指向配置根外部的符号链接、共享可写非私有祖先目录或多硬链接文件（`UNSAFE_PATH`）**。
  - `<configRoot>/.omo-coworkers/manager-state.json` 保存用户配方、最近十次撤销与 pending；`behavior.json` 独立保存行为设置。旧状态文件保留但不再作为新状态权威；这些文件不是完整个人配置备份。
  - 单文件写入通过同目录临时文件 + `fsync` + `rename` 原子替换，但**跨多个文件的写入不是原子事务**（可经 `POST /recover` 按日志有条件恢复）。卸载或禁用扩展**不会删除或回滚** `<configRoot>` 中已保存的原生配置文件或 `<configRoot>/.omo-coworkers/` 目录。

详细安装、从 `dotfiles/opencode` 或 `v6.0.0` 升级、配置管理器日常操作（普通字段编辑、提示词显式揭露、5 族内置模板与我的模板、行为设置、条件撤销与中断恢复）、故障排查与运行时核验步骤见 [INSTALL.md](INSTALL.md)；当前 `v6.1.0` 模块来源、冻结载荷哈希及 `1.x`–`6.0.0` 历史溯源记录见 [SOURCES.md](SOURCES.md)。
