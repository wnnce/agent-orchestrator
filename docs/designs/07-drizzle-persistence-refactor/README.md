# 07 - 持久层模块化拆分与 Drizzle ORM 重构设计

| 元数据       | 内容                                                                                             |
| :----------- | :----------------------------------------------------------------------------------------------- |
| **文档 ID**  | `07-drizzle-persistence-refactor`                                                                |
| **状态**     | `Draft`                                                                                          |
| **创建日期** | 2026-11-20                                                                                       |
| **目标模块** | `src/persistence/`、`database/`、`scripts/init-database.ts`、`tests/database-schema.test.ts`     |
| **相关文档** | `AGENTS.md`、`README.md`、`README_zh.md`、`Dockerfile`                                           |

---

## 1. 背景与动机

当前持久化层集中在单个文件 [src/persistence/store.ts](../../../src/persistence/store.ts)（1,128 行）中，同时存在“结构耦合”、“无类型安全保障”与“实现缺陷”三类问题：

1. **手写 SQL 与弱类型行映射容易产生静默漂移**：
   - `PostgresStore` 通过 `pool.query(...)` 手写全部 SQL 字符串与 `$1, $2...` 参数下标；
   - 行映射函数（如 `toSessionRoute`、`rowToTurn`）接收 `Record<string, any>`，列名变更或类型不匹配在编译期完全不可见；
   - `schema.sql` 与 `database/migrations/` 手工维护，需要人工与 `store.ts` 保持同步。
2. **审计发现的既有实现缺陷与性能问题**：
   - **`PostgresStore.updateSession` 漏写了外部分发与工作区字段**：`bindExternal` 通过 `entity.flush(store)` 落库时，`updateSession` 未更新 `external_channel`、`external_conversation_id`、`external_thread_id` 与 `workspace_path`，导致渠道会话绑定状态在 PostgreSQL 中丢失；
   - **`sessions.cursors` 未持久化**：`SessionEntity` 与 `EventHub` 依赖 `cursors` 追踪各消费端（`web` / `feishu` / `wecom`）游标，但 `sessions` 表缺少 `cursors` 字段，导致 PostgreSQL 模式下重连回溯断点丢失；
   - **`PostgresStore.updateTurn` 存在冗余读与覆盖竞态**：每次更新先执行 `getTurn`（`SELECT`），再整行覆盖 6 个字段，多出 1 次无意义数据库往返；
   - **僵尸代码与未引用表**：`Store.pendingNotifications` 始终返回 `[]` 且无任何业务调用方；`database/schema.sql` 中的 `project_triggers` 与 `trigger_intents` 两张表在源码中零引用；
   - **`MemoryStore` 与 `PostgresStore` 行为不一致**：`MemoryStore.deleteSession` 未清理 `scheduledJobs`，`listNotificationDeliveries` 未按时间倒序，`listDueScheduledJobs` / `cancelScheduledJobById` 未过滤软删除记录，`actionExecutions` 返回字段与 `PostgresStore` 的 `bigint` string 类型不一致。
3. **单文件膨胀**：`Store` 接口、`MemoryStore`、`PostgresStore` 以及 9 张表的仓储逻辑混杂在 1,100+ 行单文件中，阅读与维护成本高。

---

## 2. 目标与非目标

### 目标

1. **引入 Drizzle ORM + Drizzle Kit**：以 TypeScript Schema（`src/persistence/schema.ts`）作为数据库表结构的唯一真实数据源（Single Source of Truth），全链路实现编译期类型安全。
2. **清理无用表与死代码**：
   - 移除未被引用的 `project_triggers` 与 `trigger_intents` 两张表，保留实际使用的 **9 张表**；
   - 删除无人调用的 `Store.pendingNotifications` 接口及实现。
3. **持久层模块化拆分**：保持对外 `Store` 接口与 `MemoryStore` / `PostgresStore` / `newSessionRoute` 导出兼容，内部按业务领域拆分为独立模块，控制单文件职责与体积。
4. **修复已有缺陷并优化性能与语义一致性**：
   - 修复 `updateSession` 漏写 `external_*`、`workspacePath`、`cursors` 的 bug；
   - `sessions` 表新增 `cursors` JSONB 列；
   - 将 `updateTurn` 改为单条按需局部 `UPDATE`；
   - 统一 `bigserial` / `bigint` 为 `mode: "number"`，保证 `MemoryStore` 与 `PostgresStore` 返回类型和排序/软删语义一致。
5. **简化数据库初始化（无历史库迁移包袱）**：数据库重建后统一使用 `drizzle-kit generate` 生成的初始迁移目录 `database/migrations/`，由 `bun run db:init` 执行 `drizzle-orm/node-postgres/migrator` 完成初始化；应用主进程启动时依然**不执行任何 DDL**。

### 非目标

- 不为旧数据库编写升级兼容脚本（按要求由用户重建 PostgreSQL 实例）。
- 不修改上层业务模块对 `Store` 接口的调用方式（保持 `src/gateway/`、`src/project/`、`src/session/`、`src/task/`、`src/actions/` 等零破坏）。
- 不更换底层连接池驱动：继续使用 `pg.Pool`（`drizzle-orm/node-postgres`），保持 `bun build --external pg` 与现有 `Dockerfile` 兼容。

---

## 3. Drizzle Schema 设计 (`src/persistence/schema.ts`)

保留并规范化实际使用的 9 张表，所有 `bigserial` / `bigint` 统一采用 `{ mode: "number" }` 避免返回字符串，JSONB 列全部通过 `.$type<T>()` 绑定强类型：

| 表名 | 所属领域 | 核心字段与索引说明 |
| :--- | :--- | :--- |
| `sessions` | 会话管理 | 保留既有字段与索引，**新增** `cursors: jsonb("cursors").$type<Record<string, number>>().notNull().default({})`；索引覆盖 `(session_id, deleted_at)` 唯一、`project_id`、`external_*`、`source` |
| `inbound_messages` | 渠道去重 | `message_id` 唯一索引，`(channel, conversation_id, thread_id, received_at)` 索引 |
| `turns` | 对话轮次 | `turn_id` 唯一索引，`(session_id, created_at, id)` 索引支持 `getLatestTurn` 快速定位 |
| `events` | 领域事件 | `event_id` 唯一索引，`(session_id, sequence)` 唯一索引 |
| `artifacts` | 工件记录 | `artifact_id` 唯一索引，`(session_id, created_at)` 索引 |
| `notification_deliveries` | 通知审计 | `delivery_id` 唯一索引；`configs` / `message` / `details` 均为强类型 JSONB |
| `task_executions` | 定时任务审计 | `execution_id` 唯一索引、`(task_key, id DESC)`、`(project_id, id DESC)`、部分索引 `WHERE status = 'success'` 用于状态恢复 |
| `scheduled_jobs` | 延时调度作业 | `job_id` + `deleted_at` 唯一索引；部分索引 `(status, trigger_at) WHERE status = 1 AND deleted_at = 0`；`(session_id, status) WHERE deleted_at = 0` |
| `action_executions` | Action 审计 | `execution_id` 唯一索引、`session_id`、`project_id`、`action_name` 索引 |

> 注：删除 `database/schema.sql` 与旧的手工增量文件 `database/migrations/20261118_*.sql`、`20261119_*.sql`，改由 `drizzle.config.ts` + `bun run db:generate` 在 `database/migrations/` 下生成全量迁移。

---

## 4. 目录结构与模块拆分

外部导入路径 `src/persistence/store.ts` 保持兼容（作为聚合导出入口或 re-export），内部拆分为清晰的子模块：

```text
src/persistence/
├── index.ts                # 统一导出 Store, MemoryStore, PostgresStore, newSessionRoute, schema
├── store.ts                # Store 接口定义、newSessionRoute 及兼容 re-export
├── schema.ts               # Drizzle pgTable 定义与 InferSelectModel/InferInsertModel 类型
├── db.ts                   # createDrizzleDb(pool) 与 DrizzleDatabase 类型
├── memory/
│   ├── index.ts            # MemoryStore 门面（组合各内存仓储并保持只读副本返回语义）
│   ├── session-store.ts    # sessions + inbound_messages 内存实现
│   ├── turn-event-store.ts # turns + events + artifacts 内存实现
│   └── task-audit-store.ts # task_executions + scheduled_jobs + notification_deliveries + action_executions
└── postgres/
    ├── index.ts            # PostgresStore 门面（管理 pg.Pool、Drizzle 实例与组合各 Repo）
    ├── mappers.ts          # 强类型行映射函数（接收 schema.$inferSelect，零 any）
    ├── session-repo.ts     # sessions + inbound_messages Drizzle 实现（含 deleteSession 事务）
    ├── turn-event-repo.ts  # turns（单条局部更新）+ events + artifacts Drizzle 实现
    └── task-audit-repo.ts  # task_executions + scheduled_jobs + notification_deliveries + action_executions
```

### 关键性能优化与代码清理点

1. **消除 `updateTurn` 二次查询**：
   ```ts
   const updates: Partial<typeof turns.$inferInsert> = {};
   if (patch.status !== undefined) updates.status = patch.status;
   if (patch.runtimeTurnId !== undefined) updates.runtimeTurnId = patch.runtimeTurnId;
   ...
   if (Object.keys(updates).length === 0) return;
   const updated = await db.update(turns).set(updates).where(eq(turns.turnId, turnId)).returning({ id: turns.id });
   if (updated.length === 0) throw new Error(`turn not found: ${turnId}`);
   ```
   将原本 `SELECT + UPDATE` 两次网络往返缩减为单条原子 `UPDATE ... RETURNING`，既消除竞态又减少 50% RTT。
2. **修复 `updateSession` 字段遗漏**：
   显式同步 `projectId`、`projectRuntimeId`、`runtimeSessionId`、`configRevision`、`status`、`lastActiveAt`、`metadata`、`cursors`、`workspacePath`、`externalChannel`、`externalConversationId`、`externalThreadId`、`source`、`runtime` 与 `updatedAt`，同时严守契约：**绝不在此覆盖 `title`**。
3. **显式列投影与避免无效拷贝**：
   - `getLatestTaskExecutionState` 只查询 `{ stateAfter: taskExecutions.stateAfter }`；
   - `getLatestEventSequence` 只查询 `max(events.sequence)`；
   - `MemoryStore` 对外返回受控拷贝，避免调用方意外修改内部缓存对象，同时补齐 `scheduledJobs` 清理、`deletedAt === 0` 过滤与排序对齐。
4. **`deleteSession` 事务原子性**：
   使用 `await db.transaction(async (tx) => { ... })` 在同一个事务里软删除 `scheduled_jobs` 与 `sessions`，并删除关联的 `inbound_messages` 去重记录，避免出现异常重启后的孤立索引键。
5. **精简 `listNotificationDeliveries` 与 `listActionExecutions` 边界**：
   对 `limit` 做统一边界归一化（如 `clampLimit(limit, 50, 200)`），在 Drizzle 中使用动态条件数组 `and(...conditions)` 替代脆弱的 `$1/$2` 下标拼接。

---

## 5. 数据库初始化与构建配置

- **新增配置文件**：根目录 `drizzle.config.ts`：
  ```ts
  import { defineConfig } from "drizzle-kit";

  export default defineConfig({
    schema: "./src/persistence/schema.ts",
    out: "./database/migrations",
    dialect: "postgresql",
  });
  ```
- **NPM/Bun 脚本**（`package.json`）：
  - `db:generate`: `drizzle-kit generate`
  - `db:init`: `bun run scripts/init-database.ts`（内部改为调用 `migrate(db, { migrationsFolder })`）
- **应用运行时零 DDL 原则不变**：`src/main.ts` 与 `PostgresStore` 不引入 migrator，保持仅在显式运维命令 `bun run db:init` 时执行迁移；`Dockerfile` 已包含 `COPY database ./database` 与 `COPY scripts/init-database.ts ./scripts/init-database.ts`，无需额外修改镜像结构即可在容器内运行 `bun run db:init`。

---

## 6. 实施阶段与测试计划

### 原子提交拆解

1. **`docs: add drizzle persistence refactor design`**
   - 提交本设计文档。
2. **`build: add drizzle orm and drizzle kit`**
   - 安装 `drizzle-orm`（dependencies）与 `drizzle-kit`（devDependencies）；
   - 添加 `drizzle.config.ts` 与 `db:generate` 脚本。
3. **`feat: define drizzle schema and replace manual sql migrations`**
   - 新增 `src/persistence/schema.ts` 与 `src/persistence/db.ts`；
   - 删除旧 `database/schema.sql` 与手工 SQL 迁移文件，运行 `bun run db:generate` 生成干净的初始 Drizzle 迁移；
   - 更新 `scripts/init-database.ts` 使用 Drizzle `migrate()`；
   - 更新 `tests/database-schema.test.ts` 校验 Drizzle Schema 与初始化边界。
4. **`refactor: split persistence store and migrate postgres store to drizzle`**
   - 拆分 `src/persistence/memory/` 与 `src/persistence/postgres/`；
   - 移除 `pendingNotifications`；修复 `updateSession`（外部分发字段、工作区路径、`cursors`）与 `updateTurn`（单条局部更新）；对齐 `MemoryStore` 与 `PostgresStore` 行为；
   - 补充持久层单元测试（覆盖 `MemoryStore` 边界与 `PostgresStore` SQL/参数映射验证或 mock pool 测试）。
5. **`docs: update database guidelines for drizzle`**
   - 更新 `AGENTS.md`、`README.md`、`README_zh.md` 中的数据库与迁移说明，并将本设计状态更新为 `Accepted`。

### 验证标准

- `bun run check`（`typecheck` + `lint` + `bun test`）全部通过；
- `bun run build` 后端构建通过（确认 `--external pg` 正常打包 `drizzle-orm`）；
- 使用 `drizzle-kit generate` 验证 Schema 与生成的 SQL 迁移一致性（`No schema changes`）；
- 本机不连接外部业务项目，不跑 `projects/` 中的任何 Agent。
