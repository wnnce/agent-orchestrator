# 04 - Claude Code 运行时接入设计

| 元数据       | 内容                                                              |
| :----------- | :---------------------------------------------------------------- |
| **文档 ID**  | `04-claude-code-integration`                                      |
| **状态**     | `Draft`                                                           |
| **创建日期** | 2026-11-18                                                        |
| **目标模块** | `src/runtime/claude/`、`src/runtime/registry.ts`、`src/config/`   |
| **依赖**     | `@anthropic-ai/claude-agent-sdk`（按 0.3.328 的类型定义核对）     |

---

## 1. 背景与动机

现在有两个真正可用的运行时：

- **Codex**：起一个 `codex app-server` 子进程，用 stdio 上的 JSON-RPC 通信，协议类型由 `bun run generate:codex` 生成。
- **Pi**：直接在进程内调用 `@earendil-works/pi-coding-agent` 的 SDK。

Claude Code 可以用官方的 Claude Agent SDK（`@anthropic-ai/claude-agent-sdk`）接入。这个 SDK 内部会起一个 Claude Code CLI 子进程，但子进程的通信、协议和类型都封装在 SDK 里。我们只需要使用一个带类型的异步迭代器接口，不用自己维护协议。

接入后，项目可以用 `runtime: { type: claude }` 选择 Claude Code。Claude Code 自带的这些能力都能直接用上：Read / Edit / Bash 等工具、权限审批、上下文压缩、会话恢复、MCP。

## 2. 目标与非目标

### 目标

- 完整实现 `AgentRuntime` 接口，遵守 `src/runtime/runtime.ts` 里写的事件约定：
  - runtime 只上报内容事件、`approval.requested`、`compaction.completed`、turn 的终止事件和 `runtime.disconnected`；
  - `session.*` 事件以及 `turn.queued` / `turn.started` 由 `ProjectRuntime` 发出。
- 所有文件和命令操作都限定在会话的 worktree（`context.workspacePath`）里执行。
- 和宿主机隔离：不读取宿主机上的 `~/.claude` 配置、登录状态和会话记录，也不往里写；每个项目有自己独立的 Claude 配置目录。
- 用 `canUseTool` 把权限请求转成 `approval.requested`，复用现有的审批接口（`{ requestId, decision }`）。
- 用 SDK 自带的进程内 MCP server（`createSdkMcpServer`）把 `ActionRegistry` 里的 action 暴露给 Claude。
- 支持 steer、中断、手动压缩，以及服务重启后恢复会话。

### 非目标

- 不处理子代理（`Agent` / `Task` 工具）内部的消息流。第一版只把子代理调用当成一次普通的工具调用展示，子代理自己的消息直接丢弃。
- 不做 Claude Code 插件、hooks 和 `/` 命令的透传配置。项目自己的 skills 会处理，见 4.7。
- 不把 `sandbox` 配置映射成 Claude Code 的 sandbox 设置。两边的语义不一样，这一版只通过权限模式控制，见 4.5。
- 不做按 token 或按金额的计费统计。`result` 消息里虽然带了 `total_cost_usd`，这一版只写日志。

## 3. 和现有运行时的对照

| 关注点     | Codex                            | Pi                                | Claude Code（本设计）                                       |
| :--------- | :------------------------------- | :-------------------------------- | :---------------------------------------------------------- |
| 进程模型   | 每个运行时实例一个 app-server 进程 | 进程内                            | **每个会话一个 CLI 子进程**（由 SDK 管理）                  |
| 协议       | 生成的 JSON-RPC 类型             | SDK 事件                          | SDK 的 `SDKMessage` 联合类型                                |
| 会话持久化 | Codex 自己管理（`CODEX_HOME`）   | `<dataDir>/pi/<project>/sessions` | `<dataDir>/claude/<project>`（通过 `CLAUDE_CONFIG_DIR` 指定） |
| 审批       | 服务端请求 → 待处理的审批表      | 不支持                            | `canUseTool` 回调返回 Promise → 待处理的审批表              |
| Action     | 动态工具（`item/tool/call`）     | Pi 的 `ToolDefinition`            | 进程内 MCP server                                           |
| 压缩       | `thread/compact`                 | `session.compact()`               | 发送 `/compact` 作为输入                                    |

这里最大的区别是：Codex 一个进程服务多个会话，而 Claude Code 是**一个会话一个子进程**。所以 `releaseSession` 必须关掉对应的子进程，否则空闲的会话会一直占着进程。目前 `ProjectRuntime` 在会话空闲超时后已经会调用 `releaseSession`，这里不需要另外处理。

## 4. 详细设计

### 4.1 模块结构

```
src/runtime/claude/
├── index.ts          # 导出 ClaudeRuntime、CLAUDE_CAPABILITIES、配置 schema
├── capabilities.ts
├── types.ts          # claudeRuntimeConfigSchema（zod strict）
├── runtime.ts        # ClaudeRuntime implements AgentRuntime
├── session.ts        # ClaudeSession：一个长期存在的 query() 和它的输入队列
├── normalizer.ts     # SDKMessage → RuntimeEvent[]，纯函数
└── tools.ts          # ActionRegistry → createSdkMcpServer
```

职责分工如下：

- `runtime.ts`：只负责会话表、配置解析和 `AgentRuntime` 各个方法的分发。
- `session.ts`：负责单个会话的输入队列、消息循环、turn 状态和待审批的请求。
- `normalizer.ts`：不持有可变状态。它需要知道某个 `tool_use` 是什么类型的调用，这个映射表由 `ClaudeSession` 传进来。

这样拆开后，`normalizer.ts` 可以像 `codex-normalizer` 一样，直接用构造出来的 `SDKMessage` 做单元测试。

### 4.2 会话与 query 的生命周期

每个编排器会话对应一个 `ClaudeSession`。每个 `ClaudeSession` 持有**一个**以流式输入模式启动的长期 `query()`：

```ts
const input = new InputQueue<SDKUserMessage>(); // push() + AsyncIterable，close() 结束迭代
const query = sdkQuery({ prompt: input, options });
void this.consume(query); // for await (const message of query) { ... }
```

| `AgentRuntime` 方法 | 实现                                                                                                                                                                                         |
| :------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startSession`      | 用 `crypto.randomUUID()` 生成 id，作为 `options.sessionId` 传给 SDK，然后创建 query，直接返回这个 id。不用等 `system/init` 消息才知道会话 id。                                               |
| `resumeSession`     | 如果会话表里已经有这个 id，只更新它的 context；否则先确认会话记录存在（见 4.8），再用 `options.resume = id` 创建 query。                                                                     |
| `startTurn`         | 生成 `runtimeTurnId`，记下当前 turn，`input.push(userMessage(input))`，然后立刻返回。turn 的结束由消息循环里收到的 `result` 消息决定。                                                       |
| `steerTurn`         | 在 turn 进行中再 `push` 一条用户消息，设置 `priority: "now"`，见 4.6。                                                                                                                       |
| `interruptTurn`     | 把 turn 标记为 `canceled`，然后调用 `query.interrupt()`。这个 turn 随后收到的 `result` 会被转成 `turn.interrupted`。                                                                         |
| `compactSession`    | 输入 `/compact`，等到 `compact_boundary` 和随后的 `result` 消息，见 4.6。                                                                                                                    |
| `respondToApproval` | 从待审批表里找到对应的 Promise 并 resolve，见 4.5。                                                                                                                                          |
| `releaseSession`    | 拒绝所有待审批的请求，调用 `input.close()` 和 `query.close()`，再从会话表里删除。                                                                                                            |
| `stop`              | 对所有会话执行 `releaseSession`。                                                                                                                                                            |

**进程意外退出**：

- 如果消息循环在 `releaseSession` 之前就结束了（迭代器正常结束或抛出异常），说明子进程挂了。
- 这时上报 `runtime.disconnected`，并把这个会话从会话表里删掉。
- `ProjectRuntime` 收到事件后会让正在进行的 turn 失败，并清除这个会话的绑定状态；下一个 turn 会自动走 `resumeSession`，这条路径已经存在，不需要新增逻辑。

**turn 的边界**：在流式输入模式下，每条用户输入处理完会收到一条 `result` 消息。`ClaudeSession` 同一时间只允许一个活跃 turn，这和 `ProjectRuntime` 的排队语义一致。如果 `result` 到达时没有活跃 turn（比如 `/compact` 产生的 `result`），就只交给压缩逻辑处理，不产生 turn 事件。

### 4.3 SDK 选项

每个会话的 `Options` 由 `buildQueryOptions(project, config, context)` 生成。这是一个纯函数，可以直接测试：

```ts
{
  cwd: context.workspacePath,
  sessionId | resume,                     // 见 4.2
  env: buildEnv(project, config),         // 见 4.4
  settingSources: config.settingSources,  // 默认 ["user", "project"]，见 4.4
  model: project.runtime?.model ?? config.model,
  effort: project.runtime?.reasoningEffort,  // 只接受 low|medium|high|xhigh|max
  permissionMode,                         // 见 4.5
  allowDangerouslySkipPermissions: permissionMode === "bypassPermissions",
  canUseTool,                             // 见 4.5
  tools: config.tools ?? { type: "preset", preset: "claude_code" },
  mcpServers: { ...外部 MCP server, orchestrator: actionServer },
  allowedTools: ["mcp__orchestrator__*"], // 编排器自己的 action 不需要审批
  systemPrompt: { type: "preset", preset: "claude_code", append: config.appendSystemPrompt },
  includePartialMessages: true,           // 需要流式的文本增量
  persistSession: true,
  pathToClaudeCodeExecutable: config.executable, // 默认使用 SDK 自带的可执行文件
  stderr: (line) => logger.debug("claude stderr", { sessionId, line }),
}
```

**外部 MCP server**：

- 来源是 `runtime.mcpServers`，服务级和项目级合并在一起。
- 按 SDK 的 `McpServerConfig` 格式转换：有 `url` 的转成 `{ type: "http", url, headers }`，有 `command` 的转成 `{ type: "stdio", command, args }`。
- 转换逻辑写在 `buildQueryOptions` 里。Codex 那边的 `mcpServerEntry` 是 TOML 格式，两边不共用。

### 4.4 隔离与认证

**配置目录**：

- 通过环境变量 `CLAUDE_CONFIG_DIR` 指定，默认是 `<dataDir>/claude/<projectId>`，也可以用 `runtimes.claude.configDir` 覆盖。
- 会话记录、Claude 生成的设置文件和 skills 都放在这里，不会碰宿主机的 `~/.claude`。

**`env` 会整个替换子进程的环境变量**（SDK 文档原话："REPLACES the subprocess environment entirely"），所以 `buildEnv` 需要显式构造出完整的环境：

```ts
{
  PATH, HOME, LANG,                        // 只从 process.env 取这几个基础变量
  ...project.env,                          // 项目自己的环境变量
  CLAUDE_CONFIG_DIR: configDir,
  ANTHROPIC_API_KEY: config.apiKey,        // 二选一
  ANTHROPIC_AUTH_TOKEN: config.authToken,  // 二选一
  ANTHROPIC_BASE_URL: config.baseUrl,      // 可选，例如走网关
  CLAUDE_AGENT_SDK_CLIENT_APP: "agent-orchestrator",
}
```

不把 `process.env` 整个透传过去，这样服务进程里的其它密钥（数据库连接串、飞书密钥等）就不会泄露给 agent 可以执行的 Bash。这和 Codex 删掉 `CODEX_*` / `OPENAI_*` 前缀变量的思路一样，只是这里换成了白名单。

**`settingSources` 的默认值是 `["user", "project"]`**：

- `"user"` 对应的是上面隔离出来的 `CLAUDE_CONFIG_DIR`，里面的内容完全由编排器生成，相当于“编排器的用户级配置”，不是宿主机用户的配置。
- `"project"` 会读取 worktree 里的 `CLAUDE.md` 和 `.claude/settings.json`。被托管的仓库都是自己的仓库，读取它们的说明文件，效果和 Codex 读取 `AGENTS.md` 一样。
- 不想读取仓库配置的项目，可以在 `runtime.settingSources` 里写 `["user"]`。

### 4.5 权限与审批

项目的 `approvalPolicy` 沿用 Codex 的取值，映射到 Claude 的 `permissionMode`。项目也可以直接写 `runtime.permissionMode`，这时以它为准：

| `approvalPolicy`（项目） | `permissionMode`    | 说明                                                       |
| :----------------------- | :------------------ | :--------------------------------------------------------- |
| `never`（默认）          | `bypassPermissions` | 和 Codex 默认的 `danger-full-access` + `never` 行为一致     |
| `on-request`             | `default`           | 有风险的操作会走 `canUseTool`                              |
| `on-failure`             | `acceptEdits`       | 文件编辑自动通过，命令走 `canUseTool`                      |
| `untrusted`              | `default`           | 同 `on-request`；Claude Code 没有对应的更严格档位          |

在 `bypassPermissions` 模式下，SDK 不会调用 `canUseTool`。默认安全配置的问题在设计 03 的安全条目里统一处理，这里沿用现状。

`canUseTool` 的实现：

```ts
canUseTool: (toolName, input, { toolUseID, signal, title, decisionReason }) =>
  new Promise<PermissionResult>((resolve) => {
    this.approvals.set(toolUseID, { resolve, input });
    signal.addEventListener("abort", () => this.settleApproval(toolUseID, deny("aborted")));
    emit("approval.requested", {
      requestId: toolUseID,
      actionType: approvalKind(toolName), // Bash → command，Write/Edit → file_change，其它 → tool_call
      description: title ?? `${toolName}`,
      payload: { toolName, input },
      metadata: decisionReason ? { reason: decisionReason } : undefined,
    });
  });
```

- `respondToApproval(requestId, decision)` 根据 `requestId` 找到待处理的 Promise：
  - `approved` → `{ behavior: "allow", updatedInput: input }`
  - `rejected` → `{ behavior: "deny", message: "rejected by user" }`
  - 找不到 `requestId` 时，和 Codex 一样抛错。
- `requestId` 直接用 SDK 给的 `toolUseID`，不用自己再生成 id。
- `releaseSession` 和中断时，把所有待审批的请求按拒绝处理，防止 Promise 永远挂着。
- 待审批表放在 `ClaudeSession` 上。`respondToApproval` 只拿到 `requestId`，所以 `ClaudeRuntime` 需要另外维护一张 `requestId → ClaudeSession` 的索引，请求结束时从索引里删掉。

### 4.6 Steer 与压缩

**Steer**：

- 在 turn 进行中 `push` 一条带 `priority: "now"` 的 `SDKUserMessage`。
- CLI 会把它合并到当前 turn 里，`result` 和 assistant 消息上的 `user_message_uuids` 字段会列出合并进来的输入。
- 第一阶段需要先用实际的 CLI 确认两点：合并确实发生；只产生**一条** `result` 消息。
- 如果确认不了，就把 `steer` 能力声明为 `false`，`ProjectRuntime` 会把输入当成排队的下一个 turn，不需要额外处理。

**压缩**：

- SDK 没有单独的压缩方法，压缩的方式就是把 `/compact` 当作用户输入发过去，这也是 Claude Code 自己的做法。
- `compactSession` 发出 `/compact`，然后等待**下一条 `result` 消息**。
- `compact_boundary` 消息会被转成 `compaction.completed`，携带 `pre_tokens` / `post_tokens`。
- 如果当前有活跃 turn，`ProjectRuntime` 不会调用压缩，这里不需要额外处理并发。
- 自动压缩（`trigger: "auto"`）产生的 `compact_boundary` 同样会转成 `compaction.completed`。

### 4.7 Action 桥接与 Skills

**Action**：

- `tools.ts` 把 `actionRegistry.list(scope)` 里的每个 action 转成一个 SDK `tool(name, description, shape, handler)`，然后放进 `createSdkMcpServer({ name: "orchestrator", tools })`。
- 目前所有内置 action 的参数都是 zod object，直接用 `.shape` 作为 SDK 需要的 `inputSchema`。
- 如果某个 action 的参数不是 zod object（只有 JSON Schema），就传空 shape，参数校验仍然交给 `actionRegistry.execute`。
- handler 的逻辑和 Pi 的 `bridgeActionsToPiTools` 一样：创建 `ActionContext`，执行 action，把结果包装成 `{ content: [{ type: "text", text }], isError }`。
- 创建 `ActionContext` 的那部分逻辑，从 `pi/tools.ts` 提到 `src/runtime/action-bridge.ts`，两个运行时共用。只有工具的格式转换是各自私有的。

**Skills**：

- 创建 query 之前，把项目的 skills（以及继承自全局项目的 skills）用软链接放到 `<configDir>/skills/<id>`，然后传 `skills: "all"`。
- 现在的 `SkillManager.syncSkillsToCodex` 本质上是“同步到某个目录下的 `skills/`”，和 Codex 并没有关系。所以把它改名为 `syncSkillsTo(dir, …)`，两个运行时共用。
- 这一条依赖 Claude Code 会读取 `CLAUDE_CONFIG_DIR/skills`，也就是 `settingSources` 里的 `"user"`，第一阶段需要确认。

### 4.8 会话恢复

- `runtimeSessionId` 就是 Claude 的会话 UUID，由 `ProjectRuntime` 持久化。
- 会话记录按 `cwd` 分目录存放；worktree 的路径已经存进了 `SessionRoute.workspacePath`，所以恢复时的 `cwd` 和创建时一样。

**会话记录找不到时**：`resumeSession` 必须抛出 `RuntimeSessionNotFoundError`，`ProjectRuntime` 收到后会发出 `session.runtime_reset` 并新建一个会话。判断方式按优先级：

1. 调用 SDK 的 `getSessionInfo(id, { dir: workspacePath })`。它在宿主进程里运行，需要确认它是否读取子进程的 `CLAUDE_CONFIG_DIR`（它的选项里没有指定配置目录的参数）。
2. 如果它读不到隔离的配置目录，就**不自己去解析 Claude 的会话文件目录结构**。改为：resume 后的 query 如果在 `system/init` 之前就以错误结束，就把这次失败当作找不到会话。

具体用哪种方式，在第一阶段确认后写回本节。

### 4.9 事件映射

`normalizer.ts` 只处理主线程的消息（`parent_tool_use_id === null`），子代理的消息不处理。SDK 文档明确说 `SDKMessage` 的类型会越来越多，消费方应该忽略不认识的类型，所以没有映射的消息一律返回 `[]`。

| SDK 消息                                                  | 规范事件                                                                                                     |
| :-------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------- |
| `stream_event`，`content_block_delta` / `text_delta`      | `agent.message.delta`                                                                                        |
| `stream_event`，`content_block_delta` / `thinking_delta`  | `agent.reasoning.delta`                                                                                      |
| `assistant` 的 `text` 块                                  | `agent.message.completed`（itemId 用 `${message.uuid}:${index}`）                                            |
| `assistant` 的 `thinking` 块                              | `agent.reasoning.completed`                                                                                  |
| `assistant` 的 `tool_use` 块：`Bash`                      | `command.started`（`command`、`workdir` = cwd）                                                              |
| `assistant` 的 `tool_use` 块：`Write`                     | `file_change.started`（kind `create`）                                                                       |
| `assistant` 的 `tool_use` 块：`Edit` / `NotebookEdit`     | `file_change.started`（kind `modify`）                                                                       |
| `assistant` 的 `tool_use` 块：`TodoWrite`                 | `plan.updated`                                                                                               |
| `assistant` 的 `tool_use` 块：`mcp__orchestrator__*`      | `tool.call.started`（toolName 用 action 名）                                                                 |
| `assistant` 的 `tool_use` 块：其它 `mcp__<server>__<tool>` | `mcp_call.started`                                                                                           |
| `assistant` 的 `tool_use` 块：其它工具                    | `tool.call.started`                                                                                          |
| `user` 消息里的 `tool_result` 块                          | 按 `tool_use_id` 找到对应调用的类型，发出 `command.completed` / `file_change.completed` / `tool.called` / `mcp_call.completed` |
| `system` / `compact_boundary`                             | `compaction.completed`                                                                                       |
| `result` / `success`                                      | `turn.completed`（`finalText` = `result.result`）；如果 turn 已被中断，改为 `turn.interrupted`                |
| `result` / `error_*`                                      | `turn.failed`（`error` = `errors.join("\n")`）；如果 turn 已被中断，改为 `turn.interrupted`                   |
| `system` / `init`                                         | 不产生事件，只记 debug 日志（模型、工具数、MCP 状态）                                                        |

`tool_use_id → 调用类型` 的映射表放在 `ClaudeSession` 上，在 `tool_result` 处理完后删除对应的条目。

`file_change` 的 `create` / `modify` 只看工具名来判断，不去检查文件是否已经存在。这只影响界面上的图标。

### 4.10 能力声明

```ts
export const CLAUDE_CAPABILITIES: RuntimeCapabilities = {
  streaming: true,
  resume: true,
  steer: true, // 第一阶段验证失败则改为 false，见 4.6
  interrupt: true,
  compaction: true,
  approvals: true,
  mcp: true,
  structuredOutput: true,
  sandbox: false, // 见非目标
};
```

### 4.11 日志

| 级别    | 场景                                                                                                         |
| :------ | :----------------------------------------------------------------------------------------------------------- |
| `info`  | 会话启动、恢复和释放（sessionId、projectId、model）                                                          |
| `debug` | `system/init` 摘要；子进程 stderr；每个 turn 结束时 `result` 里的耗时、轮数和 `total_cost_usd`               |
| `warn`  | 收到未知 `requestId` 的审批；恢复时找不到会话                                                                |
| `error` | 消息循环异常退出（即上报 `runtime.disconnected` 的时候）                                                     |

日志里永远不写 `env`、`apiKey`、`authToken`，也不写工具的完整输入（可能带文件内容）。工具输入只记录工具名。

## 5. 配置

### 服务级（`config.yaml`）

```yaml
runtimes:
  claude:
    apiKey: sk-ant-...             # 和 authToken 二选一
    # authToken: ...
    # baseUrl: https://gateway.example.com
    model: claude-opus-5-5         # 项目没写 runtime.model 时使用的默认模型
    # configDir: .data/claude      # 默认 <dataDir>/claude/<projectId>
    # executable: /usr/local/bin/claude   # 默认用 SDK 自带的可执行文件
    # settingSources: [user, project]
    # tools: [Read, Edit, Write, Bash, Grep, Glob]  # 默认是 claude_code 预设
    # appendSystemPrompt: "..."
    # mcpServers: [...]            # 和其它运行时格式相同
```

对应的 schema 是 `src/runtime/claude/types.ts` 里的 `claudeRuntimeConfigSchema`，用 `z.strictObject`，写错字段名会在启动时直接报错。在 `registry.ts` 注册时，用 `claudeRuntimeConfigSchema.parse(ctx.config.runtimes?.claude ?? {})` 解析，和 Pi 一样。`runtimesConfigSchema` 本身用了 `catchall`，不需要修改。

### 项目级（`projects/<id>/project.yaml`）

```yaml
runtime:
  type: claude
  model: claude-sonnet-5-5
  reasoningEffort: high          # 映射为 effort
  approvalPolicy: on-request     # 映射为 permissionMode，见 4.5
  # permissionMode: acceptEdits  # 直接指定，优先于 approvalPolicy
  # settingSources: [user]
  # mcpServers: [...]
```

项目级只读取上面列出的字段，其它字段（Codex 的 `config`、Pi 的 `providers` 等）一律忽略。这和设计 03 里收紧 Codex 项目级配置的思路一致。

## 6. 实施阶段与测试

### 第一阶段：验证（不提交业务代码）

在临时目录里写一个最小脚本，用真实的 CLI 依次确认下面这些问题。结论写回本文档对应的小节：

1. 同一个 query 里连续两次输入，是否各产生一条 `result` 消息。
2. 在 turn 进行中 `push` 一条 `priority: "now"` 的消息，是否会合并到当前 turn（4.6）。
3. 输入 `/compact` 是否会产生 `compact_boundary` 和一条 `result` 消息（4.6）。
4. `getSessionInfo` 能不能找到隔离配置目录里的会话；resume 一个不存在的 id 时，具体会发生什么（4.8）。
5. `CLAUDE_CONFIG_DIR/skills` 下的 skills 是否会被加载（4.7）。
6. `dev-orchestrator` 容器里能否正常使用 SDK 自带的可执行文件（optional dependency 区分 glibc 和 musl 两个版本）。

### 第二阶段：实现

建议按下面的顺序拆成几个提交：

1. `refactor: share action context creation and skill sync between runtimes`：提取 `action-bridge.ts`，`syncSkillsToCodex` 改名为 `syncSkillsTo`。
2. `build: add claude agent sdk`：安装依赖，同步更新 `bun.lock`。
3. `feat: add claude code runtime`：`src/runtime/claude/` 和注册代码。
4. `feat: route claude code permission prompts through approvals`：`canUseTool` 和待审批表。
5. `docs: document claude runtime configuration`：更新 `config.example.yaml` 和本文档的状态。

### 测试

- `tests/claude-normalizer.test.ts`：用构造的 `SDKMessage` 覆盖 4.9 表格里的每一行，以及子代理消息和未知类型的消息会被忽略。
- `tests/claude-options.test.ts`：覆盖 `buildQueryOptions` / `buildEnv`：
  - `approvalPolicy` 到 `permissionMode` 的映射；
  - `env` 里不包含白名单以外的变量；
  - MCP server 的格式转换；
  - 项目级的无关字段不会生效。
- `tests/claude-runtime.test.ts`：把 `query` 函数通过构造参数注入（默认用 SDK 的 `query`），用一个脚本化的假 Query（异步迭代器，加上 `interrupt` / `close` 方法）覆盖以下场景：
  - turn 正常完成、失败、中断；
  - steer；
  - 审批的通过、拒绝，以及释放会话时自动拒绝；
  - 压缩；
  - 消息循环异常退出时上报 `runtime.disconnected`；
  - 恢复时抛出 `RuntimeSessionNotFoundError`。
- 测试都不需要真实的 API key；第一阶段的验证脚本不进入测试集。
- 最后跑一遍 `bun run check`、`bun run build`。

## 7. 备选方案与取舍

**直接用 `claude -p --output-format stream-json` 子进程**：放弃。

- 要自己维护 stream-json 协议、审批协议和进程管理。
- 这些 SDK 都已经封装好了，而且有类型。
- 这和设计 02 放弃 `pi --mode rpc` 的理由一样。

**每个 turn 起一个新的 `query({ prompt: string, resume })`**：放弃。

- 实现更简单，但每个 turn 都要重新启动 CLI，冷启动慢。
- steer 和 `interrupt()` 都需要一个正在运行的 query，这种方式做不了。
- 长期 query 的代价是空闲会话会占着子进程。不过 `ProjectRuntime` 已经有空闲超时释放，代价可以接受。

**全局一个 `CLAUDE_CONFIG_DIR`**：放弃。

- 每个项目的 skills 和设置不一样，共用一个目录会互相覆盖。
- 按项目分目录，和 Pi 的 `<dataDir>/pi/<project>` 保持一致。

**用 `sessionStore` 把会话记录写进 PostgreSQL**：暂不采用。

- 这个接口标了 `@alpha`。
- 本地目录已经满足需求；等接口稳定、并且需要跨机器恢复会话时再考虑。

**`settingSources: []`（完全隔离）**：不作为默认值。

- 这样会读不到仓库的 `CLAUDE.md`，也读不到我们生成的 skills。
- 隔离已经由独立的 `CLAUDE_CONFIG_DIR` 保证，`"user"` 对应的不是宿主机的配置，所以默认值保留 `"user"` 和 `"project"`。
