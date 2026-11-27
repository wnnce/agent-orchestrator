# Design 17: 收薄 Gateway 路由与拆分入站编排

| Field | Value |
| --- | --- |
| **Status** | Accepted |
| **Target Module** | `src/gateway/`、`src/app/`（新增）、`src/channels/`、`src/project/`、`src/main.ts` |
| **Date** | 2026-11-27 |

---

## 1. 背景与动机

[Design 16](../16-project-context-and-tools/README.md) 理顺了项目内部执行侧，外部入口侧（HTTP / SSE / Webhook / 飞书 / 企微）还停留在混合状态：

| 模块 | 行数 | 实际承担的职责 |
| --- | ---: | --- |
| `src/gateway/service.ts` | 480 | 会话创建与项目路由、标题生成、提交 turn、入站去重、`/cancel` `/close` 指令，以及飞书/企微的流式推送、关闭监听和卡片文案 |
| `src/gateway/routes/sessions.ts` | 259 | 自己查 Store 定位会话所在项目；task 会话只读守卫；`agent-message` 产物过滤 |
| `src/gateway/routes/pipelines.ts` | 182 | 自己查 Store 定位 run / nodeRun 所在项目 |
| `src/gateway/routes/projects.ts` | 118 | 在路由闭包里持有 overview / metrics 缓存；计算项目工具的 `overridesBuiltin` |
| `src/gateway/routes/tasks.ts` | 105 | 合并调度状态；三处复制的 `limit + 1` 分页 |
| `src/gateway/server.ts` | 219 | HTTP 装配，同时构造 `GatewayService` 和飞书/企微 WS 适配器并管理它们的启停 |

具体问题：

1. **业务规则写在路由里，没法脱离 HTTP 测试，也会被其他入口绕过。** task 会话只读守卫只在 `POST /sessions/{id}/turns` 里。`POST /webhooks/{projectId}` 带 `sessionId` 时直接调 `GatewayService.submitTurn`，可以给 task 会话发消息。
2. **定位逻辑重复。** “按 sessionId / runId / nodeRunId 找到所在项目的 `ProjectRuntime`”在路由和 `GatewayService` 里各写一遍。
3. **`GatewayService` 里混着渠道专属代码。** 每接一个渠道就要往里面加 `if (channel === "...")`，飞书卡片文案也写在这里。
4. **HTTP 网关成了装配根。** `Gateway` 构造应用服务、持有 IM 渠道的生命周期，IM 渠道因此依赖 HTTP 网关存在。
5. **无活跃会话时伪造哨兵会话。** `/cancel` `/close` 找不到会话时，返回一个 `sessionId: "none"` 的假 `SessionRoute`。

## 2. 目标与非目标

### 目标

- 路由里的逻辑放到拥有这份数据的对象上：`ProjectManager` 负责跨项目定位，`ProjectRuntime` / `TaskScheduler` / 工具模块各管自己的数据。
- 只为跨多个对象、带业务规则的用例建应用服务，一共两个：`SessionService`、`InboundService`。
- 飞书/企微逻辑收回 `src/channels/`，每个渠道是一个实现 `Channel` 接口的对象。
- 装配移到 `src/main.ts`，`Gateway` 只负责 HTTP。
- 上述规则都能在不启动 Hono 的情况下做单测。

### 非目标

- 不改对外 HTTP 契约。唯一的行为变化是 webhook 也执行 task 会话只读守卫（修 bug）。
- 不新增 View / DTO 类型。响应结构由 `src/gateway/contracts/` 里的 zod schema 定义，路由负责把领域对象映射成这个结构。
- 不为只做转发的操作建 Service。路由可以直接调用 `ProjectManager`、`ProjectRuntime`、`Store` 的单个方法。
- 不改数据库 schema。

## 3. 详细技术设计

### 3.1 路由规则

> 路由可以直接调用 `ProjectManager` / `ProjectRuntime` / `Store` / 应用服务的**单个方法**，并把结果映射成 contract 定义的响应。凡是有分支、有组合、有业务规则的逻辑，放到路由之外一个可以直接调用的函数或类里。

17 初稿的“路由禁止引入 `Store` / `ProjectManager`”会逼出一大批只做转发的 Service 方法（`PipelineService` 的 12 个方法都是先定位 runtime 再调 `pipelineEngine`），所以不采用。

### 3.2 现有路由逻辑的去向

| 现在在路由里的逻辑 | 去向 |
| --- | --- |
| `requireSession` 后再 `projects.get(route.projectId)` | `ProjectManager.runtimeForSession(sessionId)` |
| `requireRuntimeForRun` / `requireRuntimeForNodeRun` | `ProjectManager.runtimeForPipelineRun(runId)` / `runtimeForNodeRun(nodeRunId)` |
| 过滤 `agent-message` 产物 | `ProjectRuntime.listArtifacts(sessionId, { includeInternal })`，默认不含内部产物 |
| 合并任务的调度状态 | 路由直接调 `TaskScheduler.isScheduled` / `getNextRun` 映射 |
| 项目工具列表与 `overridesBuiltin` | `describeProjectTools(registry)`（`src/tools/describe.ts`） |
| 三处 `limit + 1` 分页 | `fetchPage(limit, load)`（`src/persistence/pagination.ts`） |
| overview / metrics 的 TTL 缓存 | `ProjectStats`（`src/project/stats.ts`） |
| 会话不存在时 rename 返回 `false`，路由补抛 404 | `ProjectRuntime.renameSession` 直接抛 `SESSION_NOT_FOUND` |
| task 会话只读守卫、自动标题 | `SessionService.submitTurn` |
| 会话创建时的项目路由、运行时覆盖、外部绑定 | `SessionService.create` |

```ts
// src/project/manager.ts
class ProjectManager {
  /** 会话所在项目的运行时；会话不存在时抛 SESSION_NOT_FOUND。 */
  runtimeForSession(sessionId: string): Promise<ProjectRuntime>;
  runtimeForPipelineRun(runId: string): Promise<ProjectRuntime>;
  runtimeForNodeRun(nodeRunId: string): Promise<ProjectRuntime>;
}

// src/persistence/pagination.ts
/** 多取一行来判断是否还有下一页。 */
export async function fetchPage<T>(
  limit: number,
  load: (limit: number) => Promise<T[]>,
): Promise<{ items: T[]; hasMore: boolean }>;

// src/project/stats.ts
export class ProjectStats {
  constructor(deps: {
    projects: ProjectManager;
    store: Store;
    overviewTtlMs?: number; // 默认 3s
    metricsTtlMs?: number; // 默认 20s
  });
  overview(projectId: string, options: { limit: number; refresh: boolean }): Promise<ProjectOverviewData>;
  metrics(projectId: string, options: { range: ProjectMetricsRange; tz: string; refresh: boolean }): Promise<ProjectMetricsData>;
}
```

改造后的路由示例：

```ts
router.openapi(approvePipelineRunRoute, async (c) => {
  const { runId } = c.req.valid("param");
  const runtime = await deps.projects.runtimeForPipelineRun(runId);
  const run = await runtime.pipelineEngine.approveRun(runId, c.req.valid("json"));
  return c.json({ run }, 200);
});
```

### 3.3 应用服务（`src/app/`）

两个服务都面向“外部用户的输入”，HTTP、Webhook、IM 共用。

#### `SessionService`（`src/app/sessions.ts`）

```ts
export interface SessionServiceDeps {
  readonly projects: ProjectManager;
  readonly router: ProjectRouter;
  readonly titles: SessionTitleGenerator;
  readonly logger: Logger;
}

export class SessionService {
  /** 路由到项目（未指定时）、应用运行时覆盖、绑定外部会话、提交首个 turn、后台生成标题。 */
  create(input: CreateSessionInput): Promise<CreatedSession>;
  /** 外部用户提交 turn：task 会话只读守卫 + 无标题时后台生成标题。 */
  submitTurn(sessionId: string, input: string): Promise<TurnRecord>;
}
```

rename、steer、interrupt、compact、approve、事件、产物都只是单个 `ProjectRuntime` 方法，路由通过 `runtimeForSession` 直接调用，不经过 `SessionService`。

守卫只放在 `SessionService.submitTurn`，不放进 `ProjectRuntime.turn`：task 执行、会话派生、定时唤醒都会在内部调用 `turn`，它们给 task 会话发消息是合法的。

#### `InboundService`（`src/app/inbound.ts`）

```ts
export interface InboundServiceDeps {
  readonly store: Store;
  readonly projects: ProjectManager;
  readonly sessions: SessionService;
  readonly channels: readonly ChannelHooks[];
  readonly logger: Logger;
}

export class InboundService {
  /** 入队后立即返回，处理结果只记日志；供 IM 渠道使用。 */
  accept(envelope: InboundEnvelope): Promise<{ duplicate: boolean }>;
  /** 入队并等待处理结果；供 HTTP webhook 使用。 */
  handle(envelope: InboundEnvelope): Promise<InboundResult>;
  /** 停止接收并排空队列。 */
  stop(): Promise<void>;
}
```

处理流程（与现有行为一致）：

1. 文本为空抛 `ValidationError`。
2. 按外部会话查已有会话，`claimInboundMessage` 去重；重复消息直接返回。
3. `/cancel [turnId]`：中断已有会话的当前 turn，然后调 `hooks.afterCommand`。
4. `/close`：清理已有会话，然后调 `hooks.afterCommand`。
5. 普通消息：没有会话就用 `SessionService.create`（`submitQuery: false`）建一个，调 `hooks.beforeTurn` 拿到撤销函数，再 `SessionService.submitTurn`。
6. 第 3~5 步出错时，执行撤销函数并 `releaseInboundMessage`，让同一条消息可以重试。

`InboundResult.session` 改为可选：没有活跃会话时不再伪造 `sessionId: "none"` 的会话。

`MemoryInbox` 从 `src/gateway/inbox.ts` 移到 `src/app/inbox.ts`，`SessionTitleGenerator` 移到 `src/app/titles.ts`。

### 3.4 渠道（`src/channels/`）

```ts
// src/channels/types.ts
export type InboundCommand = "cancel" | "close";

/** 渠道把收到的消息交给谁。WS 适配器用 `.catch` 记录失败，所以返回 Promise。 */
export type InboundSink = (envelope: InboundEnvelope) => Promise<unknown>;

/** 入站处理过程中，渠道需要介入的时机。 */
export interface ChannelHooks {
  readonly id: ChannelId;
  /** turn 提交前调用（准备流式卡片、注册会话关闭监听）；返回的函数在提交失败时撤销这些准备。 */
  beforeTurn(envelope: InboundEnvelope, session: SessionRoute): () => void;
  /** 指令执行后调用，由渠道决定是否回执、回执什么。 */
  afterCommand(
    envelope: InboundEnvelope,
    command: InboundCommand,
    session: SessionRoute | undefined,
  ): Promise<void>;
}

/** 一个外部 IM 渠道：入站连接加上入站处理钩子。 */
export interface Channel extends ChannelHooks {
  start(onMessage: InboundSink): Promise<void>;
  stop(): Promise<void>;
}
```

- `FeishuChannel`（`src/channels/feishu/channel.ts`）持有 `FeishuClient`、`FeishuSessionStreamer`、`FeishuWSAdapter` 和会话关闭监听。`afterCommand("cancel")` 回执卡片；`/close` 的回执仍由会话销毁时的关闭监听发出。
- `WeComChannel`（`src/channels/wecom/channel.ts`）同理，持有 `WeComClient`、`WeComSessionStreamer`、`WeComWSAdapter`。
- `createChannels(config, deps)`（`src/channels/index.ts`）按配置创建已启用的渠道。
- `start(onMessage)` 接收消息出口，渠道和 `InboundService` 之间没有循环依赖：`InboundService` 只依赖 `ChannelHooks`，`main.ts` 用 `inbound.accept` 启动渠道。
- 新增渠道只需要实现 `Channel`，`InboundService` 不 import 任何具体渠道。

### 3.5 装配

```ts
// src/app/index.ts
export function createAppServices(deps: {
  config: AppConfig;
  store: Store;
  projects: ProjectManager;
  logger: Logger;
  channels?: readonly ChannelHooks[];
}): { sessions: SessionService; inbound: InboundService };
```

`src/main.ts` 的启动顺序：

1. 配置、日志、tracing、Store、`ProjectManager`。
2. `createChannels` → `createAppServices`。
3. `new Gateway({ config, logger, store, projects, sessions, inbound })` 并 `listen()`；各渠道 `start(inbound.accept)`。
4. 停机：HTTP server → `inbound.stop()`（停止接收并排空队列）→ 渠道 → `ProjectManager.stop()` → `Store.close()` → tracing。渠道放在排空之后停，因为排空中的消息还要通过渠道的 streamer 推送回复；排空期间 WS 新到的消息会被收件箱拒绝并由适配器记日志。

`Gateway` 只构造 HTTP 自己用的东西（`ProjectStats`、`RuntimeModelCatalog`、中间件、路由、静态资源），不再有 `start()` / `stop()`。

### 3.6 错误与 tracing

- 业务错误照旧由领域层或服务抛出（`NotFoundError`、`ForbiddenError`、`ConflictError`、`ValidationError`），由 `createOpenAPIApp()` 的错误处理映射为 HTTP 状态码。
- HTTP server span 留在 `Gateway` 中间件；`inbound <channel>` consumer span 留在 `InboundService`。

## 4. 配置说明

无配置变化。目录变化：

```text
src/
  app/
    index.ts        # createAppServices
    sessions.ts     # SessionService
    titles.ts       # 迁自 src/gateway/titles.ts
    inbound.ts      # InboundService
    inbox.ts        # 迁自 src/gateway/inbox.ts
  channels/
    index.ts        # createChannels
    types.ts        # + ChannelHooks / Channel / InboundCommand
    feishu/channel.ts
    wecom/channel.ts
  project/
    manager.ts      # + runtimeForSession / runtimeForPipelineRun / runtimeForNodeRun
    stats.ts        # ProjectStats
    stats-cache.ts  # 迁自 src/gateway/stats-cache.ts
  persistence/
    pagination.ts   # fetchPage
  tools/
    describe.ts     # describeProjectTools
  gateway/
    service.ts      # 删除
```

## 5. 实施阶段与测试计划

每个阶段单独提交，结束时 `bun run check` 通过。

1. **定位与归位。** 加 `runtimeFor*`、`listArtifacts` 过滤、`describeProjectTools`、`fetchPage`，sessions / pipelines / tasks / projects 路由改为调用它们。测试：`runtimeFor*` 找不到时的错误码、产物过滤、分页边界。
2. **`ProjectStats`。** 缓存从路由闭包移出。测试改为直接测 `ProjectStats`：缓存命中、`refresh` 绕过、未知项目。
3. **`SessionService`。** 从 `GatewayService` 拆出会话创建与提交 turn，守卫移入。测试：task 会话 `submitTurn` 抛 `TASK_SESSION_READ_ONLY`；webhook 带 task 会话 `sessionId` 返回 403。
4. **渠道与 `InboundService`。** 实现 `FeishuChannel` / `WeComChannel` / `InboundService`，删除 `src/gateway/service.ts`。测试：用假 `ChannelHooks` 覆盖去重、`beforeTurn` 撤销与 claim 释放、无会话时的 `/cancel` `/close`；现有飞书 `/close` 集成测试改用新对象。
5. **装配上移。** 新增 `createAppServices`，`Gateway` 改为注入依赖，`main.ts` 管理渠道生命周期。验证：`bun run check`、`bun run build`、`cd web && bun run build`。

## 6. 备选方案与取舍

| 方案 | 结论 | 原因 |
| --- | --- | --- |
| 17 初稿：5 个 Service + View 类型，路由禁止引用 `Store` / `ProjectManager` | 放弃 | View 类型与 zod contract 重复；大部分 Service 方法只是转发；按“避免碎文件”把 tool executions / scheduled jobs 塞进 `SessionService`，划分标准不清 |
| 守卫放进 `ProjectRuntime.turn` | 放弃 | 内部的 task 执行、会话派生、定时唤醒都通过 `turn` 给 task 会话发消息 |
| 每个渠道只提供钩子，WS 适配器另外管理 | 放弃 | 一个渠道的客户端、推送、关闭监听、入站连接是一体的，拆开后 `main.ts` 要分别构造再拼接 |
| `ProjectStats` 并入 `ProjectManager` | 放弃 | 缓存只为 Web 面板的轮询服务，放在运行时管理器里职责不清 |
