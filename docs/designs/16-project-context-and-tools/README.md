# Design 16: 统一项目上下文与 Agent 工具

| Field | Value |
| --- | --- |
| **Status** | Accepted（阶段 1–5 已实现，Hooks 待设计 15 修订） |
| **Target Module** | `src/context/`（新增）、`src/actions/` → `src/tools/`、`src/task/`、`src/pipeline/`、`src/project/`、`src/persistence/` |
| **Date** | 2026-11-27 |

---

## 1. 背景与动机

项目里能"以项目身份做事"的代码有三类：TS 任务、Pipeline 代码节点、Action（Agent 调用的工具）。它们各有一个上下文，各自定义、各自构造：

| 上下文 | 给谁用 | 构造位置 |
| --- | --- | --- |
| `TaskRunContext` | TS 任务 `run(ctx)` | `src/task/executors/ts.ts`，先造一个 `ActionContext` 再包一层 |
| `PipelineTsRunContext` | Pipeline 代码节点 | `src/pipeline/ts-node.ts`，直接调用各服务 |
| `ActionContext` | Action handler | `src/actions/context.ts`，由 `ProjectRuntime` 和 runtime bridge 调用 |

能力对比：

| 能力 | 任务 | Pipeline 节点 | Action |
| --- | --- | --- | --- |
| `env` / `vars` | ✓ | ✓ | ✗ |
| `notify` | ✓（经 ActionContext） | ✓（直接调 outbox） | ✓ |
| `createArtifact` | ✓ | ✓（参数不同） | ✓ |
| MCP | ✓ | ✓ | ✗ |
| 开 Agent 会话 | ✓ | ✗ | ✓ |
| 启动 Pipeline | ✓ | ✗ | 仅通过服务定位器 |
| 调 Action | ✓ | ✗ | ✗ |
| 持久状态 | `getState` / `updateState` / 返回值 | `step` / `waitUntil` | `getTaskState` / `updateTaskState` |

问题不止是"有三个上下文"，而是概念边界本身不清楚。

### 1.1 概念层

1. **Action 把"给 Agent 的工具"和"项目能力"混在一起。** 内置 Action 大多是能力的薄包装：`send_notification` → `notify`，`create_artifact` → `createArtifact`，`dispatch_agent_task` → `dispatchTask`，`update_task_state` → `updateTaskState`；其余通过 `requireService("store" | "pipelineEngine")` 直接操作内部服务。TS 任务里的 `invokeAction("send_notification", {...})` 用字符串名调用、参数是给 LLM 的 snake_case、还要拆 `ActionResult` 外壳，是"直接调 `ctx.notify`"的绕路版本。项目也不能定义自己的 Action。
2. **调用方靠猜。** `scope` 取 `taskKey ? "task" : "conversation"`；审计的 `determineCaller` 按"有 taskKey 算 task、有 turnId 算 model"推断。"谁在调用"是确定的事实，不应从零散字段推出来。
3. **四套扩展机制，四种写法。** TS 任务是 `export default function(api) { api.registerTask(...) }`；Pipeline 是 `export default definePipeline(...)`；Markdown 任务有 agent / script / action 三种执行器（项目里只用了 agent）；`projects/<id>/executors/*.ts` 按三种形状猜测导出的执行器（没有项目在用）。

### 1.2 上下文层

1. **伪造身份**：TS 任务用 `task_ts_<id>`、Action 任务用 `task_action_<id>` 冒充会话 ID，通知、产物、事件都挂在不存在的会话上；Pipeline 写产物时把 `nodeRunId` 传进 `sessionId` 参数。
2. **`emit` 名存实亡**：以伪造的会话 ID 往 EventHub 发自定义事件，序号从 store 读出后自增，可能和真实会话冲突；没有订阅方，项目代码也没用。
3. **只在任务里能用的方法挂在所有 Action 上**：`getTaskState` / `updateTaskState` 在非任务上下文里调用会抛错。
4. **任务状态有多种写法**：读有 `ctx.state` 快照、`getState()`、`getTaskState()`；写有 `updateState()` 和返回 `{ state, mergeState }`。
5. **缺依赖时静默跳过**：没有 outbox 时 `notify` 打一条 info 日志当作成功；没有 EventHub 时 `emit` 什么也不做；`logger` 缺省 `new Logger()`。根源是依赖全部可选，外加七个 `onX` 测试钩子。
6. **`workdir` 含义不一**：TS 任务里是 `projects/<id>/` 配置目录，Pipeline 里是 run 的 worktree，Action 里有时是会话 worktree、有时是配置目录。
7. **命名歧义**：`dispatchTask` 实际是开 Agent 会话，而"task"在本项目指定时任务；并且它强制使用项目默认运行时和模型。
8. **`ActionRegistry.execute` 接收 `ActionContext | CreateActionContextParams`**，靠 `typeof notify === "function"` 鸭子类型区分。
9. **`renderPrompt` 只有任务有**，Pipeline 代码节点拿不到。

接下来要做的项目 Hooks（设计 15）如果再加一个 `HookContext`，就是第四份实现。本设计先把模型理顺，Hooks 在此基础上实现。

---

## 2. 目标与非目标

### 目标

- **一个项目上下文 `ProjectContext`**：项目级能力只有一份实现，由 `ProjectRuntime.createContext(origin, ...)` 唯一构造。
- **调用方是显式的 `Origin`**：归属、审计、通知来源、产物归属、`createdBy`、日志字段和 trace 属性都由它决定，不再伪造会话 ID、不再推断 scope。
- **各类上下文在 `ProjectContext` 上扩展专属能力**：任务、Pipeline 节点、Agent 工具、Hook，用组合而非类继承。
- **能力在上下文，Action 降级为"工具"**：工具只是把能力暴露给 LLM 的适配层（schema、描述、可用条件）。
- **项目模块统一用 `define*` 默认导出**：`defineTask`、`definePipeline`、（设计 15 的）`defineHook`。
- **依赖必填，失败显式**：不再有静默跳过的能力。
- **Agent 看到的工具名不变**：`send_notification`、`dispatch_agent_task`、`update_task_state`、`pipeline_*` 等已经写进项目提示词，保持原名和参数。

### 非目标

- 不实现 Hooks，只为其提供 `HookContext` 的位置（见设计 15）。
- 不支持项目自定义工具（`tools/*.ts`）。模型就绪后再单独设计。
- 不改 Pipeline 代码节点的返回值（`PipelineTsResult` 的 next / prev / request_confirmation / fail）。
- 不改运行时适配层的协议，只替换它们拿到的工具上下文。
- 不做旧 API 兼容层。这是个人项目，`projects/` 下的代码和测试随本次一起迁移。

---

## 3. 详细技术设计

### 3.1 `Origin`：谁在调用

```ts
// src/context/origin.ts
export type Origin =
  | { readonly kind: "session"; readonly sessionId: string; readonly turnId?: string }
  | { readonly kind: "task"; readonly taskId: string; readonly executionId: string }
  | { readonly kind: "pipeline"; readonly runId: string; readonly nodeId: string; readonly nodeRunId: string }
  | { readonly kind: "hook"; readonly hookId: string; readonly deliveryId?: string };
```

由 `Origin` 决定的行为集中在一处（`createContext`），各类上下文不再各自处理：

| 用途 | session | task | pipeline | hook |
| --- | --- | --- | --- | --- |
| 通知来源 / 产物归属 | 会话 ID | 执行 ID | node run ID | hook ID + 投递 ID |
| `pipelines.start` 的 `createdBy` | `session:<id>` | `task:<id>` | `pipeline:<runId>` | `hook:<id>` |
| `sessions.start` 记录的来源 | `sourceSessionId` | `sourceTaskId` | `sourceRunId` | `sourceHookId` |
| 日志字段 / span 属性 | `session.id`、`turn.id` | `task.id`、`task.execution_id` | `pipeline.run_id`、`pipeline.node_id` | `hook.id` |

### 3.2 `ProjectContext`：项目级能力

```ts
// src/context/types.ts
export interface ProjectContext {
  readonly project: {
    readonly id: string;
    /** projects/<id>/ 配置目录。不是代码仓库。 */
    readonly dir: string;
    readonly env: Readonly<Record<string, string>>;
    readonly vars: Readonly<Record<string, ProjectVarValue>>;
  };
  readonly origin: Origin;
  /** 已带上项目和 origin 字段，并继承当前 trace。 */
  readonly logger: Logger;
  /** 必有。任务超时、节点取消、Turn 中断、请求结束都通过它传达。 */
  readonly signal: AbortSignal;

  notify(message: NotificationMessage, options?: NotificationOptions): Promise<void>;

  readonly artifacts: {
    create(params: { kind: string; content: string | Uint8Array; contentType?: string }): Promise<ArtifactRecord>;
  };

  readonly mcp: {
    call<T = unknown>(server: string, tool: string, args?: Record<string, unknown>, options?: McpToolCallOptions): Promise<McpToolResult<T>>;
    list(server: string, options?: McpToolCallOptions): Promise<readonly McpToolInfo[]>;
  };

  readonly sessions: {
    /** 新建一个 Agent 会话并提交第一个 Turn。不指定时用项目默认的运行时和模型。 */
    start(params: {
      title: string;
      prompt: string;
      runtime?: string;
      model?: string;
      reasoningEffort?: ReasoningEffort;
      metadata?: Record<string, unknown>;
    }): Promise<{ sessionId: string; turnId: string }>;
  };

  readonly pipelines: {
    start(params: StartPipelineRunParams): Promise<StartPipelineRunResult>;
    /** 按 externalKey 定位 run，没有则返回 null。 */
    find(query: { pipelineId: string; externalKey: string }): Promise<PipelineRunRecord | null>;
    /** 唤醒 run 中处于 waiting 的节点，立即重新执行其 waitUntil 检查。 */
    signal(query: { runId: string } | { pipelineId: string; externalKey: string }): Promise<{ woken: boolean }>;
  };

  /** 用 project / vars / now 以及各 origin 的专属变量渲染提示词模板。 */
  render(template: string, extra?: Readonly<Record<string, unknown>>): string;
}
```

与现状的差别：

- 去掉 `emit`、`invokeAction`、`service()` / `requireService()`、`getTaskState` / `updateTaskState`、`workdir`。
- `dispatchTask` 改为 `sessions.start`，并允许指定运行时、模型和推理强度。
- `startPipelineRun` 并入 `pipelines`，新增 `find` 和按 `externalKey` 的 `signal`。`PipelineStore.findRunByExternalKey` 已存在。
- `callMcpTool` / `listMcpTools` 并入 `mcp`。
- `createArtifact` 并入 `artifacts.create`，归属由 `origin` 决定。

### 3.3 各类上下文

```ts
export interface TaskContext<S extends object = Record<string, unknown>> extends ProjectContext {
  readonly origin: Extract<Origin, { kind: "task" }>;
  readonly task: { readonly id: string; readonly name: string; readonly cron: string; readonly timezone?: string };
  /** 任务的增量状态。唯一的读写方式。 */
  readonly state: {
    get(): Readonly<S>;
    set(next: S): void;
    merge(patch: Partial<S>): void;
  };
}

export interface NodeContext<TData = Readonly<Record<string, unknown>>> extends ProjectContext {
  readonly origin: Extract<Origin, { kind: "pipeline" }>;
  readonly run: { readonly id: string; readonly pipelineId: string; readonly branchName?: string };
  readonly node: { readonly id: string; readonly attempt: number };
  readonly data: TData;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly rework?: PipelineReworkInfo;
  /** run 的 Git worktree。 */
  readonly workspace: string;
  step<T>(key: string, fn: () => Promise<T> | T): Promise<T>;
  waitUntil<T = true>(key: string, options: PipelineWaitUntilOptions, check: () => Promise<T | false> | T | false): Promise<T>;
  readonly history: {
    context(): Promise<PipelineGlobalContextView>;
    list(filter?: PipelineHistoryFilter): Promise<readonly PipelineHistoryEntrySummary[]>;
    get(query: PipelineHistoryQuery): Promise<PipelineActionRecord | null>;
  };
}

export interface ToolContext extends ProjectContext {
  readonly origin: Extract<Origin, { kind: "session" }>;
  readonly session: { readonly id: string; readonly turnId?: string; readonly workspace: string };
  /** 会话由任务或 Pipeline 节点发起时存在；update_task_state、pipeline_* 通过它工作。 */
  readonly owner?: TaskOwner | PipelineOwner;
}

export type TaskOwner = { readonly kind: "task"; readonly task: TaskContext["task"]; readonly state: TaskContext["state"] };
export type PipelineOwner = { readonly kind: "pipeline"; readonly runId: string; readonly nodeId: string; readonly nodeRunId: string };

// 设计 15：HookContext extends ProjectContext，origin 为 hook，另带 delivery 信息。
```

`workspace` 只出现在确实存在 worktree 的地方（会话、Pipeline run）。TS 任务没有代码仓库的 worktree，只有 `project.dir`，这与现状一致，只是不再用同一个 `workdir` 名字掩盖差异。

`ToolContext.owner` 在创建会话时就已确定：Pipeline 的 Agent 节点、Markdown Agent 任务创建会话时把 owner 写入会话记录，工具上下文创建时读出。`pipeline_*` 不再通过 `sessionId` 反查 node run，`update_task_state` 不再依赖 `taskKey` 字段。

### 3.4 构造：一个工厂，组合而非继承

```ts
// ProjectRuntime
createContext(origin: Origin, options: { signal: AbortSignal; traceContext?: Context }): ProjectContext & AsyncDisposable;
```

各类上下文用"展开加字段"组合；少数需要改变行为的地方包一层，通过 `base` 调用原实现：

```ts
await using base = runtime.createContext({ kind: "task", taskId, executionId }, { signal });
const ctx: TaskContext = { ...base, origin: base.origin, task, state: taskState };
```

不用类继承的原因：

1. 用户代码常写 `const { notify, logger } = ctx`。类方法挂在原型上，解构后 `this` 丢失；现在的上下文是对象字面量加箭头函数，解构安全。
2. 对象展开只复制自身属性，类方法会丢失，扩展只能继承，没法组合。
3. 子类无法删除能力。各类上下文之间真正的差异几乎都是"归属"这种数据，已由 `origin` 参数表达，没有需要子类重写的行为。

工厂统一负责：

- **依赖必填**：`createContext` 从 `ProjectRuntime` 取 outbox、artifact store、MCP 配置、Pipeline 引擎，任何一个缺失都是构造错误，而不是运行时静默跳过。
- **资源生命周期**：MCP 连接池按上下文懒创建，在任务、节点、Turn 或 Hook 结束时通过 `AsyncDisposable` 释放一次。
- **Tracing**：能力调用继承 `traceContext`（设计 14 的显式父 context），span 属性来自 `origin`。
- **日志**：`logger` 带上 `projectId` 和 origin 字段；TS 任务的日志缓冲（写入 `task_execution_logs`）作为 TaskContext 的 logger 实现，不进入 `ProjectContext`。

### 3.5 工具（原 Action）

```ts
// src/tools/types.ts
export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly input: z.ZodType<TInput>;
  /** 当前会话是否提供这个工具。缺省为总是提供。 */
  readonly when?: (ctx: ToolContext) => boolean;
  run(input: TInput, ctx: ToolContext): Promise<TOutput>;
}

export function defineTool<TInput, TOutput>(definition: ToolDefinition<TInput, TOutput>): ToolDefinition<TInput, TOutput>;
```

- `run` 直接返回结果或抛错；转成运行时需要的工具结果、写审计、建 span 都由 `ToolRegistry` 负责，不再有 `ActionResult` 外壳。
- `when` 取代 `ActionScope`：

| 工具（名字不变） | 新实现 | `when` |
| --- | --- | --- |
| `send_notification` | `ctx.notify` | 总是 |
| `create_artifact` | `ctx.artifacts.create` | 总是 |
| `dispatch_agent_task` | `ctx.sessions.start` | 总是 |
| `list_project_pipelines`、`dispatch_pipeline_run` | `ctx.pipelines` | `owner?.kind !== "pipeline"` |
| `update_task_state` | `ctx.owner.state` | `owner?.kind === "task"` |
| `pipeline_next` / `prev` / `request_confirmation` / `fail` / `get_context` / `list_history` / `get_history_detail` | Pipeline 引擎，按 `owner` 定位 node run | `owner?.kind === "pipeline"` |
| `schedule_job`、`cancel_job` | 新增 `ctx.session` 范围内的定时 Turn 能力（取代直接写 store） | `owner === undefined` |

`schedule_job` 的能力只对会话有意义，放在 `ToolContext.session` 上（如 `session.scheduleTurn(...)`），不进入 `ProjectContext`。

### 3.6 项目模块

```ts
// projects/<id>/tasks/<name>.ts
export default defineTask({
  name: "GitHub issue sync",
  cron: "*/30 * * * *",
  timeoutMs: 300_000,
  async run(ctx) {
    const since = ctx.state.get().lastCheckedAt;
    // ...
    ctx.state.merge({ lastCheckedAt: new Date().toISOString() });
  },
});

// projects/<id>/pipelines/<name>.ts —— 不变，代码节点拿到的是 NodeContext
export default definePipeline({ ... });
```

- **TS 任务**：一个文件默认导出一个 `defineTask(...)`；需要多个任务时导出数组。去掉 `registerTask` 工厂写法和注册阶段的 `api.env`（运行时用 `ctx.project.env`）。任务 ID 默认取文件名。`run` 不再通过返回值写状态，统一用 `ctx.state`。
- **Markdown 任务**：只保留 Agent 提示词任务这一种，frontmatter 不变；去掉 script 和 action 执行器。
- **删除 `projects/<id>/executors/`** 机制。
- 状态的持久化时机沿用现状：执行结束时写入 `state_after`。

### 3.7 数据模型

| 表 | 变化 |
| --- | --- |
| `action_executions` → `tool_executions` | 去掉 `caller`、`task_key`；增加 `origin_kind`、`origin_id`，`session_id` / `turn_id` 只记录真实会话；`action_name` 改为 `tool_name` |
| `artifacts` | `session_id` 改为可空，只记录真实会话；增加 `origin_kind`、`origin_id` |
| `notification_deliveries` | 增加 `origin_kind`、`origin_id`；`session_id` 只记录真实会话 |
| `sessions` | 增加 `owner`（jsonb，`TaskOwner` / `PipelineOwner` 的持久化形式，不含 state） |

用 `drizzle-kit generate` 生成一个迁移。不迁移旧数据中伪造的会话 ID：开发数据直接重建。

相应地，`GET /api/v1/action-executions` 改为 `GET /api/v1/tool-executions`，过滤条件改为 `originKind` / `originId` / `sessionId` / `toolName`。Web 目前不使用这个接口。

### 3.8 错误语义

- 能力调用失败一律抛错，由调用方决定：任务和节点失败进入各自的失败流程；工具失败由 `ToolRegistry` 转为运行时的错误结果。
- `signal` 中止后，能力调用立即以 `AbortError` 失败。
- 不再存在"未配置就打日志当成功"的分支。

---

## 4. 配置说明

无 `config.yaml` 或 `project.yaml` 字段变化。项目目录约定变化：

| 路径 | 变化 |
| --- | --- |
| `projects/<id>/tasks/*.ts` | 默认导出 `defineTask(...)`（或其数组），不再导出工厂函数 |
| `projects/<id>/tasks/*.md` | 只支持 Agent 提示词任务 |
| `projects/<id>/pipelines/*.ts` | 不变；代码节点的 `ctx` 改为 `NodeContext` |
| `projects/<id>/executors/` | 删除 |

---

## 5. 实施阶段与测试计划

每个阶段单独提交，阶段结束时 `bun run check` 通过。

1. **上下文核心**：新增 `src/context/`（`Origin`、`ProjectContext`、`createContext`）。测试：各 origin 的通知来源、产物归属、`createdBy`、日志字段；依赖缺失时构造失败；`signal` 中止后能力调用失败；MCP 连接池在 dispose 时关闭。
2. **工具**：`src/actions/` 改为 `src/tools/`，`defineTool` 和 `ToolRegistry` 取代 `ActionDefinition` 和 `ActionRegistry`；内置工具按 3.5 重写；会话记录 `owner`；运行时适配层（Codex、Claude、Pi、ACP）改用 `ToolContext`。测试：`when` 在会话、任务会话、Pipeline 会话下的可用工具集合；工具名和参数与现在一致；审计记录 `origin`；`pipeline_*` 按 owner 定位 node run。
3. **TS 任务**：`defineTask` 和 `TaskContext`；去掉 `registerTask`、返回值写状态、script / action 执行器和 `executors/` 机制。迁移 `projects/` 下的 TS 任务。测试：状态 get / set / merge 与持久化；多任务数组导出；日志写入执行记录。
4. **Pipeline 代码节点**：`NodeContext` 取代 `PipelineTsRunContext`；节点获得 `sessions`、`pipelines`、`render`。迁移 `projects/example` 和 `docs/references/pipeline-sdk.md`。测试：`step` / `waitUntil` 行为不变；产物归属到 node run。
5. **数据模型与接口**：迁移、`tool_executions` 接口、Store 实现（Postgres 与 Memory）。测试：store 的新字段读写与查询过滤。
6. **Hooks**：按设计 15 的修订版在 `HookContext` 上实现。

实际验证：在 `agent-dev` 容器里用 shortlink 项目分别跑一次会话（Codex、Claude、Pi 各调用一次 `send_notification` 和 `dispatch_agent_task`）、一个 TS 任务和一个包含代码节点的 Pipeline，检查审计、通知和产物的 origin 字段。

---

## 6. 备选方案与取舍

| 方案 | 结论 | 原因 |
| --- | --- | --- |
| 抽象基类 + 子类继承 | 放弃 | 解构丢 `this`、展开丢方法、子类无法删除能力；差异本质是数据，用 `origin` 参数表达即可 |
| 保留 `ActionContext` 作为基础，任务和节点继续在它上面包装 | 放弃 | 它要求 `sessionId`，导致伪造身份；它挂着只在任务里有效的方法和服务定位器 |
| 保留 `invokeAction`，代码里也通过 Action 调能力 | 放弃 | 字符串名、LLM 形状的参数、结果外壳，都比直接调用能力差；项目也不能定义 Action |
| 工具改名（如 `notify`、`start_session`） | 放弃 | 工具名已写进项目提示词，改名只带来迁移成本 |
| 每类上下文各自保留实现，只统一接口类型 | 放弃 | 类型一致但行为仍会各自漂移，现状的 `notify` / `createArtifact` 差异就是这样产生的 |
| 保留 `emit` 并补上订阅方 | 暂不做 | 目前没有使用场景；需要时再按真实事件设计 |

---

## 7. 实现说明

阶段 1–5 已实现（`b0af3da`、`7efb5a2`、`7f4c585`、`b314245`），与上文有以下出入，以实现为准：

| 项 | 上文 | 实现 |
| --- | --- | --- |
| 上下文的释放 | `createContext` 返回 `ProjectContext & AsyncDisposable` | 返回 `ScopedContext { context, dispose() }`，`dispose` 不出现在交给用户代码的对象上 |
| `Origin` 字段 | task 只有 `taskId`；pipeline 没有 `pipelineId` | task 另带 `taskKey`（任务引擎按它存状态）；pipeline 另带 `pipelineId`（`pipeline_next` 的输入取决于它） |
| 记录里的 origin | — | 存为 `OriginRef { kind, id }`：session 用会话 ID，task 用执行 ID，pipeline 用 node run ID，hook 用投递 ID（没有则用 hook ID）。Pipeline run 级别的完成/失败通知是系统通知，不带 origin |
| `ProjectContext.pipelines` | `start` / `find` / `signal` | 另加 `list()`，`list_project_pipelines` 需要它 |
| 工具的 `when` | `when(ctx: ToolContext)` | `when(site: ToolSite)`，`site` 只有 `owner`：列出工具时还没有调用上下文 |
| 运行时拿到的工具 | “替换它们拿到的工具上下文” | `RuntimeContext.tools: SessionTools { specs, call }`。运行时不再接触注册表、scope 和参数覆盖；`pipeline_next` 的节点专属输入由 `ProjectRuntime` 放进 `specs`，并用它校验调用 |
| 定时唤醒 | `session.scheduleTurn(...)` | `ToolSession.schedule(...)` / `cancelSchedule(...)` |
| 任务会话里启动的 Pipeline | — | 工具调用的 origin 是会话，所以 `createdBy` 是 `session:<id>`；TS 任务和代码节点直接启动的才是 `task:<id>` / `pipeline:<runId>` |
| `tool_executions` | `origin_kind` / `origin_id` | 工具调用总来自会话，所以是 `session_id`（必填）、`turn_id`，加上会话的 `owner_kind` / `owner_id` |
| `sessions.owner` | `TaskOwner` / `PipelineOwner` 的持久化形式 | 直接存 `TaskOrigin` / `PipelineOrigin`；`TaskOwner`、`PipelineOwner` 是工具调用时在它上面加上任务状态和节点操作 |
| TS 任务的返回值 | — | `run` 返回的对象本身就是执行摘要（不再包一层 `summary`） |
| 迁移 | 一个迁移，不迁移旧数据 | 两个迁移（`0007` 产物和通知的 origin，`0008` 工具审计和会话 owner），并按 ID 前缀迁移了旧数据：开发库里已有的产物、通知、审计和 Pipeline 会话都保留下来 |

实际验证在 `agent-dev` 的 shortlink 项目上做了：Codex 和 Pi 各调用了 `send_notification` 与 `dispatch_agent_task`，审计、通知和派生会话都记录了正确的会话；一个临时 TS 任务连续执行两次，状态、产物归属（`task:<执行 ID>`）和日志都正确。Claude 因容器里未登录没有跑通；Pipeline 代码节点没有在线上验证（加载新 Pipeline 需要重启，且会在开发库留下 revision 和 run），由端到端测试覆盖。
