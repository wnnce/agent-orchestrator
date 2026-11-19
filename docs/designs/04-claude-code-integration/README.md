# 04 - Claude Code 运行时接入设计

| 元数据       | 内容                                                              |
| :----------- | :---------------------------------------------------------------- |
| **文档 ID**  | `04-claude-code-integration`                                      |
| **状态**     | `Accepted`                                                        |
| **创建日期** | 2026-11-18                                                        |
| **目标模块** | `src/runtime/claude/`、`src/runtime/registry.ts`                  |
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
├── types.ts          # claudeRuntimeConfigSchema（zod strict）、项目级字段 schema
├── options.ts        # buildQueryOptions / buildEnv / permissionModeFor，纯函数
├── runtime.ts        # ClaudeRuntime implements AgentRuntime
├── session.ts        # ClaudeSession：一个长期存在的 query() 和它的输入队列
├── normalizer.ts     # ClaudeNormalizer：SDKMessage → RuntimeEvent[]
└── tools.ts          # ActionRegistry → createSdkMcpServer
```

职责分工如下：

- `runtime.ts`：只负责会话表、配置解析和 `AgentRuntime` 各个方法的分发。
- `session.ts`：负责单个会话的输入队列、消息循环、turn 状态和待审批的请求。
- `options.ts`：把服务配置和项目配置转换成 SDK 的 `Options`，不涉及进程和状态。
- `normalizer.ts`：每个会话一个实例，只保存把消息配对所需的少量状态：流式块的 item id、`tool_use_id → 调用类型`。它不处理 turn 的结束。

这样拆开后，`options.ts` 和 `normalizer.ts` 都可以直接用构造出来的数据做单元测试。

### 4.2 会话与 query 的生命周期

每个编排器会话对应一个 `ClaudeSession`。每个 `ClaudeSession` 持有**一个**以流式输入模式启动的长期 `query()`：

```ts
const input = new InputQueue<SDKUserMessage>(); // push() + AsyncIterable，close() 结束迭代
const query = sdkQuery({ prompt: input, options });
void this.consume(query); // for await (const message of query) { ... }
```

| `AgentRuntime` 方法 | 实现                                                                                                                                                                                         |
| :------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startSession`      | 用 `crypto.randomUUID()` 生成 id，作为 `options.sessionId` 传给 SDK，创建 query 并等待 `initializationResult()`，配置或认证问题在这里就会暴露。不用等 `system/init` 消息才知道会话 id。     |
| `resumeSession`     | 如果会话表里已经有这个 id，只更新它的 context；否则用 `options.resume = id` 创建 query，等待初始化完成（见 4.8）。                                                                           |
| `startTurn`         | 生成 `runtimeTurnId`，记下当前 turn，`input.push(userMessage(input))`，然后立刻返回。turn 的结束由消息循环里收到的 `result` 消息决定。                                                       |
| `steerTurn`         | 在 turn 进行中再 `push` 一条用户消息，设置 `priority: "now"`，并把它的 uuid 加入这个 turn 待回答的输入，见 4.6。                                                                             |
| `interruptTurn`     | 把 turn 标记为 `canceled`，然后调用 `query.interrupt()`。这个 turn 随后收到的 `result` 会被转成 `turn.interrupted`。                                                                         |
| `compactSession`    | 输入 `/compact`，等到 `compact_boundary` 和随后的 `result` 消息，见 4.6。                                                                                                                    |
| `respondToApproval` | 从待审批表里找到对应的 Promise 并 resolve，见 4.5。                                                                                                                                          |
| `releaseSession`    | 拒绝所有待审批的请求，调用 `input.close()` 和 `query.close()`，再从会话表里删除。                                                                                                            |
| `stop`              | 对所有会话执行 `releaseSession`。                                                                                                                                                            |

**进程意外退出**：

- 如果消息循环在 `releaseSession` 之前就结束了（迭代器正常结束或抛出异常），说明子进程挂了。
- 这时上报 `runtime.disconnected`，并把这个会话从会话表里删掉。
- `ProjectRuntime` 收到事件后会让正在进行的 turn 失败，并清除这个会话的绑定状态；下一个 turn 会自动走 `resumeSession`，这条路径已经存在，不需要新增逻辑。

**turn 的边界**：

- 在流式输入模式下，每条用户输入处理完会收到一条 `result` 消息。
- 每条推送给 CLI 的输入都带一个客户端 `uuid`，`result` 的 `user_message_uuids` 会列出它回答了哪些输入。turn 记下自己的输入（prompt 和所有 steer）的 uuid，这些 uuid 都被回答了，turn 才结束；被中断的 turn 在收到下一条属于它的 `result` 时结束。不属于当前 turn 的 `result`（比如中断后迟到的 steer 回复）会被忽略。
- `result` 的 `subtype` 为 `success` 时也可能 `is_error: true`（例如 API key 无效），这种情况按失败处理。
- `ProjectRuntime` 每个会话只有一个 pump，turn 严格串行：新消息先进 `pendingTurns` 排队（`turn.queued`），上一个 turn 结束才会调用下一个 `startTurn`。所以 `ClaudeSession` 不会在 turn 进行中收到第二个 `startTurn`，不需要自己排队。
- turn 进行中能到达 runtime 的输入只有 steer（4.6）和压缩（4.6）。
- 如果 `result` 到达时没有活跃 turn（比如 `/compact` 产生的 `result`），就只交给压缩逻辑处理，不产生 turn 事件。

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
  systemPrompt: { type: "preset", preset: "claude_code", append: config.appendSystemPrompt },
  includePartialMessages: true,           // 需要流式的文本增量
  persistSession: true,
  skills: "all",
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

- 通过环境变量 `CLAUDE_CONFIG_DIR` 指定，默认是 `<dataDir>/claude/<projectId>`。`runtimes.claude.configDir` 覆盖的是根目录，每个项目仍然在 `<configDir>/<projectId>` 下各自一个目录。
- 会话记录、Claude 生成的设置文件和 skills 都放在这里，不会碰宿主机的 `~/.claude`。

**`env` 会整个替换子进程的环境变量**（SDK 文档原话："REPLACES the subprocess environment entirely"），所以 `buildEnv` 需要显式构造出完整的环境：

```ts
{
  PATH, HOME, LANG,                        // 只从 process.env 取这几个基础变量
  ...project.env,                          // 项目自己的环境变量
  CLAUDE_CONFIG_DIR: configDir,
  ANTHROPIC_API_KEY: config.apiKey,            // 三选一
  ANTHROPIC_AUTH_TOKEN: config.authToken,      // 三选一，例如走网关
  CLAUDE_CODE_OAUTH_TOKEN: config.oauthToken,  // 三选一，`claude setup-token` 生成的订阅 token
  ANTHROPIC_BASE_URL: config.baseUrl,          // 可选
  IS_SANDBOX: "1",                             // 只在 sandboxed: true 时设置，见 4.5
  CLAUDE_AGENT_SDK_CLIENT_APP: "agent-orchestrator",
}
```

`PATH`、`HOME` 之外还保留 `USER`、`SHELL`、`LANG`、`LC_ALL`、`TZ`、`TMPDIR`、代理相关变量和 `NODE_EXTRA_CA_CERTS`，这些都不是密钥。三种凭据一个都没配置时，启动会话前直接报错。

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

**以 root 运行时**：Claude Code 拒绝在 root 下跳过权限检查（`--dangerously-skip-permissions cannot be used with root/sudo privileges`），除非设置了 `IS_SANDBOX=1`。`dev-orchestrator` 容器就是以 root 运行的。

- 这里不做静默绕过，而是加一个显式的服务级开关 `runtimes.claude.sandboxed: true`，表示服务跑在隔离容器里，打开后才设置 `IS_SANDBOX=1`。
- 以 root 运行、权限模式是 `bypassPermissions`、又没有打开开关时，`buildQueryOptions` 直接报错，说明要怎么改。不会等 CLI 返回一个看不懂的启动失败。

**编排器自己的 action**：最初的方案是用 `allowedTools: ["mcp__orchestrator"]` 免审批，但 SDK 会对每个会话打一条 `CANUSE_TOOL_SHADOWED` 警告。改为在 `canUseTool` 里对 `mcp__orchestrator__*` 直接返回 allow，不产生 `approval.requested`。

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
- 实测（0.3.328）**不会**合并进当前 turn：CLI 在当前工具调用结束后，先给原输入发一条 `result`（文本为空），再把 steer 当作下一轮处理，又发一条 `result`。最终回复同时考虑了工具结果和 steer 的内容。
- 所以 turn 按 4.2 的 uuid 规则结束：两条 `result` 都到齐，turn 才结束，`finalText` 取最后一条。如果以后的 CLI 改为合并处理，同一套规则依然正确。

**压缩**：

- SDK 没有单独的压缩方法，压缩的方式就是把 `/compact` 当作用户输入发过去，这也是 Claude Code 自己的做法。
- `compactSession` 发出带 uuid 的 `/compact`，等待回答它的那条 `result`。实测会先收到 `compact_boundary`，再收到一条 `num_turns: 0` 的 `result`。
- `compact_boundary` 消息会被转成 `compaction.completed`，携带 `pre_tokens` / `post_tokens`。
- 现在 `ProjectRuntime.compact()` **没有**检查活跃 turn。对 Claude 来说，`/compact` 只是一条普通输入，turn 进行中发出去会和当前 turn 的 `result` 混在一起。所以要在 `ProjectRuntime.compact()` 里加一个通用检查：有活跃 turn 时直接报错，和 `steer` 在没有活跃 turn 时报错的写法对称。这是所有运行时都需要的修复，不放在 Claude 适配器里单独处理。
- 自动压缩（`trigger: "auto"`）产生的 `compact_boundary` 同样会转成 `compaction.completed`。

### 4.7 Action 桥接与 Skills

**Action**：

- `tools.ts` 把 `actionRegistry.list(scope)` 里的每个 action 转成一个 SDK `tool(name, description, shape, handler)`，然后放进 `createSdkMcpServer({ name: "orchestrator", tools })`。
- 目前所有内置 action 的参数都是 zod object，直接用 `.shape` 作为 SDK 需要的 `inputSchema`。
- 如果某个 action 的参数不是 zod object（只有 JSON Schema），就传空 shape，参数校验仍然交给 `actionRegistry.execute`。
- handler 的逻辑和 Pi 的 `bridgeActionsToPiTools` 一样：创建 `ActionContext`，执行 action，把结果包装成 `{ content: [{ type: "text", text }], isError }`。
- 创建 `ActionContext`、选择 action 范围和格式化结果的逻辑，提到了 `src/runtime/action-bridge.ts`，Codex、Pi 和 Claude 三个运行时共用。只有工具的格式转换是各自私有的。

**Skills**：

- 创建 query 之前，把项目的 skills（以及继承自全局项目的 skills）用软链接放到 `<configDir>/skills/<id>`，然后传 `skills: "all"`。
- 原来的 `SkillManager.syncSkillsToCodex` 本质上是“链接到某个目录下的 `skills/`”，和 Codex 并没有关系。已改名为 `SkillManager.linkSkills(homeDir, …)`，Codex 和 Claude 共用。
- 实测 `settingSources` 包含 `"user"` 时，`CLAUDE_CONFIG_DIR/skills` 下的 skill 会被加载。

### 4.8 会话恢复

- `runtimeSessionId` 就是 Claude 的会话 UUID，由 `ProjectRuntime` 持久化。
- 会话记录按 `cwd` 分目录存放；worktree 的路径已经存进了 `SessionRoute.workspacePath`，所以恢复时的 `cwd` 和创建时一样。

**会话记录找不到时**：`resumeSession` 必须抛出 `RuntimeSessionNotFoundError`，`ProjectRuntime` 收到后会发出 `session.runtime_reset` 并新建一个会话。

- `getSessionInfo` / `listSessions` 读的是**宿主进程**的 `CLAUDE_CONFIG_DIR`，不能按项目指定目录，所以不用它们，也不自己解析 Claude 的会话文件目录结构。
- 实测 resume 一个不存在的 id 时，在初始化完成之前就会收到一条 `result/error_during_execution`（“No conversation found with session ID …”），随后 `initializationResult()` reject。
- 所以 `ClaudeSession.open()` 等待 `initializationResult()`：如果它 reject，并且这是一次 resume，并且在初始化前收到过错误 `result`，就抛出 `RuntimeSessionNotFoundError`；其它启动失败抛普通错误，带上 CLI 给出的错误文本。

### 4.9 事件映射

`normalizer.ts` 只处理主线程的消息（`parent_tool_use_id === null`），子代理的消息不处理。SDK 文档明确说 `SDKMessage` 的类型会越来越多，消费方应该忽略不认识的类型，所以没有映射的消息一律返回 `[]`。

| SDK 消息                                                  | 规范事件                                                                                                     |
| :-------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------- |
| `stream_event`，`content_block_delta` / `text_delta`      | `agent.message.delta`                                                                                        |
| `stream_event`，`content_block_delta` / `thinking_delta`  | `agent.reasoning.delta`                                                                                      |
| `assistant` 的 `text` 块                                  | `agent.message.completed`（itemId 用 `${API message id}:${块序号}`，和流式增量的 itemId 一致）                |
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
  steer: true, // 按 uuid 判断 turn 结束，见 4.2、4.6
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
| `info`  | 会话启动、恢复和释放（sessionId、projectId）                                                                 |
| `debug` | `system/init` 摘要；子进程 stderr；每个 turn 结束时 `result` 里的耗时、轮数和 `total_cost_usd`               |
| `warn`  | 恢复时找不到会话（带 CLI 给出的错误文本）                                                                    |
| `error` | 消息循环异常退出（即上报 `runtime.disconnected` 的时候）                                                     |

日志里永远不写 `env`、`apiKey`、`authToken`、`oauthToken`，也不写工具的完整输入（可能带文件内容）。

收到未知 `requestId` 的审批时，和 Codex 一样直接抛错，由网关返回给调用方，不另外写日志。

## 5. 配置

### 服务级（`config.yaml`）

```yaml
runtimes:
  claude:
    apiKey: sk-ant-...             # apiKey / authToken / oauthToken 三选一
    # authToken: ...               # LLM 网关的 bearer token
    # oauthToken: ...              # `claude setup-token` 生成的订阅 token
    # baseUrl: https://gateway.example.com
    model: claude-opus-5-5         # 项目没写 runtime.model 时使用的默认模型
    # sandboxed: true              # 服务以 root 跑在隔离容器里时必须打开，见 4.5
    # configDir: .data/claude      # 根目录，每个项目在 <configDir>/<projectId>
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

在临时目录里写最小脚本，用真实的 CLI（0.3.328 自带的版本）确认下面这些问题，结论已经写回对应的小节：

| 问题 | 结论 |
| :--- | :--- |
| turn 进行中 `push` 一条 `priority: "now"` 的消息，会不会合并到当前 turn（4.6） | 不合并，产生两条 `result`；带上客户端 uuid 后，`user_message_uuids` 能准确说明每条 `result` 回答的是哪条输入 |
| 输入 `/compact` 会产生什么（4.6） | 一条 `compact_boundary`（带 `pre_tokens` / `post_tokens`），然后一条 `result` |
| `getSessionInfo` 能不能找到隔离目录里的会话；resume 不存在的 id 时会发生什么（4.8） | `getSessionInfo` 只读宿主进程的 `CLAUDE_CONFIG_DIR`；resume 失败表现为初始化前的错误 `result` 加上 `initializationResult()` reject |
| `CLAUDE_CONFIG_DIR/skills` 下的 skills 会不会被加载（4.7） | 会（`settingSources` 包含 `"user"`） |
| `dev-orchestrator` 容器里能不能用 SDK 自带的可执行文件 | 容器是 Debian glibc x86_64，对应 `linux-x64` 包，可以用；但容器以 root 运行，跳过权限检查需要 `IS_SANDBOX=1`（4.5） |

另外发现：API key 无效时，`result` 是 `subtype: "success"` 加 `is_error: true`（4.2）。

不需要验证“连续输入”的情况：turn 由 `ProjectRuntime` 串行调度，下一条输入一定在上一条的 `result` 之后才会发出（4.2）。

### 第二阶段：实现

实际提交：

1. `fix: reject compaction while a turn is running`：`ProjectRuntime.compact()` 在有活跃 turn 时报错，补测试（4.6）。
2. `refactor: share action bridging and skill linking between runtimes`：提取 `src/runtime/action-bridge.ts`，`syncSkillsToCodex` 改名为 `linkSkills`。Codex 的动态工具调用也改用它；工具调用找不到对应 thread 时直接回 JSON-RPC 错误，和审批请求的处理一致。
3. `build: add claude agent sdk`：安装依赖，同步更新 `bun.lock`（带进来的 peer 依赖是 `@modelcontextprotocol/sdk`）。
4. `feat: add claude code runtime`：`src/runtime/claude/` 和注册代码。审批的代码和会话代码耦合很紧，没有按原计划拆成单独的提交。
5. `docs: document claude runtime configuration`：`config.example.yaml` 和本文档。

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

除了单元测试，还用真实的 CLI（Haiku）对 `ClaudeRuntime` 做了一次端到端冒烟测试。凭据和配置目录换成宿主机已登录的账号，其余选项不变。确认了：

- Claude 调用了编排器的 action，参数正确；
- Bash 触发 `approval.requested`，批准后执行成功；
- 中断以 `turn.interrupted` 结束；
- `/compact` 产生 `compaction.completed`（21127 → 4623 tokens）；
- 释放会话后在新进程里恢复，上下文还在；
- 恢复不存在的会话抛出 `RuntimeSessionNotFoundError`。

这次冒烟测试发现了一个单元测试没覆盖到的问题（构造 action server 时过早访问会话对象），已修复并补了测试。

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
