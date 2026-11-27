# Design 14: OpenTelemetry 链路追踪

| Field | Value |
| --- | --- |
| **Status** | Accepted |
| **Target Module** | `src/observability/`、`src/gateway/`、`src/project/`、`src/actions/`、`src/mcp/`、`src/task/`、`src/pipeline/`、`src/persistence/` |
| **Date** | 2026-11-27 |

---

## 1. 背景与动机

一次会话 Turn 或一条 Pipeline 跑了几分钟甚至失败时，现在看不出时间花在哪里：HTTP 入口、Worktree 准备、模型推理、Action 还是 MCP 调用。各模块的日志也没有统一的 `traceId`，接到 SLS、Jaeger、Tempo、Langfuse 等平台后无法把同一次请求的日志串起来。

本设计通过 OTLP/HTTP 接入 OpenTelemetry Tracing 来补上这两点。

## 2. 目标与非目标

### 目标

- 默认关闭。关闭时不注册任何 provider，业务代码里的 `@opentelemetry/api` 调用全部是空操作，也不需要额外的开关判断。
- 覆盖主要执行边界：HTTP API、飞书 / 企微消息、Agent Turn（含 tool、MCP、命令）、Action、MCP 客户端调用、定时任务、Pipeline 节点。
- 跨异步边界不断链，也不串链：排队的 Turn、任务和后台启动的 Pipeline 节点，都继续"把它放进队列的那条 trace"，不继承恰好启动后台循环的那个请求。
- 日志自动带 `traceId` / `spanId`；HTTP 响应带 `x-trace-id`。
- 兼容 Bun 和 `bun build` 单文件打包。

### 非目标

- 不引入 Node 自动埋点（`auto-instrumentations-node`），它依赖 Node 模块钩子，在 Bun 下不可靠。
- 不接 OTel Logs / Metrics SDK。日志仍是现有的单行 JSON，只是多了 trace ID。
- 默认不记录 prompt、模型输出、工具参数和命令行，它们可能含有凭证。

## 3. 技术设计

### 3.1 依赖

全部使用同一大版本（SDK 3.x / API 1.10），纯 JS 实现，没有原生模块：

| 包 | 用途 |
| --- | --- |
| `@opentelemetry/api` | 业务代码唯一依赖的 API |
| `@opentelemetry/sdk-trace` | `TracerProvider`、`BatchSpanProcessor`、采样器（3.x 起取代 `sdk-trace-base`） |
| `@opentelemetry/context-async-hooks` | `AsyncLocalStorageContextManager`，跨 `await` 传递上下文 |
| `@opentelemetry/core` | `W3CTraceContextPropagator` |
| `@opentelemetry/resources` | `service.name` 等资源属性，以及 `OTEL_SERVICE_NAME` 环境检测 |
| `@opentelemetry/exporter-trace-otlp-http` | OTLP/HTTP 导出 |

HTTP 中间件是自己写的，没有使用 `@hono/otel`。

### 3.2 模块划分

| 文件 | 职责 |
| --- | --- |
| `src/observability/tracing.ts` | 只依赖 API 的辅助函数：`withSpan`、`startSpan`、`captureTraceContext`、`withTraceContext`、`detached`、`activeTraceparent`、`linksTo`、`activeTraceIds` |
| `src/observability/tracing-setup.ts` | 唯一接触 SDK 的地方：`setupTracing(config)` 注册 provider、context manager、propagator，返回 `shutdown()` |
| `src/gateway/tracing.ts` | `/api/v1/*` 的 HTTP 中间件 |
| `src/project/turn-trace.ts` | `TurnTrace`：一个 Agent Turn 的 span，以及由运行时事件生成的子 span |

`tracer()` 每次都调用 `trace.getTracer()`，不缓存，保证总是拿到当前注册的 provider。测试会反复注册和移除 provider，缓存的 tracer 会指向已经失效的那个。

### 3.3 span 结构

```text
GET /api/v1/...                       (HTTP，继续调用方的 traceparent)
inbound feishu                        (飞书 / 企微消息)
└─ invoke_agent codex                 (一个 Turn，父级是把它放进队列的请求 / Action / 节点)
   ├─ workspace.prepare
   ├─ runtime.bind_session
   ├─ execute_tool <tool>             (运行时事件 tool.call.*、mcp_call.*)
   ├─ command                         (运行时事件 command.*，只记退出码)
   └─ action <name>                   (Agent 调用的编排器 Action)
task <taskKey>                        (父级是 dispatch 时的上下文；cron 触发时是新 trace)
mcp <server>.<tool>                   (TS 任务 / code 节点通过连接池调用 MCP)
pipeline.node <nodeId>                (每次启动节点都是一条新 trace，link 到创建这个节点运行的操作)
├─ workspace.prepare
└─ invoke_agent ... / code 节点内部的 action、mcp
```

span 名用路由模板、节点 ID、任务 key 这类数量有限的值，不放 runId、sessionId 这类随实例变化的 ID；后者作为属性记录。

### 3.4 异步边界：显式父级

AsyncLocalStorage 会把"创建异步资源时的上下文"带进之后的回调。项目里有几类长期存在的后台循环：会话的 Turn 泵、任务队列、cron 定时器，以及运行时的子进程或连接回调。如果放任隐式继承，后续工作会挂到"最初启动这个循环的那个请求"下面。所以这几处都显式指定父级：

| 边界 | 做法 |
| --- | --- |
| Turn 排队 | 入队时 `captureTraceContext()` 存进 `QueuedTurn`；`startPump` 用 `detached` 运行；`TurnTrace` 以存下的上下文为父级 |
| 运行时回调 | `onRuntimeEvent` 在 `withTraceContext(turn.context)` 里处理事件；`RuntimeContext.createActionContext` 把 `traceContext` 放进 `ActionContext`，`ActionRegistry.execute` 用它作为父级 |
| 任务队列 | `QueuedTask.traceContext` 在 `dispatch` 时记下，执行时作为父级；cron 回调用 `detached`，每次触发都是一条新 trace |
| Pipeline 节点启动 | `launch_node` 效果用 `detached` 在后台运行，节点 span 是 `root: true` |

### 3.5 Pipeline：一个节点一条 trace

一条 Pipeline Run 可能持续数天，中间还要等人工审批，不适合放进一条 trace。所以：

- 每次创建节点运行（`startRun`、状态机推进、打回、重试），引擎都把当时的 `traceparent` 写进新的 `pipeline_node_runs.traceparent`（迁移 `0006`）。不放进 `run.metadata`，因此不会进入 prompt，也不会混进用户数据。
- 每次启动节点都是一个新的根 span `pipeline.node <nodeId>`，用 span link 指向上面记录的 `traceparent`。自动推进时，link 指向上一个节点里的 Agent Turn 或 code 节点；人工审批时，link 指向审批请求的 HTTP span；新建 run 时，link 指向发起它的请求、任务或 Action。
- 所有节点 span 都带 `pipeline.run_id`。在追踪后端按这个属性就能查到一条 run 的全部 trace；整体进度仍以 Studio 为准。

### 3.6 Agent Turn（GenAI 语义约定）

`TurnTrace` 挂在 `ActiveTurn` 上，`ProjectRuntime` 只在 4 处调用它：创建（出队时）、`bindRuntime`、`record(event)`、`finish`。

- `invoke_agent` span 的属性：`gen_ai.operation.name`、`gen_ai.conversation.id`（会话 ID）、`gen_ai.request.model`、`gen_ai.response.model`，以及 `gen_ai.usage.*`。`input_tokens` 按约定包含缓存命中和缓存写入的 token；缓存部分另外记在 `cache_read` / `cache_creation` 两个属性里。
- 第一次收到模型输出时，记一个 span 事件 `first_output`。
- `execute_tool` 子 span 记录 `gen_ai.tool.name` 和 `gen_ai.tool.call.id`。`command` 子 span 只记退出码，非 0 时标记为错误。`runtime.item_id` 可用来到会话事件日志里查完整内容。
- Turn 结束时，把运行时一直没报告完成的子 span 一并结束，比如被中断的情况。

GenAI 约定目前仍是 Development 状态，属性名都集中写在 `turn-trace.ts` 里。

### 3.7 日志与 HTTP

- `Logger` 在有活跃 span 时，自动在输出里加 `traceId` 和 `spanId`。
- HTTP 中间件注册在请求日志中间件之前，所以 "gateway request completed" 这行日志也带 trace ID。
- HTTP span 在 handler 返回 Response 时结束，SSE 这类流式响应不会让 span 一直挂着，因此不需要单独排除 SSE 路径。
- span 名在请求处理完后，用 `hono/route` 的 `routePath` 改成路由模板，例如 `GET /api/v1/sessions/:sessionId`。`url.path` 只记路径，不含 query。

## 4. 配置

```yaml
tracing:
  enabled: false
  # serviceName: agent-orchestrator   # 或 OTEL_SERVICE_NAME
  # environment: production
  # endpoint: http://localhost:4318/v1/traces   # 或 OTEL_EXPORTER_OTLP_ENDPOINT
  # headers: {}
  # sampleRate: 1.0
```

- 配置里没写的字段交给 SDK 读取标准 `OTEL_*` 环境变量，我们不自己实现回退逻辑。exporter 凭证放在 `OTEL_EXPORTER_OTLP_HEADERS`，不写进配置文件。
- 资源属性的优先级：配置文件 > `OTEL_SERVICE_NAME` / `OTEL_RESOURCE_ATTRIBUTES` > 默认值 `agent-orchestrator`。
- 采样器是 `ParentBased(TraceIdRatio(sampleRate))`：新 trace 按比例采样，继续上游 trace 时沿用上游的采样决定。

阿里云 SLS 示例：

```bash
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://<project>.<region>.log.aliyuncs.com/opentelemetry/v1/traces
OTEL_EXPORTER_OTLP_HEADERS=x-sls-otel-project=<project>,x-sls-otel-instance-id=<instance>,x-sls-otel-ak-id=<id>,x-sls-otel-ak-secret=<secret>
```

## 5. 测试

`tests/tracing.test.ts` 用 `InMemorySpanExporter` 覆盖：

- 关闭时：`withSpan` 正常执行，没有 trace ID 和 traceparent，日志也不带 trace 字段。
- 配置段的解析和默认值。
- 日志只在 span 内带 trace ID。
- HTTP：继续调用方的 traceparent、span 名用路由模板、带 `x-trace-id`、请求日志带 trace ID、`/healthz` 不产生 span。
- Turn：父级是把它放进队列的请求；workspace、bind、tool、command、action 子 span 的层级；usage 属性；命令行不出现在 span 属性里。运行时事件和 Action 调用都从 trace 之外（`detached`）发起，以验证显式父级确实生效。
- 两个排队的 Turn 各自挂在自己的请求下面。
- 失败的 Action 被标记为错误。任务队列中，后一个任务挂在自己的 dispatch 下，而不是前一个任务下。
- Pipeline：节点 span 是根 span；第一个节点 link 到发起请求；Turn 和 `pipeline_next` 在节点的 trace 内；下一个节点 link 到上一个 Turn；`traceparent` 已持久化。

另外做了反向验证：去掉 `ActionContext.traceContext` 或运行时事件的上下文包装后，Turn 和 Pipeline 两个用例都会失败。

## 6. 备选方案与取舍

| 方案 | 结论 | 原因 |
| --- | --- | --- |
| 用全局开关和代际计数管理启停 | 放弃 | OTel API 不注册 provider 时本来就是空操作；全局状态只是在给测试打补丁 |
| `@hono/otel` | 放弃 | 需要按代际缓存中间件、按路径排除 SSE；自己写的约 40 行中间件更简单，span 名也能用路由模板 |
| 一条 Pipeline Run 一条 trace，上下文存在 `run.metadata` | 放弃 | trace 会持续数天；`metadata` 会进入 prompt 和 API，混进用户数据 |
| 用 runId 推出固定的 traceId，不做存储 | 放弃 | 节点 span 没有父 span，后端会显示成孤儿 span，也表达不了"由谁触发" |
| 订阅 EventHub 生成 Turn 的子 span | 放弃 | 订阅者需要额外按 turnId 查找父级，或者隐式依赖发布时的上下文；直接把 `TurnTrace` 挂在 `ActiveTurn` 上，归属更清楚 |
| gRPC exporter | 放弃 | 依赖重，常见的后端都支持 OTLP/HTTP |
