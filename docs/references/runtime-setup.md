# 运行时与项目配置

编排器不管理 agent 运行时的配置。Codex、Claude Code 和 Pi 都读取各自的标准配置目录，和直接用它们的 CLI 时完全一样：登录、模型 provider、默认模型、权限、全局 MCP 服务、hooks 都在那里配置。

编排器只做两件事：

- 每个会话传入项目选择的 `model`、`reasoningEffort`、`mcpServers`，以及项目的 skills；
- 控制工作目录（会话的 worktree）、编排器 action、审批路由，以及全局项目的只读模式。

设计背景见 [设计 05](../designs/05-native-runtime-config-and-single-repo-workspace/README.md)。

## 配置目录

| 运行时 | 默认目录 | 指定目录的环境变量 | 主要文件 |
| :--- | :--- | :--- | :--- |
| Codex | `~/.codex` | `CODEX_HOME` | `config.toml`、`auth.json` |
| Claude Code | `~/.claude` | `CLAUDE_CONFIG_DIR` | `settings.json`、`.credentials.json`、`.claude.json`（用户级 MCP） |
| Pi | `~/.pi/agent` | `PI_CODING_AGENT_DIR` | `settings.json`、`models.json`、`auth.json` |

运行时进程继承服务进程的环境变量。所以这些目录变量和认证变量（例如 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`）在服务的环境里设置就行。

服务最好使用专用的配置目录，不要和平时自己用的 CLI 共用。否则编排器的会话会混进你的会话历史，你个人的 hooks、插件、记忆也会作用到编排器的会话上。在容器里给这些目录挂独立的卷即可。

## 容器部署（`dev-orchestrator`）

1. **持久化配置目录**：给 `/root/.codex`、`/root/.claude`、`/root/.pi` 挂卷。也可以设置上面三个环境变量，指向卷里的目录。
2. **设置 `IS_SANDBOX=1`**：容器以 root 运行，而 Claude Code 在 root 下拒绝跳过权限检查（`bypassPermissions`），除非设置了这个变量。
3. **进容器各登录一次**：
   - Codex：`docker exec -it dev-orchestrator codex login --device-auth`；用 API key 时执行 `printenv OPENAI_API_KEY | codex login --with-api-key`；也可以在 `config.toml` 里配置一个自定义 provider。
   - Claude Code：`docker exec -it dev-orchestrator claude auth login`；也可以用 `claude setup-token` 生成长期 token，设置为环境变量 `CLAUDE_CODE_OAUTH_TOKEN`。
   - Pi：在 `pi` 里用 `/login` 登录 OAuth 类 provider，或者在 `models.json` / `auth.json` 里配置 provider。
4. **按需设置默认值**：
   - Codex：`config.toml` 里的 `model`、`model_provider`、`approval_policy`、`sandbox_mode`；
   - Claude Code：`settings.json` 里的 `model` 和 `permissions.defaultMode`；
   - Pi：`settings.json` 里的 `defaultProvider`、`defaultModel`、`defaultThinkingLevel`。

## 服务配置（`config.yaml`）

只有一个和运行时相关的字段：

```yaml
defaultRuntime: codex   # 全局项目和没写 runtime.type 的项目使用的运行时：codex | claude | pi
```

`config.yaml` 里不能再有 `runtimes:` 或 `codex:` 段，否则服务启动时会报 `Unrecognized key`。

## 项目配置（`projects/<id>/project.yaml`）

```yaml
project: { id: shortlink, displayName: Shortlink, description: ... }
routing: { projectId: shortlink, keywords: [shortlink, redirect] }

repository:                    # 一个项目一个仓库；每个会话使用它的一个独立 worktree
  url: git@github.com:example/shortlink.git
  baseBranch: main
  path: repos/shortlink        # 可选：用项目目录下已有的本地 checkout 作为 base 仓库
  auth: { type: ssh-key, key: "{env:SHORTLINK_DEPLOY_KEY}" }
  committer: { name: bot, email: bot@example.com }

runtime:                       # 整段可选，只接受下面四个字段
  type: codex                  # 不写就用 defaultRuntime
  model: deepseek-v4-pro       # 交给运行时解释；Pi 用 "provider/model" 或模型 id
  reasoningEffort: high        # minimal | low | medium | high | xhigh | max，运行时不支持的档位忽略
  mcpServers:                  # 叠加在运行时自己配置的 MCP 服务之上
    - name: github
      url: https://api.githubcopilot.com/mcp
      http_headers: { Authorization: "Bearer {env:GITHUB_TOKEN}" }

session:                       # 可选
  idleTimeoutMs: 1800000       # 空闲多久释放运行时会话（默认 30 分钟）
  archiveTimeoutMs: 3600000    # 空闲多久归档并删除 worktree（默认 1 小时）
```

写错字段名会在加载项目时直接报错。

## Skills 与指令

- **仓库自带的**：会话的工作目录就是仓库的 worktree，运行时会原生加载。不同运行时读的目录不一样：
  - Codex 读 `.agents/skills`、`.codex/skills` 和 `AGENTS.md`；
  - Pi 读 `.agents/skills`、`.pi/skills` 和 `AGENTS.md`；
  - Claude Code 读 `.claude/skills` 和 `CLAUDE.md`。

  想三家通用，可以在仓库里放 `.agents/skills` 和 `AGENTS.md`，再用软链接 `.claude/skills -> ../.agents/skills`、`CLAUDE.md -> AGENTS.md`。
- **编排器的项目 skills**：放在 `projects/<id>/.skills/<name>/SKILL.md`，全局 skills 放在 `projects/.skills/`。每个会话通过运行时的 API 传入。在 Claude Code 里，它们显示为 `<项目 id>:<skill>` 和 `global:<skill>`。
- **重名**：项目 skills 不要和仓库 skills 重名，三家对重名的处理不一致。
- **常驻规则**：写进仓库的 `AGENTS.md`。按需使用的流程文档做成项目 skill。

## 从旧配置迁移

1. **把 `config.yaml` 里 `runtimes.codex` 的内容搬到 Codex 的 `config.toml`**：`model_provider`、`model_providers.*` 和默认 `model`。API key 用 `codex login --with-api-key` 登录。原来编排器默认“全部放行”，要保持这个行为，在 `config.toml` 里设置：

   ```toml
   approval_policy = "never"
   sandbox_mode = "danger-full-access"
   ```

2. **`runtimes.pi`**：`providers` 搬到 Pi 的 `models.json`，`defaultProvider` / `defaultModel` 搬到 Pi 的 `settings.json`。
3. **`runtimes.claude`**：用 `claude auth login` 登录，或设置 `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`。原来的 `sandboxed: true` 改成环境变量 `IS_SANDBOX=1`。
4. **删除 `config.yaml` 里的 `runtimes:` 段**，按需加上 `defaultRuntime`。
5. **项目文件**：
   - `agent:` 改为 `runtime:`，并删掉 `approvalPolicy`、`sandbox`、`codexHome`、`config`、`baseConfigPath`、`providers` 等字段；
   - `repositories:` 改为单个 `repository:`，原来的顶层 `auth` / `committer` 挪进去；`init.sh` 克隆到 `repos/<id>` 的项目，加上 `path: repos/<id>`；
   - `idleTimeoutMs` / `archiveTimeoutMs` 挪到 `session:`；
   - 删除 `routing.repositories`。
6. **数据库**：按文件名顺序执行 `database/migrations/` 里尚未执行的脚本。
7. **已有会话**：原来的会话记录存在编排器的数据目录下，切换后运行时恢复不到。这时会走 `session.runtime_reset`：界面提示一次，然后开一个新的运行时会话，原来的上下文丢失一次。会话的 worktree 和分支不受影响。
