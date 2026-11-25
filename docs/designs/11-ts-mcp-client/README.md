# 11 - TS 任务通用 MCP 工具调用设计（Project MCP Client & `callMcpTool`）

| 元数据 | 内容 |
| :--- | :--- |
| **文档 ID** | `11-ts-mcp-client` |
| **状态** | `Draft` |
| **创建日期** | 2026-11-25 |
| **目标模块** | `src/mcp/`、`src/task/sdk.ts`、`src/task/executors/ts.ts`、`src/project/runtime.ts` |
| **关联设计** | [01-task-and-action](../01-task-and-action/README.md)、[09-pipeline-workflow](../09-pipeline-workflow/README.md) |

---

## 1. 背景与动机

目前项目已在 `project.yaml` 的 `runtime.mcpServers` 中统一配置了外部集成（如 `github`、工单系统等 HTTP/Stdio MCP 服务及其鉴权头和工具黑白名单）。Agent 会话可以直接调用这些 MCP 工具，但 TypeScript 定时任务（`tasks/*.ts`）和后续的 Pipeline TS 节点目前还无法直接复用它们，导致：

1. **重复造轮子**：每个 TS 任务都得自行硬编码外部 URL、读取凭据、手写 HTTP/JSON-RPC/SSE 协议解析代码。
2. **凭据与安全边界分散**：TS 代码不得不直接接触 `ctx.env` 中的敏感 Token，也无法复用 `project.yaml` 已声明的 `enabledTools` / `disabledTools` 权限约束。

因此需要提供一个平台级通用的 **`callMcpTool` 能力**，让所有 TS 任务（以及后续 Pipeline TS 节点）能直接按 `serverName` 调用项目已配置的 MCP 工具，做到「能通过 MCP Tool 做的事，不再重复写 API 胶水代码」。

---

## 2. 目标与非目标

### 目标

1. **零新增配置复用 `project.yaml`**：按 `serverName` 直接读取项目已插值好的 `runtime.mcpServers`（URL、鉴权头、超时、工具黑白名单），TS 代码不硬编码 URL、不接触 Token。
2. **同时支持 HTTP 与 Stdio MCP**：基于官方 `@modelcontextprotocol/sdk` 客户端（项目 `bun.lock` 已引入），原生支持 Streamable HTTP（`url`）和本地 Stdio（`command` + `args`）两类 MCP 服务。
3. **懒连接 + 单次执行复用 + 自动清理**：避免每次调用重复握手，也不在任务启动时提前连接未使用的 MCP，并在任务结束时统一释放连接与子进程。
4. **统一的返回解包与错误语义**：自动处理 `isError` 抛错与 `structuredContent` / JSON 文本解包，降低业务脚本编写成本。
5. **面向未来 Pipeline TS 节点零改造成本复用**：连接池与客户端封装在独立模块 `src/mcp/`，后续直接注入 `PipelineNodeContext`。

### 非目标

- **不做跨任务常驻全局 MCP 长连接池**：一期连接生命周期严格限定在单次任务执行内，避免常驻僵尸子进程与服务端 Session 过期状态管理复杂度。
- **不替代 Agent Runtime 自身的 MCP 挂载**：Agent 会话仍由各 Runtime（Codex / Claude / Pi / ACP）按现有方式挂载 MCP，本设计仅面向服务端 TS 代码调用。

---

## 3. 核心设计

### 3.1 对外接口（注入 `TaskRunContext`）

在 `TaskRunContext`（及未来的 `PipelineNodeContext`）新增两个方法：

```ts
export interface McpToolCallOptions {
  /** 单次调用超时（默认取 server.toolTimeoutSec，兜底 60s） */
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface McpToolResult<T = unknown> {
  /** 自动解包后的业务数据：优先 structuredContent -> 尝试 JSON.parse(text) -> 纯文本 */
  readonly data: T;
  /** 所有文本块拼接后的原始文本 */
  readonly text: string;
  /** MCP 原始 content 数组 */
  readonly content: readonly Record<string, unknown>[];
  readonly structuredContent?: Record<string, unknown> | undefined;
}

export interface McpToolInfo {
  readonly name: string;
  readonly description?: string | undefined;
  readonly inputSchema?: Record<string, unknown> | undefined;
}

// 挂载到 TaskRunContext：
callMcpTool<T = unknown>(
  serverName: string,
  toolName: string,
  args?: Record<string, unknown>,
  options?: McpToolCallOptions,
): Promise<McpToolResult<T>>;

listMcpTools(serverName: string): Promise<readonly McpToolInfo[]>;
```

### 3.2 连接生命周期策略（Lazy Per-Execution Pool）

新增独立模块 `src/mcp/client.ts`（`ProjectMcpClientPool`），绑定到单次 TS 任务执行：

```mermaid
flowchart LR
    S["进入 Task 执行\n创建空连接池 Map"] --> C1["首次 callMcpTool('github', ...)"]
    C1 -->|"并发去重握手 (Promise 缓存)"| CONN["建立连接 (HTTP / Stdio)"]
    CONN --> C2["后续同 server 调用\n直接复用已有连接"]
    C2 --> END["Task 结束 (finally)\n统一关闭所有连接与子进程"]
```

- **懒加载**：进入 Task 时仅创建空 `Map<serverName, Promise<Client>>`，未使用的 MCP 零开销、不会因无关服务抖动牵连当前任务。
- **并发去重与复用**：缓存连接 `Promise`，即使任务内用 `Promise.all` 并发调用同一个 server，也只会建立 1 条连接并在本次任务内全程复用。
- **确定性回收**：在 `TsTaskExecutor.execute(...)` 的 `finally` 块中统一调用 `await pool.close()`，无论任务成功、异常或超时中止，确保 HTTP session 与 Stdio 子进程全部释放。

### 3.3 统一解包、权限与超时规则

1. **工具黑白名单校验**：调用前按 `project.yaml` 中对应 server 的 `enabledTools` / `disabledTools` 校验，未授权工具直接拒绝抛错，与 Agent 会话保持一致。
2. **结果解包与错误拦截**：
   - 若 MCP 返回 `isError: true`，直接抛出含错误摘要的 `Error`，防止调用方漏判把报错当作正常数据；
   - `data` 提取顺序：`structuredContent` → 将拼接后的 `text` 尝试 `JSON.parse` → 保留原始 `text`；同时原样保留 `text`、`content`、`structuredContent`。
3. **超时与中止联动**：单次调用超时默认取 `server.toolTimeoutSec * 1000`（未配置时默认 `60_000ms`），并与任务级 `ctx.signal` 通过 `AbortSignal.any` 合并。
4. **日志与脱敏**：记录 `serverName`、`toolName`、`durationMs` 与成败状态到 `ctx.logger`（进入任务执行日志），严禁输出任何鉴权头或 Token。

---

## 4. 配置与使用示例

**无需新增任何 `project.yaml` 字段**，直接复用现有 `runtime.mcpServers`。

在 TS 任务中使用（以调用项目配置的 `github` MCP 查询 Issue 为例）：

```ts
const { data } = await ctx.callMcpTool<IssueListResult>("github", "list_issues", {
  owner: "example",
  repo: "example-service",
  state: "open",
  perPage: 50,
});
```

---

## 5. 实施与测试计划

1. **依赖声明**：将 `bun.lock` 中已存在的 `@modelcontextprotocol/sdk` 显式写入 `package.json` `dependencies`。
2. **核心模块**：实现 `src/mcp/client.ts`（`ProjectMcpClientPool`，支持 `StreamableHTTPClientTransport` 与 `StdioClientTransport`、懒连接并发去重、黑白名单校验、结果解包与 `close()` 回收）。
3. **任务执行器接入**：扩展 `src/task/sdk.ts`（`TaskRunContext`）、`src/task/executors/ts.ts`（注入 pool 并在 `finally` 关闭）与 `src/project/runtime.ts`（传入项目 `mcpServers`）。
4. **验证**：
   - 单元测试覆盖：懒连接复用与并发去重、`enabledTools`/`disabledTools` 拦截、`isError` 抛错、三层 `data` 解包、`finally` 自动关闭释放、超时/中止取消。
   - 运行 `bun run check && bun run build`。

---

## 6. 备选方案与权衡

| 决策点 | 选定方案 | 备选方案 | 权衡结论 |
| :--- | :--- | :--- | :--- |
| **连接生命周期** | 懒连接 + 单次 Task 内复用 + `finally` 关闭 | 每次调用新建连接；或进程级全局常驻池 | 兼顾翻页/循环性能与资源零泄漏，避免未使用的 MCP 拖慢启动或常驻僵尸进程。 |
| **底层传输实现** | 直接使用官方 `@modelcontextprotocol/sdk` | 手写 `fetch` + JSON-RPC + SSE 解析 | 官方 SDK 已在 `bun.lock` 中，一次性覆盖 HTTP 与 Stdio 且紧跟 MCP 协议演进，维护成本最低。 |
| **返回值设计** | 返回 `{ data, text, content, structuredContent }` 并在 `isError` 时直接抛错 | 原样透传底层 MCP 结果对象 | 屏蔽不同 MCP Server 返回格式差异（`structuredContent` vs JSON 字符串），显著简化业务 TS 脚本。 |
