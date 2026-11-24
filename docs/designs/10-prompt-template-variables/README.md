# 10 - 轻量级 Prompt 变量注入设计（Prompt Template Variables）

| 元数据 | 内容 |
| :--- | :--- |
| **文档 ID** | `10-prompt-template-variables` |
| **状态** | `Draft` |
| **创建日期** | 2026-11-24 |
| **目标模块** | `src/prompt/`、`src/domain/`、`src/config/`、`src/project/runtime.ts`、`src/task/`、`scripts/` |
| **前置依赖** | [01-task-and-action](../01-task-and-action/README.md)、[05-native-runtime-config-and-single-repo-workspace](../05-native-runtime-config-and-single-repo-workspace/README.md) |

---

## 1. 背景与动机

目前项目级任务（`projects/<id>/tasks/*.md`）在 [src/project/runtime.ts](../../../src/project/runtime.ts) 的 `renderTaskPrompt` 中仅做了分散且不统一的占位符替换：

- 顶层扁平占位符（`{{projectId}}`、`{{taskId}}`、`{{taskKey}}`、`{{taskName}}`）与命名空间占位符（`{{state.field}}`）风格混杂；
- 无法读取项目仓库信息（如 `owner/repo`、`baseBranch`）、非敏感项目级自定义参数（如 GitHub 作者名、Jira 项目 Key、目标分支）或当前执行时间；
- 多次全串 `replaceAll` + 正则扫描缺少统一边界，也没有针对大 Prompt 与病态输入的性能基准保障。

这直接导致两个问题：
1. **Prompt 大量写死环境/个人字面量**：例如巡检 GitHub Issue 的任务 Prompt 里被迫写死 `repo:example/example-service`、`author:alice`，甚至要让 Agent 每次手动跑 `date -u` 取时间；
2. **阻碍 Project 目录作为独立工作流包打包分发**：`project.yaml` 已经通过 `.env` + `{env:VAR}` 实现了配置参数化，但 Prompt 里的写死字面量会让其他使用者拿到目录后还得逐文件手工查找替换。

本设计定位为一个**极简、安全、零依赖、高性能的后端基础能力**：**全面切换为统一命名空间语法（不保留旧顶层扁平别名）**，不引入复杂模板引擎，不耦合未来模块，并配套独立的 **Benchmark 基准测试**验证线性时间复杂度与低延迟开销。

---

## 2. 目标与非目标

### 目标

1. **安全隔离凭据与模板变量**：在 `project.yaml` 新增显式、非敏感的 `vars` 命名空间（复用现有 `{env:VAR}` 从 `.env` 拉取非敏感业务值）；**禁止 Prompt 直接访问 `{{env.*}}` 或 `credentials`**，从根源避免 Token / 私钥泄露进模型上下文与会话历史。
2. **全面切换统一命名空间**：彻底移除旧的顶层扁平别名（`{{projectId}}`、`{{taskId}}`、`{{taskKey}}`、`{{taskName}}`），全仓库统一使用 `project.*`、`vars.*`、`task.*`、`state` / `state.*`、`now.*` 五个标准命名空间。
3. **极简、零外部依赖、单趟线性渲染器**：新增 `src/prompt/template.ts`（~80–100 行），仅支持「白名单点路径取值 `{{a.b.c}}` + 可选默认值 `{{a.b | fallback}}`」，严格单趟 `O(n)` 扫描（无回溯风险），且**原样保留非白名单 `{{...}}`**（不误伤 Markdown 代码示例中的花括号）。
4. **复用至 TS 任务与加载期预检**：
   - TS 任务 `TaskRunContext` 暴露只读 `ctx.vars` 与 `ctx.renderPrompt(...)`；
   - `TaskLoader` 加载 `tasks/*.md` 时静态检查缺失且无默认值的 `vars.*` 并输出结构化 `warn` 日志。
5. **可复现的 Benchmark 基准验证**：提供独立基准脚本，覆盖小/中/大 Prompt、高频无关花括号及极端未闭合 `{{{{...` 病态输入，验证渲染耗时与吞吐达标且与输入长度呈线性关系。
6. **零数据库变更**：完全在配置加载与运行期内存完成，无需新增表或 Migration。

### 非目标

- **不做前端改造**：本期不修改 `web/`（Web Studio 的 `Raw / Preview` 预览与缺失变量徽章留待后续按需迭代）。
- **不引入完整模板引擎**：不支持 `{{#if}}`、`{{#each}}` 循环、函数表达式或任意 JS 求值（如需复杂逻辑，由 TypeScript 任务 `tasks/*.ts` 用代码表达）。
- **不保留旧版顶层别名**：不再支持 `{{projectId}}`、`{{taskId}}`、`{{taskKey}}`、`{{taskName}}`，仓库现有测试与任务模板同步全面切换，避免两套写法长期并存造成混乱。
- **不直接暴露 `{{env.*}}`**：`.env` 中包含敏感凭据，必须经 `project.yaml` 的 `vars` 显式放行。
- **本期不涉及 Pipeline / Card 作用域**：核心函数只接收通用 `scopes: Record<string, unknown>`，未来扩展新作用域时直接传入即可。

---

## 3. 详细技术设计

### 3.1 安全模型：`secrets (.env)` 与 `vars` 显式分离

仓库现有的 [loadProjectsFromDirectory](../../../src/config/config.ts) 已经在加载 `project.yaml` 时自动执行了 `interpolateEnv(parsed, projectEnv, ...)`。利用这一现有管道，建立清晰的数据边界：

```mermaid
flowchart LR
    ENV[".env\n(GITHUB_TOKEN, SSH_KEY,\nGITHUB_AUTHOR, JIRA_KEY)"]
    YAML["project.yaml\nrepository.auth / mcpServers (仅运行时用)\nvars: 非敏感业务参数白名单"]
    RENDER["renderPromptTemplate()\n仅接收 project / vars / task / state / now"]
    LLM["Agent Prompt & 对话记录"]

    ENV -->|"interpolateEnv"| YAML
    YAML -->|"仅透传 vars 与脱敏后的 project 元数据"| RENDER
    RENDER --> LLM
```

- **凭据不越界**：`repository.auth`、`mcpServers.*.http_headers`、`env`、`credentials` 均不会进入 `project.*` 作用域；`project.repo.slug` 从 `repository.url` 解析时会自动剥离协议、用户凭据和 `.git` 后缀，仅保留 `owner/repo` 形式。
- **防原型链污染**：点路径取值严格使用 `Object.hasOwn(current, segment)` 并拒绝 `__proto__`、`constructor`、`prototype`。
- **未解析 `{env:...}` 保护**：如果 `project.yaml` 的 `vars` 中某个值在 `interpolateEnv` 后仍保留 `{env:...}` 字面量（对应环境变量未设置），在加载阶段剥离该项并记录告警，避免把占位原串注入 Prompt。

---

### 3.2 核心模块契约：`src/prompt/template.ts`

#### 语法与单趟 `O(n)` 扫描算法

仅匹配形如 `{{ <path> }}` 或 `{{ <path> | <default> }}` 的占位符：

- `<path>`：`[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*`
- `<default>`：可选默认值（`|` 右侧做首尾 `trim()`，支持为空字符串如 `{{vars.prefix | }}`）
- **为什么采用手写单趟扫描（`indexOf("{{")` / `indexOf("}}")`）而非复杂正则**：
  1. 严格保证最坏情况下也是 **`O(n)` 线性时间**，彻底杜绝 ReDoS（例如 50 KB 连续未闭合的 `{{{{{{...`）；
  2. 避免对同一模板做多次全串遍历（原 `renderTaskPrompt` 对 50 KB 模板会执行 6 次全串扫描+复制）；
  3. 遇到嵌套或未闭合的 `{{`（例如 `{{ a {{project.id}}`）时，可精准推进游标只解析合法最内层占位符，其余文本零拷贝切片拼接。
- **白名单前缀保护**：仅当 `<path>` 的根段存在于传入 `scopes` 的顶层键集合时才进行替换；**不在白名单内的 `{{...}}`（如代码示例里的 `{{ item.name }}`、`{{ .Values.port }}`）原样保留**。
- **值序列化规则**：
  - `string` / `number` / `boolean`：直接 `String(val)`；
  - `object` / `Array`：根对象（如 `{{state}}`）使用 `JSON.stringify(val, null, 2)`，深层字段（如 `{{state.meta}}`）使用 `JSON.stringify(val)`；
  - `undefined` / `null` / 空字符串 `""`：若提供了 `| <default>` 则使用默认值；否则返回空字符串 `""` 并记录进 `missingVars`。

#### 对外函数接口

```ts
export type ProjectVarValue = string | number | boolean;
export type ProjectVars = Readonly<Record<string, ProjectVarValue>>;

export interface PromptTemplateVarRef {
  /** 原始路径，如 "vars.githubAuthor" */
  readonly path: string;
  /** 根命名空间，如 "vars" */
  readonly root: string;
  /** 根之后的子路径，如 "githubAuthor" */
  readonly subPath: string;
  /** 是否声明了默认值（| fallback） */
  readonly hasDefault: boolean;
  readonly defaultValue?: string;
}

export interface RenderPromptResult {
  readonly rendered: string;
  /** 命中白名单但最终值为空且无默认值的变量路径列表（去重） */
  readonly missingVars: readonly string[];
}

/**
 * 单趟 O(n) 渲染 Prompt 模板：仅替换 scopes 中存在的顶层白名单根路径。
 */
export function renderPromptTemplate(
  template: string,
  scopes: Readonly<Record<string, unknown>>,
): RenderPromptResult;

/**
 * 静态扫描模板中引用到的变量（可按根命名空间过滤，如仅查 ["vars"]）。
 */
export function extractPromptVarRefs(
  template: string,
  roots?: readonly string[],
): PromptTemplateVarRef[];

/**
 * 校验模板引用的 vars.* 中哪些既未在 projectVars 中定义、又没有写默认值。
 */
export function findMissingProjectVars(
  template: string,
  projectVars?: ProjectVars,
): string[];

/**
 * 从 Git SSH / HTTPS URL 安全提取 "owner/repo" slug（不含任何凭据或主机前缀）。
 * 示例：
 * - "git@github.com:example/example-service.git" -> "example/example-service"
 * - "https://user:tok@github.com/org/sub/repo.git" -> "org/sub/repo"
 * - 空字符串或无法解析 -> undefined
 */
export function extractRepoSlug(repoUrl?: string): string | undefined;

/**
 * 构造安全的 project.* 作用域（不含 env / credentials / auth）。
 */
export function buildProjectPromptScope(project: ProjectConfig): {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly repo: {
    readonly baseBranch: string;
    readonly slug: string;
    readonly committerName: string;
    readonly committerEmail: string;
  };
};

/**
 * 构造按指定时区格式化的 now.* 作用域。
 */
export function buildNowPromptScope(
  timezone?: string,
  now?: Date,
): {
  readonly iso: string;    // UTC ISO 8601，如 "2026-11-24T11:20:00.000Z"
  readonly date: string;   // 目标时区 YYYY-MM-DD，如 "2026-11-24"
  readonly local: string;  // 目标时区 YYYY-MM-DD HH:mm:ss
};
```

---

### 3.3 标准变量作用域清单（全面切换，无旧别名）

| 占位符 | 来源 | 示例值 | 说明 |
| :--- | :--- | :--- | :--- |
| `{{project.id}}` | `project.id` | `example-service` | 项目 ID（取代旧 `{{projectId}}`） |
| `{{project.displayName}}` | `project.displayName` | `Example Service` | 项目展示名 |
| `{{project.description}}` | `project.description` | `...` | 项目描述 |
| `{{project.repo.slug}}` | `extractRepoSlug(repository.url)` | `example/example-service` | 自动从仓库 URL 安全提取 |
| `{{project.repo.baseBranch}}` | `repository.baseBranch` | `main` | 默认基础分支 |
| `{{project.repo.committerName}}` | `resolveCommitter(repository).name` | `Agent Orchestrator` | Git 提交者名 |
| `{{project.repo.committerEmail}}` | `resolveCommitter(repository).email` | `agent-orchestrator@localhost` | Git 提交者邮箱 |
| `{{vars.<key>}}` | `project.yaml` 的 `vars` | `alice` | 非敏感自定义参数，支持 `\| default` |
| `{{task.id}}` | `task.taskId` | `issue-triage` | 任务 ID（取代旧 `{{taskId}}`） |
| `{{task.key}}` | `task.taskKey` | `example-service:issue-triage` | 任务全局键（取代旧 `{{taskKey}}`） |
| `{{task.name}}` | `task.name` | `Issue Triage` | 任务名（取代旧 `{{taskName}}`） |
| `{{task.cron}}` / `{{task.timezone}}` | `task.cron` / `task.timezone` | `0,30 * * * *` | 调度配置 |
| `{{state}}` / `{{state.<path>}}` | `TaskEngine` 状态快照 | `{"lastCheckedAt": "..."}` | 支持任意深路径如 `{{state.cursor.page}}` |
| `{{now.iso}}` / `{{now.date}}` / `{{now.local}}` | 执行时刻 `new Date()` | `2026-11-24T11:20:00.000Z` | 按任务 `timezone`（缺省 UTC）生成 |

---

### 3.4 各模块接入细节

1. **领域类型与配置校验**（[src/domain/types.ts](../../../src/domain/types.ts)、[src/domain/schemas.ts](../../../src/domain/schemas.ts)、[src/config/config.ts](../../../src/config/config.ts)）
   - `ProjectConfig` 新增 `vars?: Record<string, string | number | boolean>`。
   - `projectConfigSchema` 的 `z.strictObject` 新增：
     ```ts
     vars: z
       .record(
         z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
         z.union([z.string(), z.number(), z.boolean()]),
       )
       .optional(),
     ```
   - 在配置归一化阶段清理未解析的 `{env:...}` 项并输出告警。

2. **Agent 任务 Prompt 渲染**（[src/project/runtime.ts](../../../src/project/runtime.ts#L1304-L1332)）
   - 重写 `renderTaskPrompt`，直接委托给 `renderPromptTemplate`，注入 `project`、`vars`、`task`、`state`、`now` 五个标准作用域，**彻底移除旧的 4 个顶层扁平替换**。
   - 若执行期 `missingVars` 非空，记录 `logger.warn("task prompt contains unresolved variables", { taskKey, missingVars })`。

3. **TS 任务 SDK 共享同一套变量**（[src/task/sdk.ts](../../../src/task/sdk.ts)、[src/task/executors/ts.ts](../../../src/task/executors/ts.ts)）
   - `TaskRunContext` 增加两个只读能力：
     ```ts
     /** 项目 project.yaml 中声明的非敏感 vars（与 Markdown 任务共享） */
     readonly vars: Readonly<Record<string, string | number | boolean>>;

     /** 使用当前项目的 project/vars/task/state/now 作用域渲染任意 Prompt 模板 */
     renderPrompt(template: string, extraScopes?: Record<string, unknown>): string;
     ```

4. **加载期静态预检**（[src/task/loader.ts](../../../src/task/loader.ts)）
   - `TaskLoader` 加载 `tasks/*.md` 时调用 `findMissingProjectVars(promptTemplate, project.vars)`，若存在未定义且无默认值的 `vars.*` 立即打 `warn` 日志。

5. **存量测试与示例全面迁移**
   - 同步更新仓库中引用旧别名的测试文件（`tests/task.test.ts`、`tests/task-scenarios.test.ts`、`tests/session-runtime-override.test.ts`）为标准命名空间写法。

---

## 4. 配置规范与改造示例

### `project.yaml` 配置示例

```yaml
project:
  id: example-service
  displayName: Example Service
  description: Example managed service repository.

# 非敏感项目变量：专供 Prompt 模板与 TS 任务使用（切勿放入 Token / 私钥）
vars:
  githubAuthor: "{env:GITHUB_AUTHOR}"
  issueReadyLabel: "issue:ready"
  reviewChecklist: "请重点检查并发安全、错误处理和回归测试。"

repository:
  url: git@github.com:example/example-service.git
  baseBranch: main
```

### `.env.example`（随 Project 包分发）

```dotenv
# 凭据（仅用于 MCP 与 Git 认证，不会暴露给 Prompt）
GITHUB_TOKEN=ghp_your_token_here

# 非敏感业务参数（通过 project.yaml vars 注入 Prompt）
GITHUB_AUTHOR=your-github-username
```

### Markdown 任务改造前后对比

**改造前（写死仓库/账号 + 旧顶层别名）**：
```markdown
项目：{{projectId}}
用 github MCP 搜索：
`repo:example/example-service is:issue is:open author:alice label:issue:ready`
```

**改造后（统一命名空间 + 零硬编码）**：
```markdown
项目：{{project.id}}（当前 UTC 时间：{{now.iso}}）
用 github MCP 搜索：
`repo:{{project.repo.slug}} is:issue is:open author:{{vars.githubAuthor}} label:{{vars.issueReadyLabel | issue:ready}}`
```

---

## 5. 实施步骤、测试与 Benchmark 计划

### 实施步骤

1. **核心模块**：实现 `src/prompt/template.ts`（单趟 `O(n)` 渲染器、`extractRepoSlug`、作用域构造、`extractPromptVarRefs` / `findMissingProjectVars`）。
2. **配置与运行时接入**：更新 `src/domain/types.ts`、`src/domain/schemas.ts`、`src/config/config.ts`、`src/project/runtime.ts`、`src/task/sdk.ts`、`src/task/executors/ts.ts`、`src/task/loader.ts`。
3. **测试迁移与覆盖**：迁移 3 个既有测试文件中的旧别名，新增 `tests/prompt-template.test.ts` 完整覆盖新能力。
4. **性能基准测试**：新增可复现的 Benchmark 脚本 `scripts/bench-prompt-template.ts` 并实测记录结果。

### 单元测试覆盖矩阵（`tests/prompt-template.test.ts`）

- **标准命名空间与深路径**：`{{project.*}}`、`{{vars.*}}`、`{{task.*}}`、`{{state}}`、`{{state.nested.key}}`、`{{now.*}}`。
- **全面切换验证**：旧顶层占位符 `{{projectId}}` / `{{taskId}}` / `{{taskKey}}` / `{{taskName}}` 不再被替换（原样保留）。
- **默认值与空值处理**：`{{vars.branch | main}}` 在缺失 / `null` / `""` 时回退，存在值时优先用实际值；支持 `{{vars.opt | }}` 空默认。
- **安全与边界保护**：
  - `{{env.SECRET}}`、`{{vars.__proto__}}`、`{{vars.constructor}}` 不泄露、不抛错；
  - 未知占位符（代码块内的 `{{ item.name }}`、`{{ .Values.tag }}`）及未闭合 `{{` 原样保留。
- **URL Slug 提取**：SSH、HTTPS、带凭据的 HTTPS URL（剥离凭据）、多级 GitLab group 路径、空 URL。
- **端到端**：`loadProjects` 加载带 `vars` + `.env` 的 `project.yaml`，验证 Agent 任务与 TS 任务（`ctx.vars` / `ctx.renderPrompt`）渲染一致。

### Benchmark 基准测试设计（`scripts/bench-prompt-template.ts`）

通过 Bun 直接运行可复现基准（预热后按轮次采集 `ops/sec`、`avg`、`p50`、`p95`、`p99` 与堆内存增量），与旧版多趟 `replaceAll` + 正则基线做同机对比：

| 基准场景 | 输入规模与特征 | 目标性能门槛 |
| :--- | :--- | :--- |
| **S1：小型任务模板** | ~500 B，5 个变量（含默认值与深路径） | 单次 < `0.02 ms`（> `50,000 ops/sec`） |
| **S2：典型 Markdown 任务 Prompt** | ~5 KB，25 个变量 + 代码块内 20 个无关 `{{...}}` | 单次 < `0.1 ms`（> `10,000 ops/sec`） |
| **S3：超大 Prompt 文档** | ~100 KB，200 个变量 + 100 个无关花括号 | 单次 < `2 ms`（相对 S2 保持近似线性比例） |
| **S4：病态未闭合输入（防 ReDoS）** | ~50 KB 连续 `{{{{...` 与半闭合 `{{ vars.foo ` 序列 | 单次 < `5 ms`（严格 `O(n)`，无指数级回溯） |
| **S5：静态扫描 `findMissingProjectVars`** | ~5 KB 模板 × 高频加载校验 | 单次 < `0.05 ms` |
| **S6：`buildProjectPromptScope` + `buildNowPromptScope`** | 每次执行构造作用域的固定开销（含 `Intl.DateTimeFormat` 复用验证） | 单次 < `0.05 ms` |

> **关键实现注意点**：`buildNowPromptScope` 中应按 `timezone` 缓存 `Intl.DateTimeFormat` 实例（避免每次渲染重复构造 Formatter 导致性能抖动），Benchmark S6 将直接量化这一优化的效果。

---

## 6. 备选方案与权衡

| 决策点 | 选定方案 | 备选方案 | 权衡结论 |
| :--- | :--- | :--- | :--- |
| **是否保留旧顶层别名** | 彻底移除，全面切换标准命名空间 | 长期并存 `{{projectId}}` 与 `{{project.id}}` | 当前受影响范围极小（仅 3 个测试文件与少量本地任务），一次性切换能保持语法唯一干净，避免新旧两套写法长期并存带来的心智与维护负担。 |
| **模板扫描实现方式** | 手写单趟 `O(n)` 线性扫描器（~80 行） | 引入 Handlebars / Mustache 或多趟正则替换 | 不需要控制流与循环；手写单趟扫描零依赖、绝对免疫 ReDoS、无 HTML 转义坑，且通过 Benchmark 可直接验证高吞吐与线性复杂度。 |
| **变量来源通道** | `project.yaml` 显式声明 `vars:` 白名单 | 允许 Prompt 直接写 `{{env.XXX}}` | `.env` 混放敏感凭据，直接暴露给 Prompt 风险过高；显式 `vars` 一行映射即可兼顾打包分发与凭据隔离。 |
| **前端预览范围** | 本期暂不做前端改造 | 同步修改 `TasksView` 加 `Raw / Preview` | 先把底层纯函数能力、安全边界和 Benchmark 打牢，后端收敛后再按需决定前端交互，保持变更精简可控。 |
