# omo-coworkers

**面向 OpenChamber 2.8.0+ 的扩展包（`v6.0.0`）：内置 OMO（`oh-my-opencode-slim`）原生配置显式预览/应用/恢复/条件回滚面板与本地宿主服务（接管原 `dotfiles/opencode` 的 7 份提示词与 10 个精选文本配置叶节点，不依赖 `dotfiles` 安装器）、三项通用协作技能、唯一冻结的 `document-writer` 上游角色载荷，以及两项默认关闭且相互独立的运行时钩子（旧版 `OMO_COWORKERS_ENABLE_WRITER_ROLE=1` 原生转换与 `OMO_COWORKERS_ENABLE_CLAUDE_GUARD=1` Claude 派发守卫）。**

*OpenChamber 2.8.0+ extension (`v6.0.0`) shipping explicit preview/apply/recover/conditional-rollback delivery for native OMO configuration (retiring the legacy `dotfiles/opencode` OMO write chain while preserving user-owned models, permissions, skills, and ACP transport settings), the three portable coworker skills, the single frozen upstream `document-writer` payload authority, and default-off legacy writer and Claude dispatch guard hooks.*

## `v6.0.0` 交付内容与所有权边界 (What `v6.0.0` ships & ownership split)

`omo-coworkers` 在 `4.0.0` 重构为仓库根级 OpenChamber 扩展（`panel.id: "omo-coworkers"`），在 `5.0.0` 移除旧版 `supervisor` 插件与 CLI，并在 **`6.0.0`** 将原本依赖 `dotfiles/opencode` 离线同步与激活的 OMO 原生定制内容迁入扩展内部，通过受控的本地宿主服务与中文操作面板直接交付：

- **原生 OMO 配置显式预览、应用、中断恢复与条件回滚（`openchamber/native-config/` + `openchamber/service/` + `openchamber/panel/`）**：
  - **接管的受管范围（7 份提示词 + 10 个文本叶节点）**：
    - 7 个提示词文件（清单定义于 `openchamber/native-config/manifest.json`）：`oh-my-opencode-slim/orchestrator_append.md`、`oh-my-opencode-slim/oracle_append.md`、`oh-my-opencode-slim/explorer_append.md`、`oh-my-opencode-slim/designer_append.md`、`oh-my-opencode-slim/fixer_append.md`、`oh-my-opencode-slim/document-writer.md`（直接引用唯一冻结上游源 `openchamber/plugin/roles/document-writer.md`，不维护重复副本）与 `oh-my-opencode-slim/lark-operator.md`。
    - `oh-my-opencode-slim.json` 或 `oh-my-opencode-slim.jsonc` 中的 10 个文本叶节点（定义于 `openchamber/native-config/fragments/leaves.json`）：`agents.document-writer.{description,orchestratorPrompt}`、`agents.lark-operator.{description,orchestratorPrompt}`、`acpAgents.antigravity.{prompt,description,orchestratorPrompt}` 与 `acpAgents.claude.{prompt,description,orchestratorPrompt}`。生成器通过内置 `jsonc-parser`（`3.3.1`）做最小 AST 局部修改，不执行全文件格式化，保留原有的注释、缩进与非受管字段。
  - **严格保留用户自有配置（绝不覆盖个人模型、权限、传输或实时 `ask` 策略）**：
    - 用户的 `model` / `inheritModelFrom`、`permissions`、`skills`、`mcps`、`presets`、ACP 传输命令（`acpAgents.{antigravity,claude}.command`、`args`、`cwd`、`env`）、`opencode.json` 以及宿主环境变量均不受扩展改写。
    - 生成器要求候选配置中 `document-writer` 与 `lark-operator` 已配置 `model` 或 `inheritModelFrom`（否则报 `MISSING_MODEL` 拒绝），且 `acpAgents.antigravity` 与 `acpAgents.claude` 已配置非空 `command`（否则报 `MISSING_TRANSPORT` 拒绝）。
    - 原 `dotfiles/opencode/oh-my-opencode-slim.json` 中的 `acpAgents.antigravity.permissionMode: "reject"` **未**迁入扩展默认值；用户本机实时配置中的 `permissionMode`（如 `"ask"`）原样保留。
    - 用户可在 `<configRoot>/.omo-coworkers/overrides.jsonc` 中按白名单维护本地覆盖（仅限顶层键 `leaves`、`prompts`、`unmanaged`）。
  - **安装、启动与更新零自动写入**：
    - 安装扩展、启动宿主服务、刷新状态或生成预览（`POST /preview`、`POST /rollback-preview`）在文件系统上**完全只读**。
    - 仅当操作者在面板中逐项勾选 **7 项必选环境与秘密声明**、手动填入匹配的 **已验证精确版本矩阵**（`omo: 3.0.8`、`opencode: 2.4.2`、`openchamber: 2.8.0`）、审阅 5 分钟有效期的单次哈希变更摘要（仅含 SHA-256 哈希，不暴露现有个人配置正文）并显式点击「确认应用」或「确认回滚」时，服务才对受管路径执行写入。
    - 若上次写入中途异常中断留下 `.omo-coworkers/journal.json`，状态进入 `recovery-required` 并阻止一切预览与应用；仅能通过面板显式勾选磁盘写入确认并点击「确认恢复中断写入」（`POST /recover`）按日志有条件还原受管项，状态查询与预览绝不隐式触发恢复。
- **旧 `dotfiles/opencode` OMO 写入链正式退役交接**：
  - `dotfiles/opencode/runtime/profile.json` 已将 `oh-my-opencode-slim.json`、`oh-my-opencode-slim.jsonc` 与 `oh-my-opencode-slim/**` 标记为 `ownership.status: "retired"`（`historicalInputsOnly: true`）。
  - `dotfiles/opencode/runtime/lib/{ownership,activate,writer-role-update}.mjs` 已启用代码层硬围栏：凡候选清单、当前 authority 记录、纳管路径集或回滚记录涉及上述已移交路径，`oprofile plan-activation`、`oprofile activate`（含 `--replace`）、`oprofile adopt`、`oprofile rollback` 以及 `update-writer-role.mjs` 均在任何写入或源 Git 读取前整条工作流拒绝（无绕过开关）。`dotfiles/opencode` 中保留的文件与 `oprofile stage` 仅作离线历史暂存（staging）与个人模型/权限/技能参考。
- **三项通用协作技能 (`contributes.skills: "skills"`)**：
  - 原样提供 `skills/maintaining-product-engineering-docs`、`skills/domain-modeling` 与 `skills/humanizer`；不内置任何 `lark-*` 或项目私有技能。
- **唯一冻结的 `document-writer` 上游语义载荷与默认关闭的旧版运行时转换 (`openchamber/plugin/roles/` & `OMO_COWORKERS_ENABLE_WRITER_ROLE=1`)**：
  - `openchamber/plugin/roles/{document-writer.md,routing.json,audience.md,oracle-line.txt}` 保持冻结 SHA-256 不变，其中 `document-writer.md` 同时作为原生配置生成器的唯一引用源。
  - `openchamber/plugin/index.mjs` 中的 `setupWriterRole(ctx)`（`openchamber/plugin/writer-role.mjs`）默认关闭，仅在宿主进程环境显式设置 `process.env.OMO_COWORKERS_ENABLE_WRITER_ROLE === "1"` 时注册运行时 `ctx.agent.transform`。**使用 `v6.0.0` 原生配置交付时，必须保持 `OMO_COWORKERS_ENABLE_WRITER_ROLE` 未设置（关闭）**。
- **默认关闭、相互独立的 Claude 派发守卫 (`OMO_COWORKERS_ENABLE_CLAUDE_GUARD=1`)**：
  - `openchamber/plugin/index.mjs` 仅在宿主进程环境设置 `process.env.OMO_COWORKERS_ENABLE_CLAUDE_GUARD === "1"` 时启用 `plugins/claude-advisor/index.js`；与原生配置服务及 `OMO_COWORKERS_ENABLE_WRITER_ROLE` 完全独立。独立部署入口 `plugins/claude-advisor/index.js`（v2）与 `plugins/claude-advisor/index.v1.mjs`（v1）原样保留。
- **`4.0.0`–`6.0.0` 历史移除边界**：
  - `5.0.0` 已移除 `plugins/supervisor/`、`bin/supervisor-memory.mjs` 及 `docs/supervisor-*`；`4.0.0` 已移除 `3.x` CLI 安装器（`bin/coworkers-install.mjs` / `dw-install`、`installer/`、根目录 `oh-my-opencode-slim.json` 覆盖层与 `prompts/`）。扩展安装或升级不会自动删除外部记忆目录（如 `~/.local/share/opencode-supervisor/memory/`）或 `3.x` 历史遗留文件。

## 仓库结构 (`v6.0.0` Layout)

```text
package.json               根级 OpenChamber 2.8.0+ 扩展清单 (v6.0.0; panel/service/skills/opencodePlugin)
openchamber/
  panel/
    index.html             OMO 原生配置面板入口页面 (中文 UI，无外部脚本或预勾选)
    panel.css              面板样式表
    app.js                 面板状态展示、确认门控、哈希预览、应用/条件回滚/显式恢复交互逻辑
    model.js               版本矩阵 (3.0.8 / 2.4.2 / 2.8.0)、7 项声明校验、有限 SDK 路由与预览时效判断
    vendor/                本地 vendored @openchamber/sdk 2.8.0 浏览器 host.js 最小导入闭包及 MIT 许可说明
  service/
    main.mjs               宿主本地 loopback HTTP 服务 (Bearer 鉴权、16 KiB 上限、7 条有限路由、默认候选根计算)
  native-config/
    manifest.json          v6.0.0 原生配置清单：精确兼容矩阵、7 份提示词输出路径与 SHA-256 校验值
    fragments/leaves.json  oh-my-opencode-slim.json(c) 的 10 个受管文本叶节点定义
    prompts/               6 份迁入的提示词源文件 (*_append.md 与 lark-operator.md；document-writer.md 复用 ../plugin/roles/)
    generator.mjs          纯函数 JSONC AST 校验与最小局部编辑、模型/传输前置检查、遮蔽拒绝、三路受管漂移检测
    transaction.mjs        NativeStore：安全路径/权限/链接核查、单次 5 分钟预览、排他锁、WAL 日志、条件恢复与条件回滚
    schema/                本地拷贝的官方 oh-my-opencode-slim 3.0.8 schema 与来源校验记录 (PROVENANCE.md)
    vendor/jsonc-parser/   本地 vendored Microsoft jsonc-parser 3.3.1 UMD 实现与 MIT 许可 (零外部 npm 依赖)
  plugin/
    package.json           嵌套 ESM 插件清单 (omo-coworkers-openchamber-plugin v6.0.0)
    index.mjs              OpenChamber V2 插件入口 (两项运行时钩子默认关闭，仅受精确进程环境变量 "1" 控制)
    writer-role.mjs        旧版可选运行时 ctx.agent.transform 加载器与 SHA-256 校验器
    roles/                 4 份冻结上游 document-writer 语义载荷 (document-writer.md, routing.json, audience.md, oracle-line.txt)
skills/                    3 项通用技能目录：maintaining-product-engineering-docs, domain-modeling, humanizer
plugins/
  claude-advisor/          无状态 Claude 派发守卫 (guard.mjs, index.js, index.v1.mjs, guard.test.mjs, README.md)
test/
  native-config-generator.test.mjs    原生生成器 AST 编辑、前置条件、覆盖白名单、遮蔽与漂移单元测试
  native-config-transaction.test.mjs  事务存储锁、故障注入、条件恢复、跨升级基线保留与安全路径单元测试
  native-config-service.test.mjs      本地服务鉴权、确认契约、有限路由与显式 /recover 接口测试
  native-config-parity.test.mjs       隔离子进程调用真实安装的 OMO 3.0.8 加载器验证 schema 与 7 份提示词字节一致性
  native-panel.test.mjs               面板确认门控、路由白名单、预览过期与无不安全 DOM/无预勾选静态检查
  openchamber-package.test.mjs        发布白名单搬迁、零 node_modules、OpenChamber 2.8.0 真解析器及 20 组合插件冷加载测试
  writer-role.test.mjs                旧版可选 writer-role 运行时转换单元测试
README.md / INSTALL.md / SOURCES.md / LICENSE
```

## 环境要求、交付阶段与安全边界 (Requirements, Delivery Stages & Boundaries)

- **严格区分各交付阶段（源码修改 ≠ Git 提交 ≠ 扩展安装/更新 ≠ 本地服务授权 ≠ 面板显式写入 ≠ 宿主手动重启 ≠ 运行时核验）**：
  - 修改或提交本仓库不会自动更新已安装的 OpenChamber 扩展，也不会自动改写 `~/.config/opencode`。
  - 在 OpenChamber 中安装或更新本扩展仅部署扩展代码、面板、服务入口与三项通用技能；**扩展安装、宿主启动、服务启动或刷新状态均不写入任何原生 OMO 配置文件**。
  - OpenChamber 仅通过对比远端根 `package.json` 的更高 semver `version` 检测扩展更新（结果缓存 1 小时，需用户在宿主 UI 手动点击应用更新）；扩展更新后，已写入磁盘的原生配置不会自动同步，需再次通过面板预览并确认应用。
- **宿主本地服务权限边界（`runtime: "host"` 并非沙箱）**：
  - `contributes.service`（`openchamber/service/main.mjs`）由宿主 Node 直接在本地回环端口拉起，拥有当前操作系统用户的**完整宿主 Node 权限，不是操作系统文件沙箱**。
  - 用户必须在确认信任后，于 OpenChamber `设置 → 扩展`（`Settings → Extensions`）中单独批准本地服务权限。
  - 宿主仅向扩展服务传递受限环境变量白名单（`HOME`、`XDG_CONFIG_HOME`、`PATH` 等），扩展服务**无法观测**宿主或托管 OpenCode 子进程的实际 `OPENCODE_CONFIG_DIR`、`OPENCODE_CONFIG`、`OMO_COWORKERS_ENABLE_*`、登录 shell 快照、`service.json` 或存储的用户变量，也**无权调用**宿主 `/api/config/reload` 自动重启 OpenCode。因此候选配置根仅支持本机默认路径（`$XDG_CONFIG_HOME/opencode` 或 `~/.config/opencode`），不支持自定义配置根或外部 OpenCode 服务器，且环境无遮蔽与精确版本（`OMO 3.0.8` / `OpenCode 2.4.2` / `OpenChamber 2.8.0`）必须由操作者核实后显式声明。
- **备份范围、非跨文件原子性与卸载留存边界**：
  - `<configRoot>/.omo-coworkers/`（含 `lock`、`journal.json`、`state.json` 及可选的 `overrides.jsonc`）**仅记录受管提示词与受管叶节点变更前后的值**，不是 `oh-my-opencode-slim.json(c)`、`opencode.json` 或整个配置目录的完整个人配置备份。操作者必须在应用前确认即将接管的现有受管值不含密钥或令牌（`managedBeforeValuesContainNoSecrets`）。
  - 单文件写入通过同目录临时文件 + `fsync` + `rename` 原子替换，但**跨多个文件的写入不是原子事务**；中途异常中断会保留 `journal.json` 并进入 `recovery-required` 状态，需通过面板显式执行恢复（`POST /recover`）。
  - 卸载或禁用扩展仅移除扩展包与贡献的技能/插件钩子，**不会删除或回滚** `<configRoot>` 中已写入的原生 OMO 配置文件，也**不会删除** `<configRoot>/.omo-coworkers/` 目录。

详细安装、从 `dotfiles/opencode` 交接、面板预览/应用/条件回滚/中断恢复、故障排查与运行时核验步骤见 [INSTALL.md](INSTALL.md)；当前 `v6.0.0` 载荷哈希、vendored 组件来源及 `1.x`–`5.0.0` 历史溯源记录见 [SOURCES.md](SOURCES.md)。
