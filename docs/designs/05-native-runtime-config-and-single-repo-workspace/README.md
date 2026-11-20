# 05 - 运行时原生配置与单仓库工作区

| 元数据       | 内容                                                                                               |
| :----------- | :------------------------------------------------------------------------------------------------- |
| **文档 ID**  | `05-native-runtime-config-and-single-repo-workspace`                                               |
| **状态**     | `Draft`                                                                                            |
| **创建日期** | 2026-11-19                                                                                         |
| **目标模块** | `src/runtime/`、`src/workspace/`、`src/project/`、`src/domain/`、`src/config/`、`projects/`、`web/` |
| **取代**     | 设计 02 第 7 节、设计 03 的 3.2～3.4 和 3.6～3.7、设计 04 第 4.4、4.5、5 节中关于配置的部分                    |

---

## 1. 背景与动机

现在有三个运行时（Codex、Pi、Claude），配置分散在三个地方：

- 服务 YAML 的 `runtimes.<type>`；
- 项目 YAML 的 `runtime:` 或旧名 `agent:`；
- 代码构造出来的全局项目。

每个运行时都自己合并这三层，结果出了下面这些问题：

1. **项目的 `runtime:` 是所有运行时字段的大杂烩**。有 `type`、`model`，也有 Codex 专属的 `sandbox`、`codexHome`、`config`、`baseConfigPath`，还有靠 `.passthrough()` 塞进来的 Pi `providers` 和 Claude `permissionMode`。写错字段名或者换了 `type`，多出来的字段会被静默忽略。
2. **同一个设置在两层里的名字和合并规则都不同**。默认模型在 Codex 里是透传的 `model`，Pi 叫 `defaultModel`，Claude 叫 `model`。服务级 MCP 有三个来源，其中 Pi 读的是全局项目的 `runtime.mcpServers`，而全局项目根本没有这个字段，所以 Pi 永远拿不到服务级 MCP。
3. **看起来通用的字段其实是 Codex 的语义**。`approvalPolicy` 和 `sandbox` 的取值来自 Codex，Claude 只能硬映射过去，Pi 则直接忽略。
4. **编排器在替运行时管理配置**：生成 Codex 的 `config.toml` 和 `auth.json`、注册 Pi 的 provider、给 Claude 注入凭据并隔离配置目录。运行时每加一个功能，编排器都要跟着改；用户也没法用各 CLI 自己的登录流程，比如 Claude 订阅账号。
5. **多仓库的支持只做了一半**。一个项目可以有多个仓库，但会话只能在其中一个里工作（用 `repositoryId` 指定），每个会话却会把所有仓库的 worktree 都建一遍。运行时也只知道一个路径，所以“一个会话同时改多个仓库”从来没真正支持过。
6. **有死代码**：`PromptManager` 和 `system.md`、`rules.md`、`fix.md`、`analyze.md` 只在测试里用到，从来没有传给过任何运行时；字段 `cwdRoot` 也没有任何地方使用。

参考业界做法（Vibe Kanban、Claude Squad、Codex 云端环境、Copilot coding agent、Agent Skills 标准），共同点是：

- agent 的配置是全局的，项目只选用哪个 agent；
- 指令和 skills 放在仓库里，用跨工具的标准（`AGENTS.md`、`SKILL.md`）；
- 每个任务一个 worktree，原仓库不动。

## 2. 目标与非目标

### 目标

- **运行时读取自己的标准全局配置**（`~/.codex`、`~/.claude`、`~/.pi/agent`），编排器不再生成或翻译任何运行时配置。
- **项目级只保留四个字段**：`type`、`model`、`reasoningEffort`、`mcpServers`。它们在会话启动时通过运行时 API 传入，不写配置文件。
- **一个项目只对应一个仓库**。会话的工作目录就是这个仓库的 worktree，仓库自带的 `AGENTS.md`、skills 和原生配置都由运行时原生加载。
- **项目 skills（以及从全局项目继承的 skills）按会话通过运行时 API 注入**，不往仓库或运行时的配置目录里写文件。
- **全局只读项目改用代码里的 `readOnly` 标志**，不再依赖 Codex 风格的 `sandbox` 配置。
- 删除第 1 节列出的死代码和多仓库逻辑，不保留兼容层。

### 非目标

- 一个会话同时修改多个仓库。真有需要时，在第 7 节的“工作区根目录”方案上扩展；单仓库是它的特例，本设计不会挡路。
- 项目级的常驻指令（`projects/<id>/AGENTS.md` 注入系统提示词）。只在仓库不归自己管的时候才需要，见 4.5，这次先不实现。
- 环境准备脚本（setup 脚本、拷贝 `.env`）。现有的 `scripts/init.sh` / `scripts/sync.sh` 保持不变，环境准备另立设计。
- 安全相关的默认值（无鉴权、权限全开等），仍按设计 03 的约定延后处理。

## 3. 职责划分

| 归属 | 内容 | 放在哪 |
| :--- | :--- | :--- |
| **运行时的运行环境** | 登录和凭据、模型 provider、默认模型、权限和沙箱、全局 MCP、全局 skills、hooks | `~/.codex`、`~/.claude`、`~/.pi/agent`，或用环境变量 `CODEX_HOME` / `CLAUDE_CONFIG_DIR` / `PI_CODING_AGENT_DIR` 指定的目录 |
| **仓库** | 构建和测试说明、常驻规则、仓库专属的 skills 和原生配置 | 仓库里的 `AGENTS.md` / `CLAUDE.md`、`.agents/skills`、`.claude/skills` 等 |
| **项目（编排器）** | 用哪个运行时，以及模型、推理强度、额外的 MCP；按需使用的流程文档（skills）；仓库地址、路由、任务、通知 | `projects/<id>/project.yaml`、`projects/<id>/.skills/` |
| **编排器代码** | 工作目录、action 桥接、审批路由、只读模式、会话持久化 | 代码，不可配置 |

原则：**编排器只传它必须决定的东西，其它都交给运行时和仓库的原生机制**。

## 4. 详细设计

### 4.1 运行时读取全局配置

三个运行时的共同改动：

- **不再设置配置目录**：去掉 Codex 的 `CODEX_HOME=<dataDir>/codex/<project>`、Pi 的 `agentDir`、Claude 的 `CLAUDE_CONFIG_DIR`。运行时按自己的规则找配置：默认在 `$HOME` 下，或者用部署环境里设好的标准环境变量。
- **环境变量直接继承服务进程的**。Codex 不再删除 `CODEX_*` / `OPENAI_*` 变量，Claude 也不再用白名单。这样标准的配置目录变量、认证变量（如 `ANTHROPIC_API_KEY`）和 `IS_SANDBOX` 都能传过去。代价是 agent 能看到服务进程的全部环境变量，这一点归入设计 03 延后处理的安全条目。
- **不再传权限和沙箱的默认值**。原来 Codex 在 `thread/start` 里硬传 `approvalPolicy: never` 和 `sandbox: danger-full-access`，Claude 映射出 `permissionMode`。改为完全听全局配置的；审批桥接（`approval.requested` → 网关 → `respondToApproval`）不变。

各运行时的具体改动：

| | 删除 | 保留或新增 |
| :--- | :--- | :--- |
| Codex | `codex/home.ts`（生成 `config.toml` 和 `auth.json`、4 层合并）；服务级 `runtimes.codex` 的 schema 和透传 | app-server 进程不变；`thread/start` 传 `model`、MCP（见 4.3）；skills 用 `skills/extraRoots/set`（见 4.5） |
| Pi | `runtimes.pi` 的 schema；`SettingsManager.inMemory` 和禁用用户扩展的设置；provider 注册；`agentDir` 拼接 | 改用 `SettingsManager.create(cwd)` 和 `ModelRuntime.create()`，读全局和 Pi 自己的项目级设置；模型按 4.3 解析 |
| Claude | 凭据字段、`buildEnv` 白名单、`configDir`、`settingSources` 配置、`approvalPolicy` 映射、`sandboxed` 开关和 root 预检 | `settingSources` 使用 SDK 默认值（全部加载）；`canUseTool` 审批桥接；编排器 action 免审批 |

以 root 运行时 Claude 拒绝跳过权限检查，这个问题交给部署环境处理：在容器里设置 `IS_SANDBOX=1`（见第 5 节）。

### 4.2 服务配置

`runtimes:` 整段删除。新增一个顶层字段：

```yaml
defaultRuntime: codex   # 没写 runtime.type 的项目和全局只读项目都用它
```

全局项目原来取“第一个项目”的运行时类型（`src/project/manager.ts:43`），改为使用 `defaultRuntime`。

### 4.3 项目配置

```yaml
project: { id, displayName, description, tags, enabled }
routing: { projectId, summary, keywords, routingHints }
repository:                    # 单数：一个项目一个仓库；没有它就是共享工作区
  url: git@github.com:example/shortlink.git
  baseBranch: main
  auth: { type: token, token: "{env:GITHUB_TOKEN}" }
  committer: { name, email }
runtime:                       # 整段可选
  type: codex                  # 不写就用 defaultRuntime
  model: deepseek-v4-pro       # 交给运行时解释；不写就用全局配置里的默认模型
  reasoningEffort: high        # low | medium | high | xhigh | max，运行时不支持的档位忽略
  mcpServers: [...]            # 叠加在全局配置之上
session:                       # 原来 runtime 里的会话生命周期字段挪到这里
  idleTimeoutMs: 1800000
  archiveTimeoutMs: 3600000
env: {...}
notifications: [...]
```

`runtime` 用 `z.strictObject` 校验，写错字段名在加载时就报错。

**删除的字段**：`runtime.approvalPolicy`、`sandbox`、`codexHome`、`cwdRoot`、`config`、`baseConfigPath`、`providers`、`provider`、`permissionMode`、`settingSources`；顶层的 `agent`（以及 `foldAgentIntoRuntime`）、`repositories`、`prompts`、`promptsDir`。

**四个字段如何传给运行时**（都在会话启动时通过 API 传入，不写文件）：

| 字段 | Codex | Claude | Pi |
| :--- | :--- | :--- | :--- |
| `model` | `thread/start.model` | `options.model` | `provider/model` 或模型 id，在全局 `models.json` 里查找；找不到就报错 |
| `reasoningEffort` | `turn/start.effort` | `options.effort` | `thinkingLevel` |
| `mcpServers` | `thread/start.config` 里的 `mcp_servers` 覆盖项（待验证，见第 6 节） | `options.mcpServers`，和用户配置里的 MCP 合并 | 现有的 MCP 扩展 |

`McpServerConfig` 到各运行时格式的转换代码已经存在，保留。

### 4.4 单仓库工作区

目录结构：

```
<dataDir>/bases/<project>/              ← base 仓库（原来是 bases/<project>/<repo>）
<dataDir>/sessions/<project>/<session>/ ← 会话的 worktree，也就是 agent 的工作目录
```

`WorkspaceManager` 的改动：

- 删除 `repoPaths`、主仓库选择、按会话为每个仓库建 worktree 的循环。`resolveSessionWorkspace` 直接返回一个路径。
- 没有 `repository` 的项目和全局项目继续用共享工作区（`usesSharedWorkspace`），逻辑不变。
- `scripts/init.sh` / `scripts/sync.sh` 不变。

会话里删除 `repositoryId`，涉及这些地方：

- `SessionRoute`、`createSession`、会话 API（`POST /sessions` 的 `repositoryId` 参数）；
- `dispatch_agent_task` 的 `repository_id` 参数；
- 数据库 `sessions.repository_id` 列（迁移见 6.3）；
- web 界面（`SessionBoard.tsx`、`Sidebar.tsx`、`ProjectInfoView.tsx` 里按仓库展示和选择的部分）；
- 路由：`project-router.ts` / `chain.ts` 里按仓库名匹配的部分，改为只按项目和关键词匹配。

已有会话的 `workspacePath` 是存进数据库的（设计 03），所以旧会话还能按原路径找到自己的 worktree，不需要搬目录。

### 4.5 Skills 与指令

**仓库自带的**：不需要任何处理。工作目录就是仓库，三家都会原生加载（已实测）：

| | 加载的目录 |
| :--- | :--- |
| Codex | `.agents/skills`、`.codex/skills`；指令文件 `AGENTS.md` |
| Pi | `.agents/skills`、`.pi/skills`；指令文件 `AGENTS.md` |
| Claude | `.claude/skills`；指令文件 `CLAUDE.md` |

想三家通用的仓库，可以放 `.agents/skills`，再加软链接 `.claude/skills -> ../.agents/skills`；`CLAUDE.md` 同理。这是仓库自己的约定。

**项目 skills**：来源是全局项目的 `projects/.skills/` 和项目自己的 `projects/<id>/.skills/`，按会话注入（都已实测可用）：

| | 方式 |
| :--- | :--- |
| Codex | `skills/extraRoots/set`，传两个目录。一个 app-server 进程只服务一个项目，路径是项目级的，不随会话变 |
| Pi | `DefaultResourceLoader` 的 `additionalSkillPaths` |
| Claude | 本地插件 `options.plugins`：在 `<dataDir>/claude-plugins/<project>/{global,project}/` 下生成两个插件目录，各含一个 `.claude-plugin/plugin.json` 和一个指向对应 `.skills` 的 `skills` 软链接。插件里的 skill 会带插件名前缀 |

`SkillManager.linkSkills` 和往运行时配置目录里建链接的逻辑全部删除。

**重名**：三家的处理不一致（Pi 保留先加载的那个，Codex 两个都列出，Claude 靠插件前缀区分）。约定项目 skills 不和仓库 skills 重名。编排器不做合并，也不做检查。

**按需使用的流程文档**（原来的 `fix.md`、`analyze.md` 这类）：统一做成项目 skills，放到 `.skills/<name>/SKILL.md`，头部写 `name` 和 `description`。运行时会把 skill 列表交给模型；用户也可以点名使用（说“用 fix 这个 skill”，或者用各家的调用语法：Claude 的 `/fix`、Codex 的 `$fix`、Pi 的 `/skill:fix`）。

**常驻规则**：写进仓库的 `AGENTS.md`。仓库不归自己管、没法提交时，可以以后再加 `projects/<id>/AGENTS.md`，按会话追加到系统提示词（Codex 用 `developerInstructions`，Claude 用 `systemPrompt.append`）。这次不实现。

**删除**：`PromptManager`、`tests/prompts.test.ts`、`projects/example/` 下的 `system.md` 和 `rules.md`。`fix.md` 和 `analyze.md` 转成 `projects/example/.skills/` 下的示例 skill。

全局只读项目的 `projects/AGENTS.md` 保持不变：它的工作目录就是 `projects/`，本来就是原生加载的。

### 4.6 全局只读项目

`RuntimeContext` 新增 `readOnly?: boolean`，由 `ProjectRuntime` 根据项目是否为全局项目来设置。各运行时的实现：

| | 实现 |
| :--- | :--- |
| Codex | `thread/start.sandbox: "read-only"` |
| Claude | `options.tools` 只给 `Read`、`Grep`、`Glob` |
| Pi | `tools` 只给 `read`、`grep`、`find`、`ls` |

`createGlobalProjectConfig` 不再写 `sandbox` / `approvalPolicy`，运行时类型取 `defaultRuntime`。

### 4.7 行为变化

| 变化 | 影响 |
| :--- | :--- |
| Codex 的权限默认值不再由编排器设置 | Codex 的默认行为是按需审批，审批请求会出现在界面上。想保持原来的“全部放行”，在 `~/.codex/config.toml` 里设置 `approval_policy` 和 `sandbox_mode` |
| 会话记录改到全局配置目录 | 原来存在 `<dataDir>/{codex,pi,claude}/<project>` 下的会话恢复不到，会走 `session.runtime_reset`：界面提示，然后开新会话，上下文丢一次 |
| 用户的 hooks、插件、Pi 扩展会生效 | 这是读取全局配置的直接结果。服务最好在专用的配置目录下运行（容器里的独立卷），不要和个人日常用的 CLI 共用 |
| 服务级 MCP 改在各运行时的全局配置里配置 | 不同运行时要分别配置 |

## 5. 部署与配置说明

### 服务 YAML

只多一个 `defaultRuntime`，删除整个 `runtimes:` 段。`config.example.yaml` 删掉对应的示例，换成一句说明，指向部署文档。

### 容器（`dev-orchestrator`）

1. **持久化配置目录**：给 `/root/.codex`、`/root/.claude`、`/root/.pi` 挂卷。也可以设置 `CODEX_HOME` / `CLAUDE_CONFIG_DIR` / `PI_CODING_AGENT_DIR` 指向卷里的目录。
2. **设置 `IS_SANDBOX=1`**：容器以 root 运行，不设的话，Claude 在跳过权限检查的模式下无法启动。
3. **进容器各登录一次**：
   - `docker exec -it dev-orchestrator codex login`（无浏览器时用 device auth），或者在 `config.toml` 里配 API key 方式的 provider；
   - `docker exec -it dev-orchestrator claude`，然后执行 `/login`；
   - Pi：用 `/login` 登录，或者在 `models.json` / `auth.json` 里配置 provider。
4. **把现在 `config.yaml` 里 `runtimes.codex` 的内容搬到 `~/.codex/config.toml`**：`model_provider`、`model_providers.cliproxyapi`，以及想要的 `approval_policy` / `sandbox_mode`。`runtimes.pi` 的 provider 搬到 `~/.pi/agent/models.json`。

这些步骤写进 `docs/references/runtime-setup.md`。

### 现有项目文件的迁移

| 文件 | 改动 |
| :--- | :--- |
| `projects/*/project.yaml` | `agent:` 改为 `runtime:`；`repositories: [x]` 改为 `repository: x`，去掉 `id` 和 `isPrimary`；`committer` / `auth` 合并进 `repository`；`routing.repositories` 删除 |
| `projects/agent-orchestrator/tasks/issue-lifecycle.md`、`pr-lifecycle.md`、`projects/conversational-agent/tasks/jira-triage.md` | 删除里面写死的 `repositoryId` / `repository_id` |
| `projects/example/` | `system.md`、`rules.md` 删除；`fix.md`、`analyze.md` 转成 `.skills/` |

## 6. 实施阶段与测试

### 6.1 第一阶段：验证（不提交业务代码）

用临时目录写最小脚本验证下面几项，结论写回本文档对应的小节：

1. Codex：`thread/start` 的 `config` 覆盖项能不能追加 `mcp_servers`，追加时是和全局配置合并还是整体替换；`model` 在 thread 级、`effort` 在 turn 级能不能生效。
2. Claude：`settingSources` 用默认值时，`options.mcpServers` 会不会和用户配置里的 MCP 合并；本地插件里的 skills 能不能加载。
3. Pi：`SettingsManager.create(cwd)` 加 `ModelRuntime.create()` 能否读到 `~/.pi/agent` 的设置和 `models.json`，以及 `provider/model` 格式的解析。
4. 三家的只读模式（4.6）能否真正阻止写文件和执行命令。
5. 容器里三家的登录流程能否走通（device auth 等）。

结论见 6.5。

### 6.2 第二阶段：实现

建议按下面的顺序提交，每一步都能单独通过测试：

1. `refactor: remove unused project prompts`：删除 `PromptManager` 及测试，把 example 项目的 md 转成 skills。
2. `refactor: support a single repository per project`：project schema 改用 `repository`；改 `WorkspaceManager`；删除 `repositoryId` 在会话、API、dispatch、路由、web 里的使用；加数据库迁移；改写项目文件和任务文件。
3. `refactor: move session lifecycle settings out of runtime config`：新增 `session` 段。
4. `feat: add a read-only runtime mode for the global project`：`RuntimeContext.readOnly` 和三个运行时的实现；`defaultRuntime`。
5. `refactor: let runtimes read their own global configuration`：三个运行时改用全局配置；项目 `runtime` 收窄为四个字段并严格校验；删除服务级 `runtimes`；项目 skills 改为按会话注入；删除 `linkSkills` 和 `codex/home.ts`。
6. `docs: document runtime setup`：部署文档、`config.example.yaml`；本文档改为 `Accepted`，在设计 02、03、04 里注明被取代的部分。

### 6.3 数据库迁移

`database/migrations/20261119_01_drop_session_repository.sql` 删除 `sessions.repository_id` 列，`database/schema.sql` 同步修改。

### 6.4 测试

- **项目 schema**：`runtime` 只接受四个字段，写错字段名会报错；`repository` 是单数；`agent`、`repositories`、`prompts` 都会被拒绝。
- **工作区**：单仓库项目的 worktree 路径和共享工作区；已有会话按存储的 `workspacePath` 找到原 worktree。
- **各运行时的选项构造**：
  - `model`、`reasoningEffort`、`mcpServers` 是否正确传入；
  - 不再出现配置目录变量和权限默认值；
  - 只读模式下的工具和沙箱设置；
  - 项目 skills 的路径（Codex 的 `extraRoots`、Pi 的 `additionalSkillPaths`、Claude 的插件目录）。
- **全局项目**：使用 `defaultRuntime`，并带上 `readOnly`。
- 最后跑 `bun run check`、`bun run build`、`cd web && bun run build`。再用真实 CLI 做一次端到端冒烟测试，覆盖三个运行时的一轮对话、项目 skill 是否可见、只读模式。

### 6.5 实施结果

**第一阶段验证结论**（都用真实的 CLI 测过）：

| 问题 | 结论 |
| :--- | :--- |
| Codex 的 `thread/start` / `thread/resume` 用 `config` 追加 `mcp_servers` | 和全局配置**合并**（全局的和项目的都在）；`model` 在 thread 级、`effort` 在 turn 级都生效；`sandbox: "read-only"` 生效 |
| Claude 用默认 `settingSources` 时 `options.mcpServers` 的行为 | 和用户配置里的 MCP **合并**；本地插件里的 skills 以 `<插件名>:<skill>` 加载 |
| Pi 的 `SettingsManager.create(cwd)` 和 `ModelRuntime.create()` | 读取 `PI_CODING_AGENT_DIR`（默认 `~/.pi/agent`）里的设置和 `models.json`；`provider/model` 能正确解析 |
| 三家的只读模式 | Codex 的沙箱是 `readOnly`；Claude 只剩 `Read`、`Grep`、`Glob`；Pi 只剩 `read`、`grep`、`find`、`ls` |
| 容器里的登录流程 | 没有在容器里跑（需要交互），步骤写在 `docs/references/runtime-setup.md` |

最后用真实的 CLI 做了一次端到端测试：每个运行时都读一个只放了登录文件副本的临时配置目录，项目带一个 skill。三家都完成了一轮对话，并且都通过项目 skill 答出了正确结果。

**提交**：

1. `refactor: remove unused project prompts`
2. `refactor: support a single repository per project`
3. `refactor: move session lifecycle settings out of runtime config`
4. `feat: add a read-only runtime mode for the global project`
5. `refactor: let runtimes read their own global configuration`
6. `docs: document runtime setup`

**和原计划不一样的地方**：

- **`repository.path`**：原来编排器会隐式查找 `projects/<id>/repos/<repoId>`，还会把本地路径的 `url` 直接当作 base 仓库。现在改成显式的 `path` 字段。现有项目的 `init.sh` 都克隆到 `repos/<id>`，迁移时加上 `path: repos/<id>`，本地仓库不需要移动。
- **项目 schema 改为严格校验**（`z.strictObject`），被删掉的字段（`repositories`、`agent`、`committer`、`prompts`、`approvalPolicy` 等）在加载时直接报错，不会被静默忽略。顺带删掉了 `meta` / `metadata` / `info` 这几个没人用的别名，以及示例里早已失效的 `triggers`。
- **旧布局的会话**：在这次改动之前创建的会话没有存 `workspace_path`，worktree 在 `<session>/<repoId>/` 下面。`WorkspaceManager.sessionPath` 会往下找一层，以后可以删掉这段兼容。
- **路由**：`chain.ts` 和 `project-router.ts` 里重复的关键词打分合并成 `scoreProjectKeywords`；`routing.repositories` 删除，原来的值并进 `keywords`。
- **Claude 的 skills 插件**：插件目录是 `<dataDir>/claude-plugins/<project>/{global,<projectId>}`，skill 名带前缀 `global:` 或 `<projectId>:`。
- **Pi 的工具**：平时不传 `tools`（Pi 按自己的设置启用默认工具，加上编排器 action），只读时才传允许列表。
- **只读模式的限制**：只读只限制运行时的内置工具。用户在运行时全局配置里配置的 MCP 工具仍然可用。全局项目一般不需要 MCP，所以不额外处理。
- **项目 skills 的覆盖**：原来同 id 的 skill 由项目覆盖全局，是在建软链接时处理的。现在交给各运行时自己处理重名，约定上不要重名。

## 7. 备选方案与取舍

**在服务级定义命名的运行环境（profile），项目引用名字**：放弃。

- 好处：配置集中在 `config.yaml`，同一个运行时可以有多套配置。
- 缺点：编排器仍然要解析 profile、把原生配置写到磁盘上；也用不了各 CLI 自己的登录流程。
- 你现在所有项目都走同一个 Codex 代理，换模型只需要换模型名，用不到多套配置。

**工作区根目录（不是 git 仓库）下放多个仓库，生成仓库地图和汇总 skills**：暂不采用。

- 它是支持“一个会话同时改多个仓库”的正确方向。
- 但要多处理不少问题：生成 `AGENTS.md`、汇总 skills 并处理重名、执行 skill 时的目录切换、仓库自带的指令和配置不再被原生加载。
- 目前没有多仓库的项目。以后需要时，单仓库正好是它的特例。

**编排器保留一套通用字段（`approvalPolicy`、`sandbox` 等），每个运行时各自映射**：放弃。这正是第 1 节问题的来源。

**放一个 md 目录，让用户自己告诉 agent 去读**：放弃。

- agent 不知道这些文件存在，用户每次都要说出路径；文件在仓库外面，还可能触发审批。
- skills 已经提供了“列出可用文档、按需加载、可以点名使用”的能力。

**通过 ACP（Agent Client Protocol）统一驱动各运行时**：暂不采用。它是为编辑器场景设计的，审批、steer、压缩这些语义不一定对得上，适配器也是社区在维护。等自己写的适配器维护负担变大时再评估。
