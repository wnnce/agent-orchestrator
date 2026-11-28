# Design 18: 拆分 ProjectRuntime

| Field | Value |
| --- | --- |
| **Status** | Accepted |
| **Target Module** | `src/project/`、`src/session/`、`src/task/`、`src/hooks/`，以及调用方 `src/app/`、`src/gateway/routes/`、`tests/` |
| **Date** | 2026-11-28 |

---

## 1. 背景与动机

`src/project/runtime.ts` 有 1879 行，`ProjectRuntime` 一个类承担了下面这些职责：

| 职责 | 主要方法 | 约行数 |
| --- | --- | ---: |
| 组装 | 构造函数：TaskEngine/Scheduler/Loader、ToolRegistry、PipelineEngine、两个任务执行器及其适配器 | 100 |
| 项目上下文与 Agent 工具 | `createContext`、`startSessionFor`、`sessionTools`、`toolSession`、`toolOwner` | 170 |
| 加载项目代码 | `start()` 里加载 tools、hooks、tasks，启动 pipeline | 60 |
| Session 生命周期 | `createSession`、改名/标题、`cleanupSession`/`closeSession`、`archivePipelineSession`、`bindExternal` | 300 |
| Turn 队列与执行 | `enqueueTurn`、`pump`、`runTurn`、`steer`/`interrupt`/`compact`/`approve`、`bounded` | 300 |
| Agent runtime 绑定 | `resolveRuntime`、`effectiveProjectFor`、`bindRuntimeSession`、`releaseRuntimeSession`、`context` | 180 |
| Runtime 事件处理 | `onRuntimeEvent`、`processRuntimeEvent`、`finishTurn` | 200 |
| 事件写入 | `emit`（每个 session 的序号与写入队列） | 50 |
| 空闲回收、定时 job、任务 | `manageSessionLifecycles`、`pollScheduledJobs`、`processDueScheduledJob`、`renderTaskPrompt`、`listTasks`、`runTask` | 300 |

具体问题：

1. **同一个 session 的状态散在 10 个 Map 里。** `activeTurns`、`pendingTurns`、`pumps`、`admissions`、`maintenance`、`closes`、`eventQueues`、`runtimeEvents`、`sessionSequences`、`boundSessions`。每条清理路径都要记得逐个删：`closeSession` 删了 3 个，`archivePipelineSession` 一个都没删。
2. **同一条规则写了三遍，而且不一致。** “用请求的 runtime；只有它是默认 runtime 时才继承项目的 model / reasoningEffort”：`createSession` 会 trim 并转小写，`effectiveProjectFor` 忽略大小写但不 trim，`bindRuntimeSession` 又单独写了 `resolved ? route.model : undefined`。
3. **close 和 archive 重复同一套停机流程。** 等 admission → 取消队列 → 停当前 turn → 限时等 pump → 释放 runtime session，两处各写一遍。
4. **`finishTurn` 一个函数做六件事**：结束 trace、持久化 turn、发事件、调用 entity hook、发通知、回调 pipeline engine。并且无论 `notifyOnTurnCompleted` 是否开启都会发 `notification.queued`，即使没有任何通知入队。
5. **死代码和重复 API。** 构造函数 14 个位置参数，15 个测试文件按位置传；`inheritedSkillsProject` 传入后从未使用；`getTaskExecutorRegistry`、`hub` getter 外部无人调用；`getSession` 与 `loadSession` 完全相同；`turn` 只是 `enqueueTurn` 的包装；`checkLifecycles` 只是转调私有方法；`createSession(metadata, source, override, options)` 把 title 藏在 `metadata` 里。
6. **代码放错模块。** `renderTaskPrompt` 和任务执行器的组装属于 `task/`；hook 的加载与分发属于 `hooks/`；定时 job 的创建藏在 `toolSession` 闭包里，轮询在文件末尾。
7. **定时 job 轮询有竞态。** 轮询由 `setInterval` 驱动，可以重叠；到期 job 串行处理，每个都 `waitForIdle`。一个长 turn 会卡住整个项目的其他到期 job；并且第 1 次轮询拿到 `[A, B]` 卡在 A 时，第 2 次轮询执行了 B，第 1 次跑完 A 后会按旧列表再执行一次 B。（`tests/scheduled-jobs.test.ts` 在旧实现上复现了重复执行。）

## 2. 目标与非目标

### 目标

- `ProjectRuntime` 只做组装和启停，自身不再含 session / turn / runtime 绑定逻辑。
- 一个 session 的执行期状态集中在一个对象里，创建、删除各只有一处。
- runtime / model / reasoningEffort 的解析只有一处。
- 各部分依赖单向，可以单独用假依赖做单测。
- 修掉 `notification.queued` 误发和定时 job 重复执行。

### 非目标

- 不改 HTTP API、事件类型、Store 接口和数据库 schema。
- 不改 `SessionEntity` / `SessionManager` 的模型（实体、hook、observer 保持原样）；只给 `SessionManager` 加一个按项目取实体的 `getOwned`。
- 不改 `PipelineEngine`、`TaskEngine`、`TaskLoader` 内部；只改它们与 runtime 之间的端口如何接线。任务文件仍在 list / run 时读取（loader 按 mtime 缓存），编辑后无需重启。
- 不保留旧方法名做兼容；调用方一次性迁移。

## 3. 详细技术设计

### 3.1 模块划分

| 文件 | 类 | 职责 | 行数 |
| --- | --- | --- | ---: |
| `src/session/events.ts` | `SessionEvents` | 写事件：每个 session 串行写入、分配序号；transient 事件只发布不落库 | 80 |
| `src/session/workspaces.ts` | `SessionWorkspaces` | session 的工作目录：创建、取路径、turn 前准备（缺失时重建）、删除 | 59 |
| `src/session/agents.ts` | `AgentRuntimes` | runtime 池、runtime/model/effort 解析、bind/resume/release、构造 `RuntimeContext` | 249 |
| `src/session/turns.ts` | `SessionTurns` | `SessionSlot`、队列与 pump、runtime 事件、结束 turn；submit/steer/interrupt/compact/approve | 639 |
| `src/session/lifecycle.ts` | `SessionLifecycle` | create/get/rename/close/archive/bindExternal、事件与产物读取、空闲回收、启动对账 | 341 |
| `src/session/scheduled-jobs.ts` | `ScheduledJobs` | agent 给自己 session 定的延时唤醒：schedule/cancel/hasPending/poll | 211 |
| `src/session/turn-trace.ts` | `TurnTrace` | 从 `src/project/` 移来，内容不变 | 152 |
| `src/project/agent-tools.ts` | `AgentTools` | 给 session 的 agent 提供的工具，绑定到调用它的 session | 127 |
| `src/task/project-tasks.ts` | `ProjectTasks` | 任务引擎、调度器、两个执行器的组装；list/run/reload/renderPrompt | 137 |
| `src/hooks/registry.ts` | `ProjectHooks` | hook 的加载、列出、分发 | 52 |
| `src/project/runtime.ts` | `ProjectRuntime` | 组装上面这些，`createContext`，start/stop | 385（原 1879） |

`ProjectRuntime` 里有 ~200 行是构造函数的接线（包括给 `PipelineEngine` 和任务执行器的两个端口适配），剩下是 `createContext`、`startSessionFor`、start/stop。

### 3.2 依赖方向

```
ProjectRuntime ──组装──▶ SessionLifecycle ──▶ SessionTurns ──▶ AgentRuntimes ──▶ SessionEvents
                    │                             ▲   └──▶ SessionWorkspaces
                    ├──▶ ScheduledJobs ───────────┘
                    ├──▶ ProjectTasks、ProjectHooks、PipelineEngine、ToolRegistry
                    └──▶ AgentTools（ToolRegistry、createContext、SessionTurns.activeTurn、ScheduledJobs、TaskEngine、PipelineEngine）
```

反向调用都在构造时用回调注入，被调方不知道调用方是谁：

- `AgentRuntimes` 构造 `RuntimeContext` 时需要工具和事件出口：`toolsFor` 接到 `AgentTools.forSession`，`onEvent` 接到 `SessionTurns.handleRuntimeEvent`。两个回调里引用的对象在 `AgentRuntimes` 之后才建好，回调调用时都已就绪。
- `SessionLifecycle` 的空闲回收要知道有没有待执行的唤醒：`hasPendingJobs` 接到 `ScheduledJobs.hasPending`。
- turn 结束要通知 pipeline engine：`SessionTurns` 的 `onTurnFinished` 由 `ProjectRuntime` 接收，只把 `source === "pipeline"` 的 session 转给 `pipelineEngine.onSessionTurnFinished`。

`SessionTurns` 和 `SessionLifecycle` 都通过 `SessionManager.getOwned(id, projectId)` 取实体（不属于本项目时抛 `SESSION_NOT_FOUND`）。

### 3.3 `AgentRuntimes`

```ts
interface AgentSettings {
  readonly runtime: AgentRuntime;
  readonly model?: string;
  readonly reasoningEffort?: string;
}

function normalizeRuntimeName(name?: string): string | undefined; // trim + 小写；空串和 "unknown" 视为未指定

class AgentRuntimes {
  get default(): AgentRuntime;
  /** 新 session 用；请求的 runtime 不可用时抛 ValidationError。 */
  settingsFor(request?: AgentRequest): AgentSettings;
  /** 已存 session 用；记录的 runtime 不可用时回落到默认 runtime 和项目默认 model。 */
  settingsForRoute(route: SessionRoute): AgentSettings;
  start(sessionId, workspacePath, settings, owner): Promise<string>;
  /** 让 runtime 持有该 session，本进程内最多 resume 一次；必要时新开并发 session.runtime_reset。 */
  bind(entity, workspacePath): Promise<{ runtimeSessionId; runtime; context }>;
  forRoute(route, workspacePath): { runtime; context };
  runtimeFor(route): AgentRuntime;
  release(route, workspacePath): Promise<void>;
  forget(sessionId): void;
  stop(): Promise<void>;
}
```

解析规则只在私有的 `find(name)` 和 `settings(runtime, request)` 里：名字规范化后，匹配默认 runtime 的 name 或 type 就用默认 runtime，否则查缓存或用 `runtimeFactory` 创建；只有落到默认 runtime 时才继承项目的 model / reasoningEffort。`RuntimeContext.project.runtime` 由 `AgentSettings` 直接生成，不再另外判断一次是否默认 runtime。

“本进程里 runtime 持有哪些 session”（原 `boundSessions`）放在这里：只有 `start` / `bind` 加入，`release` / `forget` / `stop` 移除。

### 3.4 `SessionTurns`

#### `SessionSlot`

一个 session 在本进程中的执行期状态，替代原来的 `activeTurns`、`pendingTurns`、`pumps`、`admissions`、`maintenance`、`runtimeEvents` 六个 Map：

```ts
class SessionSlot {
  readonly queue: QueuedTurn[];
  active?: ActiveTurn;
  pump?: Promise<void>;                 // 依次跑队列里的 turn
  admission?: Promise<unknown>;         // 串行化入队前的检查和写入
  runtimeEvents?: Promise<void>;        // 串行化 runtime 回调的事件
  maintenance: boolean;                 // 空闲回收中，拒绝新 turn
  get busy(): boolean;                  // active / queue / pump / admission / maintenance 之一
  get idle(): boolean;                  // !busy && !runtimeEvents
}
```

`SessionTurns` 只持有 `Map<string, SessionSlot>`。slot 在需要时创建；准入、pump、事件链、回收各自结束时检查 slot 是否 idle，idle 就删除。Map 里只有正在发生事情的 session，关闭 session 时不需要逐个清理。

#### 接口

```ts
class SessionTurns {
  submit(sessionId, input, options?: { turnId?: string }): Promise<TurnRecord>;
  steer(sessionId, input): Promise<void>;
  interrupt(sessionId, turnId?): Promise<void>;
  compact(sessionId): Promise<void>;
  approve(sessionId, requestId, decision): Promise<void>;
  waitForIdle(sessionId): Promise<void>;
  activeTurn(sessionId): { turnId; traceContext } | undefined;
  isBusy(sessionId): boolean;
  /** 在 session 空闲时做回收，期间拒绝新 turn；session 忙则什么都不做。 */
  maintain(sessionId, operation): Promise<void>;
  /** 停掉 session 里的一切：取消排队、打断当前 turn（超时则本地判为 interrupted）、限时等 pump。 */
  quiesce(sessionId): Promise<void>;
  handleRuntimeEvent(sessionId, event): Promise<void>;
  /** 此后拒绝新 turn；正在跑的 turn 继续跑完。 */
  stopAccepting(): void;
  /** 取消排队、停 runtime、把仍在跑的 turn 判为 failed、等 pump。 */
  stop(): Promise<void>;
}
```

#### 结束 turn

`finishTurn` 依次：结束 trace → 持久化状态 / usage / error → 发 `turn.<status>` → 调用 `entity.notifyTurnCompleted` → `notifyFinished`（仅当 `project.notifyOnTurnCompleted` 开启：入队通知，然后发 `notification.queued`）→ 移除 active 并 resolve → 未在停止中时调用 `onTurnFinished`（不等待）。

turn 通知在 `SessionTurns` 内同步完成，`waitForIdle` 返回时通知已入队；只有 pipeline 这个外部反应走不等待的回调，因为它可能 archive 这个 session 或再排一个 turn，两者都要等 session 空闲。`TurnFinished.output` 取 turn 内最后一条 `agent.message.completed` 的文本，不再回查 Store。

### 3.5 `SessionLifecycle`

```ts
interface CreateSessionParams {
  readonly title?: string;
  readonly source?: string;               // 默认 "api"
  readonly runtime?: SessionRuntimeOverride;
  readonly owner?: SessionOwner;
  readonly workspacePath?: string;        // pipeline 共享 worktree；不给就新建
  readonly metadata?: Record<string, unknown>;
}

class SessionLifecycle {
  create(params?): Promise<SessionRoute>;
  get / rename / setGeneratedTitle / bindExternal;
  events / artifacts / artifact / readArtifact;
  /** 删除 worktree；默认从 Store 删除，retain 时保留为 closed。并发调用共享同一次关闭。 */
  close(sessionId, options?: { retain?: boolean }): Promise<void>;
  /** 只读归档，保留 worktree（pipeline 共享）。 */
  archive(sessionId, reason): Promise<void>;
  sweepIdle(): Promise<void>;
  reconcile(): Promise<void>;
}
```

- `close` 和 `archive` 都先 `turns.quiesce()`，再各自处理 runtime 释放、worktree、状态和事件。`close` 最后 `events.forget()`、`sessions.remove()`。
- `title` 是显式参数；`metadata.title` 仍会写入，兼容读取 metadata 的地方。
- `deleteFromStore: false` 的双重否定改为 `retain: true`。
- `sweepIdle` 对每个 session 用 `turns.maintain()` 包住，代替原来散落的忙碌判断。
- 是否允许无仓库创建 session 由 `allowWithoutRepository` 告知（全局项目），`session/` 不依赖 `project/global.ts`。

### 3.6 `ScheduledJobs`

```ts
class ScheduledJobs {
  schedule(sessionId, turnId, job): Promise<ScheduledJobRecord>;
  cancel(sessionId, nameOrId): Promise<boolean>;
  hasPending(sessionId): Promise<boolean>;
  /** 处理 asOf 时到期的 job 并等它们结束；各 job 独立执行。 */
  poll(asOf?): Promise<void>;
  /** 停止轮询，等正在执行的 job 结束（它们的 turn 必须能结束）。 */
  stop(): Promise<void>;
}
```

- **挑选是单飞的。** `poll` 共享同一次 `pickUp`：列出到期 job，逐个检查守卫（session 已结束 → `session_closed`；已有更新的 turn → `stale_turn_superceded`），通过的标为 `RUNNING` 后启动。下一次挑选开始时，上一次挑中的 job 已经不是 `PENDING`，不会再被列出。
- **执行是独立的。** 每个 job 的“提交 turn → 等空闲 → 写结果”是单独的 promise，记在 `running` 里；一个长 turn 不影响其他 session 的 job。
- 依赖只要 `Pick<SessionTurns, "submit" | "waitForIdle">`，测试用假实现即可。

### 3.7 `AgentTools`、`ProjectTasks`、`ProjectHooks`

- `AgentTools.forSession(sessionId, workspacePath, owner)`：原 `sessionTools` / `toolOwner`。`AgentTools.session(origin, workspace)`：原 `toolSession`，`schedule` / `cancelSchedule` 转给 `ScheduledJobs`。
- `ProjectTasks` 持有 `engine`、`scheduler`，组装两个任务执行器；`list()` 读任务文件（loader 按 mtime 缓存，编辑即生效），`run()`、`reload()`（读文件并重排调度）、`renderPrompt()`、`stop()`（停调度并 drain）。agent 任务需要的“建 session / 跑 turn / 关 session”由构造参数 `sessions` 注入。
- `ProjectHooks(projectId, createContext, logger)`：`load(projectDir)`、`list()`、`handle(hookId, request)`。

### 3.8 `ProjectRuntime`

```ts
interface ProjectRuntimeDeps {
  project; store; agentRuntime; workspaces; artifacts;
  notifications?; logger?; eventHub?; sessionManager?;
  runtimeFactory?; pipelineEventHub?; mcpClientFactory?; tools?;
  queueLimit?; controlTimeoutMs?; scheduledJobPollIntervalMs?;
}

class ProjectRuntime {
  readonly project: ProjectConfig;
  readonly sessionManager: SessionManager;
  readonly sessions: SessionLifecycle;
  readonly turns: SessionTurns;
  readonly scheduledJobs: ScheduledJobs;
  readonly tasks: ProjectTasks;
  readonly pipelines: PipelineEngine;
  readonly pipelineEvents: PipelineEventHub;
  readonly hooks: ProjectHooks;
  readonly tools: ToolRegistry;
  readonly agentTools: AgentTools;

  constructor(deps: ProjectRuntimeDeps);
  createContext(origin, options): ScopedContext;
  listSkills(): Promise<ProjectSkill[]>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

`ProjectRuntime` 不做转发，调用方直接用各部分。每个路由仍然只调一个方法，[Design 17](../17-gateway-application-services/README.md) 的路由规则不受影响。

两个周期任务（空闲回收 60s、定时 job 轮询默认 30s）的定时器由 `ProjectRuntime` 持有，各部分只提供一次性的 `sweepIdle()` / `poll()`。

- `start()`：`sessions.reconcile()` → 启动两个定时器 → 加载项目工具和 `hooks.load()`（非全局项目）→ `tasks.reload()` → `pipelines.start()`（非全局项目）。
- `stop()`：清定时器 → `turns.stopAccepting()` → `pipelines.stop()` → `tasks.stop()` → `notifications.drain()` → `turns.stop()` → `scheduledJobs.stop()`。正在跑的 turn 可以在任务和 pipeline 收尾期间跑完；之后 runtime 被停掉，仍在跑的 turn 判为 failed，等待它们的定时 job 随之结束。

### 3.9 调用方迁移

| 原来 | 现在 |
| --- | --- |
| `new ProjectRuntime(project, store, runtime, workspaces, artifacts, …)` | `new ProjectRuntime({ project, store, agentRuntime, workspaces, artifacts, … })` |
| `createSession(metadata, source, override, options)` | `sessions.create({ title, source, runtime, owner, workspacePath, metadata })` |
| `getSession` / `loadSession` | `sessions.get` |
| `renameSession` / `setGeneratedTitle` / `bindExternal` | `sessions.rename` / `setGeneratedTitle` / `bindExternal` |
| `cleanupSession(id)` / `cleanupSession(id, { deleteFromStore: false })` | `sessions.close(id)` / `sessions.close(id, { retain: true })` |
| `archivePipelineSession(id)` | `sessions.archive(id, "pipeline_node_completed")` |
| `events` / `listArtifacts` / `artifact` / `readArtifact` | `sessions.events` / `artifacts` / `artifact` / `readArtifact` |
| `checkLifecycles()` | `sessions.sweepIdle()` |
| `turn` / `steer` / `interrupt` / `compact` / `approve` / `waitForIdle` | `turns.submit` / `steer` / `interrupt` / `compact` / `approve` / `waitForIdle` |
| `pollScheduledJobs(asOf)` | `scheduledJobs.poll(asOf)` |
| `listTasks` / `runTask` / `loadAndScheduleTasks` / `renderTaskPrompt` | `tasks.list` / `run` / `reload` / `renderPrompt` |
| `taskEngine` / `taskScheduler` | `tasks.engine` / `tasks.scheduler` |
| `listHooks` / `handleHook` | `hooks.list` / `hooks.handle` |
| `pipelineEngine` / `pipelineEventHub` | `pipelines` / `pipelineEvents` |
| 私有的 `sessionTools` / `toolSession`（测试用） | `agentTools.forSession` / `agentTools.session` |
| `hub`、`getTaskExecutorRegistry`、`inheritedSkillsProject`、任务引擎注入参数 | 删除 |

`PipelineSessionPort` 与 `AgentSessionRunner` 的接口不变。

### 3.10 错误与 tracing

错误类型和错误码不变。`TurnTrace`（`invoke_agent` span）以及 `workspace.prepare`、`runtime.bind_session` 两个子 span 的名字和嵌套不变，分别落在 `SessionTurns.runTurn` 里。

## 4. 配置说明

无配置变更。原 `SessionExecutionOptions` 的字段并入 `ProjectRuntimeDeps`，默认值不变。

## 5. 实施记录与测试

按以下提交完成，每个提交 `bun run typecheck`、`bun run lint`、`bun test` 均通过：

1. `refactor: construct project runtime from a deps object`：构造函数改为 deps 对象，删除死代码。
2. `refactor: split session execution out of project runtime`：新增 §3.1 的各模块，`ProjectRuntime` 暂时保留转发方法，现有测试不改即全部通过，以此确认拆分不改行为。
3. `fix: record notification.queued only when a notification is queued`：新增回归测试（关闭通知时无 `notification.queued`、无投递）。
4. `fix: run each due scheduled job once and independently`：新增 `tests/scheduled-jobs.test.ts`（长 turn 不阻塞其他 session 的 job、重叠轮询每个 job 只跑一次、stop 等待正在执行的 job），这些测试在旧实现上失败。
5. `refactor: call project runtime parts instead of forwarding methods`：调用方（`src/app/`、`src/gateway/routes/`、`src/project/stats.ts`、测试）迁移到新 API，删除转发方法。
6. `test: cover agent runtime settings and idle session slots`：`tests/agent-runtimes.test.ts`（名字规范化、默认 runtime 继承项目 model、其他 runtime 不继承、不可用 runtime 报错、已存 session 回落）；slot 在 session 空闲后释放。

最终：517 个测试通过，`bun run build` 与 `cd web && bun run build` 通过。

## 6. 备选方案与取舍

- **保留 `ProjectRuntime` 上的转发方法（门面）。** 调用方不用改，但每个方法要写一遍转发，`ProjectRuntime` 仍有 40 多个公开方法，新功能还会往上堆。选择直接暴露各部分，调用方从名字就能看出操作属于哪一块。
- **把 turns 和 lifecycle 合成一个 `SessionService`。** 两者确实紧密（关闭要停 turn），但合起来近千行。拆开后两者只通过 `quiesce` / `maintain` 交互。
- **用事件总线连接各部分。** 能完全解耦，但调用顺序和错误传播变得隐式。这里只有四处反向调用，用显式回调就够了。
- **`SessionSlot` 合并进 `SessionEntity`。** `SessionEntity` 是持久化状态的唯一载体，会被 channel 和 event hub 观察；队列、pump、promise 只属于本进程执行期，混进去会让实体同时承担两种生命周期。保持分开。
- **turn 通知也改为不等待的回调。** 那样通知会在 `waitForIdle` 之后才入队，行为变了。turn 通知是 session 执行的一部分，留在 `SessionTurns` 内同步完成。
- **缓存任务列表，不再每次读磁盘。** 现有 loader 按 mtime 缓存并支持编辑后热加载（`tests/ts-task.test.ts` 覆盖），这是有意的行为，不改。
- **把 `SessionManager` 从 `ProjectRuntime` 上移走。** 它由 `main.ts` 创建并在所有项目、channel、event hub 之间共享；`ProjectRuntime` 上的引用只是同一个对象，测试用它调整实体状态。保留。
