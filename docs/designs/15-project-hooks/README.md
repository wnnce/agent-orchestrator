# Design 15: 项目级 HTTP Hooks

| Field | Value |
| --- | --- |
| **Status** | Accepted |
| **Target Module** | `src/hooks/`（新增）、`src/project/`、`src/gateway/` |
| **Date** | 2026-11-27 |

---

## 1. 背景与动机

外部平台（GitHub、GitLab、Jira、Sentry、告警系统等）需要用原生 HTTP 回调驱动项目：Issue 打标签启动 Pipeline、PR 收到评论唤醒等待中的节点、告警转成通知。

现有的 `POST /api/v1/webhooks/:projectId` 做不到：

- 它是 HTTP 对话渠道，只接受固定 JSON，把文本当作一条消息发给会话。
- 它在 `/api/v1` 下，要求 Bearer token，外部平台带不了。
- 外部平台的验签方式、payload 结构、重试语义各不相同，同一平台不同版本也不同（比如两个项目接的 Jira 版本不同）。

如果由框架做平台适配，每接一个平台、每多一个版本就要往框架里加代码。所以本设计让**框架只负责转发**：把请求原样交给项目自己写的 hook 文件，验签、解析、去重和业务逻辑都由 hook 决定。

[Design 16](../16-project-context-and-tools/README.md) 已经把项目能力统一收口到 `ProjectContext`，并预留了 `HookOrigin`。hook 直接在 `ProjectContext` 上扩展，不再实现一份自己的能力。

## 2. 目标与非目标

### 目标

- 项目在 `projects/<projectId>/hooks/*.ts` 用 `defineHook` 声明 hook，与 `tasks/`、`tools/`、`pipelines/` 的约定一致：`name` 必填，可选的 `id` 不写时取文件名。
- 网关在 `/hooks/<projectId>/<hookId>` 把请求原样转给 hook，不经过 `/api/v1` 的 Bearer 鉴权。
- `HookContext` 扩展 `ProjectContext`，以 hook 的身份（`origin.kind === "hook"`）调用项目能力。
- 项目启动时加载全部 hook，加载失败的文件在启动日志里报错。
- 每次投递有独立的 server span 和日志字段，hook 里启动的 Pipeline / 会话自然串到同一条 trace。

### 非目标

- **不做平台适配。** 不内置 GitHub / Jira 等解析器，不引入 YAML / JSONPath 映射 DSL。
- **不做验签和去重。** 各平台的签名格式不同（签什么内容、hex 还是 base64、带不带时间戳），框架不提供验签工具，由 hook 用 Web Crypto（`crypto.subtle`）按平台的规则自己校验。去重大多靠 `pipelines.start` 的 `externalKey` 幂等。
- **不支持自定义路径。** URL 固定为 `/hooks/<projectId>/<hookId>`，hook 只能决定最后一段，因此不存在跨项目路径冲突。
- **不限制 HTTP method。** 所有 method 都转发，hook 自己判断（平台握手常用 GET）。
- **不建投递记录表，不做重试队列。** 排查靠日志和 trace，重试靠外部平台自己重投。
- **不热加载。** 改 hook 后重启服务生效，与项目工具一致。
- **不改动 `POST /api/v1/webhooks/:projectId`。** 它是对话渠道，与 hook 是两件事。

## 3. 详细技术设计

### 3.1 一次投递的流程

```text
<METHOD> /hooks/<projectId>/<hookId>
  │  httpTracing：server span，名为 "<METHOD> /hooks/:projectId/:hookId"，响应头带 x-trace-id
  ▼
routes/hooks.ts ── projects.get(projectId).handleHook(hookId, c.req.raw)
  ▼
ProjectRuntime.handleHook ── 在启动时加载的 hook 表里查 hookId，没有 → 404 HOOK_NOT_FOUND
  ▼
deliverHook（src/hooks/deliver.ts）
  ├─ 生成 deliveryId，origin = { kind: "hook", hookId, deliveryId }
  ├─ 给当前 span 加上 project.id、hook.id、hook.delivery_id
  ├─ createContext(origin, { signal: AbortSignal.timeout(timeoutMs) })
  ├─ hook.handle(request, ctx)
  │    ├─ 返回 Response → 原样返回
  │    ├─ 返回 void → 204
  │    └─ 抛出异常 → 交给全局错误处理（AppError 按状态码，其他 500 并记 error 日志）
  └─ finally：dispose 上下文（释放 MCP 连接等）
  ▼
routes/hooks.ts ── c.newResponse(response.body, response)：保留中间件设置的 x-trace-id / x-request-id
```

处理函数不理会 `ctx.signal` 时，`deliverHook` 也会在超时后返回错误（`untilAborted`，与 TS 任务共用，见 `src/context/abort.ts`），不会让请求一直挂着。

### 3.2 SDK（`src/hooks/sdk.ts`，从 `src/hooks/index.ts` 导出）

```ts
/** hook 处理函数收到的上下文：以这次投递的身份行事的项目上下文。 */
export interface HookContext extends ProjectContext {
  readonly origin: HookOrigin;
  readonly hook: {
    readonly id: string;
    readonly name: string;
    /** 框架为每次请求生成；外部平台自己的投递 ID 如果在请求头里，由 hook 读取并记日志。 */
    readonly deliveryId: string;
  };
}

export interface HookSpec {
  /** URL 里的标识，项目内唯一；不写时取文件名（去掉 .ts）。 */
  readonly id?: string | undefined;
  /** 给人看的名称，用于日志和列表接口。 */
  readonly name: string;
  readonly description?: string | undefined;
  /** ctx.signal 的超时，默认 30s。慢活交给 pipelines.start / sessions.start 异步执行。 */
  readonly timeoutMs?: number | undefined;
  handle(request: Request, ctx: HookContext): Promise<Response | void> | Response | void;
}

/** 与 defineTask 一样带 brand，加载器只接受 defineHook 的返回值。 */
export function defineHook(spec: HookSpec): DefinedHook;
```

要点：

- **请求原样传入，框架不预读 body。** hook 可以先 `await request.text()` 拿原始字节验签，再自己解析 JSON。
- **`ctx.signal` 不跟请求连接绑定。** 平台通常 10 秒左右就断开连接，如果连接断开就取消，hook 会被中途打断；所以用独立超时。
- **能力全部来自 `ProjectContext`：** `notify`、`artifacts`、`mcp`、`sessions.start`、`pipelines.start / find / list / signal`、`render`、`project.env / vars`、`logger`。按 Design 16，`createdBy` 自动为 `hook:<hookId>`，日志和 span 带 `hook.id`、`hook.delivery_id`。
- **不为 hook 单独加能力。** 列出 Pipeline run、手动触发任务等，有真实需要时加进 `ProjectContext`，所有调用方共用。

### 3.3 加载（`src/hooks/loader.ts`）

`ProjectRuntime.start()` 在加载项目工具之后调用 `loadProjectHooks(projectDir, projectId, logger)`，结果存为 `Map<hookId, DefinedHook>`。全局项目 `_global_` 不加载。

- 扫描 `projects/<projectId>/hooks/`，目录不存在时返回空。
- 文件过滤与项目工具一致：只要 `.ts`，跳过 `_` 开头、`.test.ts`、`.spec.ts`、`.d.ts`。`_` 开头的文件留给 hook 之间共用的辅助模块。
- 每个文件默认导出一个 `defineHook(...)` 的返回值，用 brand 和 zod 校验；`name` 必填。
- `hookId` 取声明的 `id`，没有时取去掉 `.ts` 的文件名。规则与 Pipeline id 相同：`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$`。它会出现在 URL 里，这条规则也防止路径穿越；不符合的文件记 `error` 并跳过。
- 同一项目内 `hookId` 重复：按文件名字典序，先加载的生效，后面的记 `warn` 并跳过（与项目工具重名的处理一致）。
- 单个文件导入失败、超时或校验不通过：记 `error` 日志（含文件路径和原因）并跳过，不影响项目启动和其他 hook。
- 加载成功后记一条 `info` 日志，列出该项目的 hook id。

### 3.4 运行时与路由

```ts
// src/project/runtime.ts
class ProjectRuntime {
  /** 把一次 HTTP 投递交给 hook；hook 不存在时抛 NotFoundError(HOOK_NOT_FOUND)。 */
  handleHook(hookId: string, request: Request): Promise<Response>;
  /** 已加载的 hook，供列表接口使用。 */
  listHooks(): Array<{ id: string; name: string; description?: string }>;
}
```

```ts
// src/gateway/routes/hooks.ts，挂在根应用上，位于 /api/v1 的 Bearer 鉴权之外
app.use("/hooks/*", httpTracing()); // 与 /api/v1 的 tracing 一起注册在请求日志之前
router.all("/hooks/:projectId/:hookId", async (c) => {
  const { projectId, hookId } = c.req.param();
  const response = await deps.projects.get(projectId).handleHook(hookId, c.req.raw);
  // hook 返回的 Response 会替换掉中间件写过 header 的那个，所以经 context 重建一次
  return c.newResponse(response.body, response);
});
```

- 项目不存在：`ProjectManager.get` 抛 `PROJECT_NOT_FOUND`，返回 404。
- 不进 OpenAPI 文档：请求和响应格式都由 hook 决定，没有固定契约。
- 新增 `ErrorCode.HOOK_NOT_FOUND`。

### 3.5 只读列表接口

`GET /api/v1/projects/:projectId/hooks`（Bearer 鉴权）返回：

```json
{ "projectId": "shortlink", "hooks": [{ "id": "github", "name": "GitHub 事件", "path": "/hooks/shortlink/github", "description": "..." }] }
```

用于确认 hook 是否加载成功、拿到要填给外部平台的地址。加载失败的文件看启动日志。

### 3.6 安全

`/hooks/*` 是公网可访问、不鉴权的入口，**验签是 hook 作者的责任**：

- 示例和项目模板都从验签开始写。
- 密钥放在 `projects/<id>/.env`，通过 `ctx.project.env` 读取。
- 以后如果要框架兜底，可以加一个可选的项目级共享密钥校验，属于在现有设计上叠加，不需要改动本设计。

## 4. 使用示例

### GitHub：Issue 打标签启动 Pipeline，PR 评论唤醒等待节点

```ts
// projects/shortlink/hooks/github.ts  →  POST /hooks/shortlink/github
// 这是项目侧代码：GitHub 的签名格式和事件结构只出现在项目里，框架不认识 GitHub。
import { defineHook } from "../../../src/hooks/index.ts";

export default defineHook({
  name: "GitHub 事件",
  description: "ai-dev 标签启动 issue-to-pr；PR 评论唤醒 pr_watch",
  async handle(request, ctx) {
    const body = await request.text();
    const secret = ctx.project.env.GITHUB_WEBHOOK_SECRET ?? "";
    if (!(await validSignature(body, request.headers.get("x-hub-signature-256"), secret))) {
      return Response.json({ error: "invalid_signature" }, { status: 401 });
    }

    const event = request.headers.get("x-github-event");
    const payload = JSON.parse(body);
    ctx.logger.info("github delivery received", {
      event,
      githubDelivery: request.headers.get("x-github-delivery"),
    });

    if (event === "issues" && payload.action === "labeled" && payload.label?.name === "ai-dev") {
      // externalKey 让平台重投时返回同一个 run
      const { run, created } = await ctx.pipelines.start({
        pipelineId: "issue-to-pr",
        externalKey: `issue-${payload.issue.number}`,
        externalUrl: payload.issue.html_url,
        title: `#${payload.issue.number} ${payload.issue.title}`,
        data: { issueNumber: payload.issue.number, issueBody: payload.issue.body ?? "" },
      });
      return Response.json({ runId: run.runId, created }, { status: created ? 201 : 200 });
    }

    if (event === "issue_comment" && payload.issue?.pull_request) {
      // 只唤醒这个 Issue 对应的 run，而不是所有 waiting 的 run
      const issueNumber = linkedIssueNumber(payload.issue.body);
      if (issueNumber !== undefined) {
        await ctx.pipelines.signal({ pipelineId: "issue-to-pr", externalKey: `issue-${issueNumber}` });
      }
    }
    // 其他事件：返回 204
  },
});

/** GitHub 的签名：`sha256=` 加上 body 的 HMAC-SHA256（hex）。subtle.verify 按常量时间比较。 */
async function validSignature(body: string, header: string | null, secret: string) {
  if (!secret || !header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signature = Uint8Array.fromHex(header.slice("sha256=".length));
  return crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(body));
}

function linkedIssueNumber(prBody: string | null): number | undefined {
  const match = prBody?.match(/(?:closes|fixes|resolves)\s+#(\d+)/i);
  return match ? Number(match[1]) : undefined;
}
```

### 带握手的告警平台

```ts
// projects/ops/hooks/grafana.ts  →  GET|POST /hooks/ops/alerts（声明的 id 优先于文件名）
import { defineHook } from "../../../src/hooks/index.ts";

export default defineHook({
  id: "alerts",
  name: "Grafana 告警",
  async handle(request, ctx) {
    if (request.method === "GET") {
      const challenge = new URL(request.url).searchParams.get("challenge") ?? "";
      return new Response(challenge, { headers: { "content-type": "text/plain" } });
    }
    const alert = await request.json();
    await ctx.notify({ title: `告警：${alert.name}`, text: alert.summary, level: "warning" });
    return Response.json({ received: true }, { status: 202 });
  },
});
```

多个项目接同一平台时，把验签和事件解析抽到 `projects/_shared/` 的普通函数里各自 import，框架不参与。

## 5. 实施阶段与测试计划

每个阶段单独提交，结束时 `bun run check` 通过。

1. **SDK 与加载器。** `src/hooks/sdk.ts`（`defineHook`、`HookContext`）、`src/hooks/loader.ts`、`src/hooks/index.ts`。
   测试：文件过滤、`id` 缺省取文件名、`hookId` 格式校验、缺少 `name` 或非 `defineHook` 导出被拒、项目内 `hookId` 重复时先加载者生效、单个坏文件不影响其他文件。
2. **运行时。** `ProjectRuntime` 启动时加载 hook，新增 `handleHook`、`listHooks`，新增 `HOOK_NOT_FOUND`。
   测试：未知 hook 抛 `HOOK_NOT_FOUND`；`ctx.origin` 为 hook 且带 `deliveryId`；`ctx.pipelines.start` 的 `createdBy` 为 `hook:<id>`；返回 void 得到 204；超时后 `ctx.signal` 已中止；上下文被 dispose。
3. **网关。** `/hooks/:projectId/:hookId` 路由和 `GET /api/v1/projects/:id/hooks`。
   测试：开启 `apiToken` 时 `/hooks/*` 不需要 token 而 `/api/v1` 仍需要；未知项目和未知 hook 返回 404；body 未被预读，hook 能用原始文本验签；自定义状态码和 `text/plain` 响应原样返回；hook 抛异常返回 500 且服务继续可用；span 名为 `POST /hooks/:projectId/:hookId`，响应带 `x-trace-id`，hook 内启动的 Pipeline 链接到这条 trace。
4. **示例。** `projects/example/hooks/feature-request.ts`：用 Web Crypto 校验 `x-signature`（body 的 HMAC-SHA256），按请求的 `key` 幂等启动 `feature-delivery`。

## 6. 备选方案与取舍

| 方案 | 结论 | 原因 |
| --- | --- | --- |
| 独立的 `HookContext`，自己实现启动 Pipeline、发通知等能力 | 放弃 | 那是第四份能力实现；Design 16 已统一到 `ProjectContext` |
| 只用文件名作标识，不声明 `id` / `name` | 放弃 | 文件名不一定是 hook 的真实名称；与 `definePipeline` / `defineTask` 保持一致，`id` 可选、`name` 必填 |
| hook 自定义路径，全局路由表加冲突检测 | 放弃 | 外部平台的回调地址可以随便填，自定义路径没有收益，却带来规范化、冲突检测、冲突诊断等一整套机制 |
| 框架按 `methods` 白名单返回 405 | 放弃 | hook 自己判断 `request.method` 即可，平台握手本来就要处理 GET |
| 每次请求按文件加载，改文件立即生效 | 放弃 | 坏文件要等到第一次请求才暴露；启动时加载能在启动日志里直接看到，和项目工具一致 |
| 框架内置平台解析器或映射 DSL | 放弃 | 平台和版本差异大，框架越介入越僵化；共用逻辑放在 `projects/_shared/` 的普通函数里 |
| 框架提供 `verifyHmacSha256` 之类的验签工具 | 放弃 | 看似通用，实际只适配一种签名格式（GitHub 的 `sha256=<hex>`）；Slack、Stripe 签名里带时间戳，Shopify 用 base64，GitLab 直接比对 token。要么不断加参数变成平台适配，要么只服务一个平台，都不该在框架里 |
| 投递记录表加重试队列 | 暂不做 | 主要平台会自己重投，`externalKey` 已保证幂等；出现不会重投、又不能丢的事件源时再加 |
| 并入 `POST /api/v1/webhooks/:projectId` | 放弃 | 那是把文本发给会话的对话渠道，契约固定且要求鉴权，与原始 HTTP 回调是两件事 |
