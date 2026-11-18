# 03 - 代码审查修复方案

| Metadata          | Details                                                                       |
| :---------------- | :---------------------------------------------------------------------------- |
| **Document ID**   | `03-code-review-remediation`                                                  |
| **Status**        | `Accepted`（已实施，见第 5 节）                                               |
| **Created At**    | 2026-11-18                                                                    |
| **Target Module** | `src/project/`, `src/runtime/`, `src/workspace/`, `src/gateway/`, `src/config/` |
| **Code Baseline** | `main@03e61a8` + 工作区未提交改动（含 Pi 适配器最新版本）                     |

---

## 1. 概述

本文整理本轮代码审查中确定要修的问题，以及影响长期维护、必须清理的 workaround。

- 要修的审查问题：4、5、6、7、9、11、13。
- 第 8 项（定时 job 竞态）按决定跳过。
- 第 1、2、3 项（默认不鉴权、token 写进 `.git/config`、本地仓库可能被 `reset --hard`）本轮未纳入，列在第 4 节末尾备忘。

每一项按三段写：**现象**（现在代码的实际行为）、**为什么改**、**修改方案**，最后附测试要点。代码位置以 `文件:行号` 标注，行号对应上面的基线。本文只是方案，代码尚未修改。

---

## 2. 审查问题

### 2.1 [#4] dispatch 出来的会话被当成 task，永远不会回收

**现象**

- `dispatch_agent_task` 创建会话时传了 `source = "task"`（`src/project/runtime.ts:214`），并把 agent 传来的 `metadata` 原样展开到会话元数据顶层。
- 「是不是 task 会话」在三处各自推断：
  - `createSession` 根据 `metadata.taskType/taskKey` 推算（`runtime.ts:340-344`）；
  - `listSessions` 的过滤条件（`store.ts:136,492`）；
  - 生命周期判断（`runtime.ts:1013`）。
- `listSessions` 默认排除 task 会话，而全仓库没有任何地方传 `includeTasks`。所以 `manageSessionLifecycles` 里「task 会话立即清理」那个分支是**死代码**。
- 结果：dispatch 出来的会话不会被挂起或归档，也没有人调用 `cleanupSession`。worktree、运行时会话、Codex thread 会一直累积，而且在会话列表里看不到。
- HTTP 创建会话接口允许客户端自己填 `source`（`gateway/routes/sessions.ts:33,49`），填 `"task"` 就能造出同样的「隐形会话」。

**为什么改**

- task 会话应该只有一个含义：由定时任务引擎创建，任务跑完由执行器自己清理。dispatch 是 agent 派生的普通工作会话，用户需要看得到、能接着对话，并且走正常的闲置挂起和归档流程。
- 现在的分类靠三处推断，还能被 agent 传的 metadata（比如带上 `taskKey`）或客户端传的 `source` 改变，这是资源泄漏的根源。

**修改方案**

1. **`source` 作为唯一依据，并且只由服务端决定。** 在 `domain/types.ts` 定义 `SessionSource = "web" | "api" | "feishu" | "wecom" | "task" | "dispatch"`。只有 `agentRunner.createSession`（定时任务引擎的入口）可以传 `task`。
2. **dispatch 会话使用 `source = "dispatch"`，按普通会话处理。** `onDispatchTask` 改为：
   - 不传 `taskKey`，只保留 `sourceSessionId`、`sourceTaskKey` 作为溯源字段；
   - agent 传来的 metadata 收进 `metadata.dispatch` 子对象，不再展开到顶层，避免覆盖 `taskKey`、`taskType`、`runtime` 等保留字段。
3. **删除所有基于 metadata 的推断。** `createSession` 不再从 `metadata.taskType/taskKey` 推算 source；`listSessions` 的 SQL 和 Memory 版过滤都只看 `source != 'task'`。
4. **删除生命周期里的死分支**（`runtime.ts:1013-1020`）。task 会话由 `AgentTaskExecutor` 的 `cleanupSession` 负责清理。另外在 `ProjectRuntime.start()` 加一次启动对账，处理「进程在任务中途崩溃」的情况：用 `includeTasks: true` 查出状态不是 `closed` 的 task 会话，逐个执行 `cleanupSession(..., { deleteFromStore: false })`。
5. **HTTP 入口不再信任客户端传的 `source`。** `routes/sessions.ts` 按入口固定为 `web` 或 `api`，渠道入口使用各自的渠道名。
6. **数据迁移。** 已有的 dispatch 会话（`source = 'task'` 且 metadata 里有 `sourceSessionId`）改为 `dispatch`。这是一条一次性 SQL，放在 `scripts/` 下。

**测试**

- dispatch 创建的会话出现在 `listSessions` 结果里，并在闲置超时后被挂起。
- agent 传 `metadata: { taskKey: "x" }` 时，会话仍然是普通会话，action scope 是 `conversation`。
- 定时任务会话跑完后状态为 `closed`；服务重启时，残留的 `active` 状态 task 会话会被清理。

---

### 2.2 [#5] Codex 子进程重启竞态与「半初始化」进程

**现象**

- 读循环在进程退出后会无条件执行 `this.process = undefined`、`this.contexts.clear()`，并 reject 所有待处理请求（`src/runtime/codex.ts:403-416`）。它清理的是「当前」状态，而不是「自己那个进程」的状态。如果 `stop()` 之后已经启动了新进程，旧进程的读循环退出时会把新进程的句柄和会话上下文一并清空。
- `ensureStarted` 在 `initialize` 之前就给 `this.process` 赋值了（`:181`），`finally` 又把 `this.started` 置空。一旦 `initialize` 失败或超时，下次调用会看到 `this.process` 存在而直接返回，得到一个没有完成初始化的进程。之后所有请求都会超时，直到进程自己退出。
- `stop()` 只调用 `kill()`，不等进程真正退出。
- `handleDynamicToolCall` 是一个没人 await 的 async 函数（`:446`），内部没有 try/catch。如果 `write` 时进程已经退出，会产生未处理的 Promise rejection，Codex 那边也收不到工具调用结果。

**为什么改**

- 重启和崩溃恢复是长时间运行服务的常规路径。现在的写法下，一次初始化失败就会让整个项目的运行时卡死，只能重启服务。
- AGENTS.md 明确要求「不要留下未处理的 promise」。

**修改方案**

1. **引入连接对象，状态跟着进程走。** 新增内部类 `CodexConnection { proc, pending, nextId, closed }`，把读循环、请求表、写入都挂在连接上。读循环结束时只清理自己的连接，然后执行 `if (this.conn === conn) this.conn = undefined`。
2. **初始化成功后才对外可见。** `ensureStarted` 改为：
   - spawn → 在局部 `conn` 上执行 `initialize`、`initialized`、`skills/extraRoots/set` → 全部成功后才赋值 `this.conn = conn`；
   - 失败时 kill 掉这个进程并抛出错误，下次调用重新 spawn；
   - `this.starting` 这个 promise 只在完成后（无论成功还是失败）清空，并发调用共享同一个 promise。
3. **`stop()` 等进程退出。** 设置 `stopping` → `proc.kill()` → `await Promise.race([proc.exited, 超时 5s 后 SIGKILL])` → reject 这个连接上所有未完成的请求。
4. **断线时的会话处理。** 连接退出时，对该连接上登记过的会话发出 `runtime.disconnected` 事件（保持现有行为），会话上下文表也按连接维护。
5. **动态工具调用加兜底。** `handleDynamicToolCall` 整体包在 try/catch 里：执行异常时回复 `success: false` 和错误文本；写回失败时只记日志。调用点改为 `void this.handleDynamicToolCall(...).catch(log)`。

**测试**（使用 `tests/codex.test.ts` 现有的假二进制机制）

- `stop()` 后立即触发新请求：新进程正常工作，旧进程的退出不影响新进程。
- 让假进程对 `initialize` 返回错误：第一次调用失败，第二次调用会重新 spawn 并成功。
- 工具调用期间杀掉进程：没有未处理的 rejection。

---

### 2.3 [#6] 关闭会话时中断超时，会话永久卡在 closing

**现象**

- `closeSession` 一开始就把会话切到 `closing`（`runtime.ts:408`），然后对正在运行的 turn 执行 `await this.interrupt(sessionId)`（`:419`）。
- `interrupt` 内部用 `bounded()` 等 turn 结束，默认 10 秒超时，超时就抛出 `turn interrupt timed out; workspace retained`。这个异常在 `closeSession` 里没有被捕获。
- 后果：
  - `cleanupSession` 直接 reject，后面的「释放运行时会话、删除 worktree、写 closed 状态」都不会执行；
  - 会话停在 `closing`：`turn()` 拒绝新消息，生命周期任务跳过 `closing` 状态的会话，状态机也不允许从 `closing` 回到 `active`；
  - 只能手动改数据库才能恢复。
- 运行时卡住时（例如 #9 中 Codex 等不到审批回复）最容易触发这种情况。

**为什么改**

关闭是兜底操作，必须保证一定能完成。现在它反而依赖运行时配合，运行时越不正常，越关不掉。

**修改方案**

1. **关闭流程改为「尽力而为、一定完成」。** `closeSession` 的每一步单独 try/catch 并记录日志，失败不影响后续步骤；最终状态写入放在 `finally` 里。
2. **中断超时就强制结束 turn。** 捕获 `interrupt` 的超时后，调用 `finishTurn(id, active, "interrupted", "interrupt timed out during close")`。这样 pump 里的 `await completed` 能返回，turn 记录也会落库。之后继续执行 `releaseSession`：Codex 是 `thread/unsubscribe`，Pi 需要在 release 时先 `abort()` 再 `dispose()`，确保运行时不再推送这个会话的事件。
3. **去掉误导性的错误文案** `workspace retained`：关闭流程无论如何都会删除 worktree。
4. **启动对账。** 在 `ProjectRuntime.start()` 中，对状态是 `closing` 的会话重新执行一次 `cleanupSession`，回收上次进程留下的半关闭会话。可以和 #4 的 task 会话对账放在同一个函数里。

**测试**

- 使用一个 `interruptTurn` 永远不产生 `turn.interrupted` 的假运行时：`cleanupSession` 在超时后正常返回，状态为 `closed` 或已删除，worktree 被删除，turn 状态为 `interrupted`。
- 启动时数据库里存在 `closing` 状态的会话：启动后该会话被清理。

---

### 2.4 [#7] 每次操作都重新同步工作区

**现象**

`ProjectRuntime.workspacePath(route)`（`runtime.ts:784`）本该只是「取路径」，实际调用的是 `workspaces.ensure()`，再进入 `ensureSessionWorkspaces()`（`workspace.ts:416` 起）。这一次调用会做这些事：

1. 执行项目的 `scripts/sync.sh`；
2. 对每个仓库执行 `ensureBase`：`git fetch --all --prune`，然后 `merge --ff-only`（失败就 `reset --hard`），再 `worktree prune`，并写 2~3 次 `git config`；
3. 检查 worktree 是否存在，不存在就 `git worktree add -B`；
4. 在 worktree 里再写 2~3 次 `git config`（user.name、user.email、认证）。

调用 `workspacePath()` 的地方包括：

- 每一轮 `runTurn`（`:732`）；
- `steer`（`:651`）、`interrupt`（`:674`）、`compact`（`:687`）、`approve`（`:699`）；
- `closeSession`（`:435`）；
- 生命周期的挂起和归档（`:1051`）。

带来的后果：

- 每发一条消息，都要先等一次网络 fetch 和项目脚本执行。中断、审批这类本应立即生效的操作，也要排队等 git。同一个基础仓库上的所有会话共用一把 worktree 锁，并发会话因此被串行化。
- 关闭一个已归档的会话时，worktree 已经删了，`workspacePath()` 会**先把 worktree 重新建出来，再删掉**。挂起会话时也一样。
- 用户的 `sync.sh` 会在每条消息、每次中断时被执行，这和脚本作者的预期不符。
- 在 worktree 里执行 `git config` 实际写入的是基础仓库的共享配置（没有开启 `extensions.worktreeConfig`），每个会话写一遍纯属重复。

根源在于「解析路径」和「准备工作区」两件事被合并成了同一个函数，而调用方只需要前者。

**为什么改**

性能、延迟和副作用三方面都有问题，而且控制类操作的可用性被绑在了网络和外部脚本上。

**修改方案**

1. **拆分 `WorkspaceManager` 的接口**

   | 方法 | 做什么 | 谁调用 |
   | :--- | :--- | :--- |
   | `resolveSessionPaths(project, sessionId)` | 纯计算，不做任何 IO，返回 `{ sessionRoot, repoPaths, primaryPath }` | 需要路径的地方 |
   | `syncBase(project, repo, { force? })` | fetch 并更新基础仓库，带最小间隔（新配置 `workspace.baseSyncIntervalMs`，默认 5 分钟），间隔内直接返回 | 启动时、创建会话前 |
   | `prepareSession(project, sessionId)` | 执行 `syncBase` 并创建 worktree，git 身份和认证只在这里写一次 | 仅 `createSession`，以及发现 worktree 丢失时 |
   | `isSessionReady(project, sessionId)` | 检查各仓库的 `.git` 是否存在，只做 `stat` | `runTurn` |
   | `removeSession(project, sessionId)` | 保持现状 | 关闭、归档 |

2. **路径在创建会话时落库。** `SessionRoute` 增加 `workspacePath` 字段（Postgres 新增一列，也可以先放在 metadata 里过渡）。`ProjectRuntime.workspacePath(route)` 改为直接返回这个字段；老数据没有这个字段时，用 `resolveSessionPaths` 计算，不做任何 IO。
3. **只有 `runTurn` 检查工作区。** 每轮开始时先调用 `isSessionReady`，缺失才调用 `prepareSession` 并记录警告。正常情况下一轮 turn 不执行任何 git 命令。
4. **控制类操作完全不碰 git。** `steer`、`interrupt`、`compact`、`approve`、`closeSession`、挂起和归档只使用落库的路径构造运行时上下文；关闭和归档直接调用 `removeSession`。
5. **`sync.sh` 的语义收敛为「同步基础仓库前执行」。** 它跟随 `syncBase` 的间隔执行，即只在启动时和创建会话（且超过间隔）时运行。在 `projects/AGENTS.md` 里写明这一点。
6. **git 命令执行器改为可注入。** 把 `workspace.ts` 里模块级的 `run()` 改为构造函数注入的 `GitRunner`，这样测试可以统计调用次数；同时用注入的 `Logger` 替换 `console.warn`。

相关但不在本项范围内：`syncBase` 对用户本地仓库执行 `reset --hard` 的问题（审查 #3）就在这条路径上，建议拆分时顺手把「受管的基础仓库」和「用户本地仓库」区分开，后者只 fetch，不 reset，也不改 config。

**测试**

- 创建会话后连续发送两轮消息：第二轮期间 git 调用次数为 0，`sync.sh` 没有被执行。
- 对一个正在运行的 turn 执行 interrupt 或 approve：git 调用次数为 0。
- 关闭一个已归档的会话：不会出现 `worktree add`。
- 手动删除 worktree 目录后发消息：worktree 被重建，并记录一条警告。
- 在 `baseSyncIntervalMs` 之内连续创建两个会话：只执行一次 fetch。

---

### 2.5 [#9] Codex 发来的请求一律当审批处理，部分请求永远得不到回复

**现象**

- Codex app-server 会主动向客户端发请求（带 `id` 的 JSON-RPC 请求）。`handle()`（`codex.ts:440-461`）的处理方式：
  - `item/tool/call` 交给动态工具处理；
  - **其他所有请求**，只要带 threadId 并且找得到会话上下文，就改名为 `approval/requested` 发出去。原始方法名丢失，下游无法区分命令执行审批、文件修改审批、权限申请、MCP elicitation、用户输入请求、token 刷新等不同请求。
  - 没有 threadId，或者找不到上下文（会话已挂起、已释放、服务刚重启），请求被**直接丢弃，不做任何回复**。Codex 会一直等待，这一轮因此卡住，最终只能靠中断超时解决（并进一步触发 #6）。
- 初始化时声明了 `mcpServerOpenaiFormElicitation: true` 能力（`:206`），实际并没有实现对应处理。
- `respondToApproval` 把调用方传来的任意 `result` 直接写回（`:607`）：不检查 requestId 是否真的在等待回复，`Number(requestId)` 可能得到 NaN，结果结构也没有按方法区分。
- 仓库里已经生成了完整的协议类型 `src/runtime/codex/generated/ServerRequest.ts`，共 10 种请求，但没有任何地方引用。

**为什么改**

- 卡住的 turn 是线上最难排查的问题之一，而且这里是必现的：只要 Codex 发出一个找不到上下文的请求就会发生。
- 不同请求需要不同的响应结构，例如命令执行审批的响应是 `{ decision: "accept" | "decline" | "cancel" | ... }`。统一当成审批处理，等于把协议正确性交给了调用方去猜。

**修改方案**

1. **按生成的 `ServerRequest` 联合类型分发**，用 `switch (method)` 穷举，并加上 `never` 检查。这样以后协议更新、重新生成类型时，编译器会直接指出漏处理的方法。

   | 请求方法 | 处理方式 |
   | :--- | :--- |
   | `item/tool/call` | 动态工具（保持现状） |
   | `item/commandExecution/requestApproval`、`execCommandApproval` | 发出 `approval.requested`，`actionType: "command"`，带上原始方法名和类型化参数 |
   | `item/fileChange/requestApproval`、`applyPatchApproval` | 发出 `approval.requested`，`actionType: "file_change"` |
   | `item/permissions/requestApproval` | 发出 `approval.requested`，`actionType: "permissions"` |
   | `mcpServer/elicitation/request`、`item/tool/requestUserInput` | 第一版直接回复拒绝或取消，同时去掉 `mcpServerOpenaiFormElicitation` 能力声明；以后真正支持时再打开 |
   | `account/chatgptAuthTokens/refresh`、`attestation/generate` | 回复 JSON-RPC 错误 `-32601`：服务使用 API key 认证，不支持这两种请求 |
   | 未知方法 | 回复 `-32601`，记录警告，并发出 `runtime.unmapped` 事件 |

2. **找不到上下文时自动拒绝，绝不悬空。** 审批类请求回复 `decline`，其他请求回复 JSON-RPC 错误，同时记录 `sessionId` 和 `method`。
3. **在连接上维护待审批表** `pendingApprovals: Map<requestId, { method, sessionId, createdAt }>`：
   - `respondToApproval` 先查表，查不到就抛出 `approval_not_found`，网关返回 404；
   - 调用方传入统一的决定 `{ decision: "approve" | "deny" | "cancel" }`，由适配器按 `method` 转换成协议要求的响应结构；
   - 会话释放、连接断开时，把该会话所有待审批的请求回复 `cancel` 后清空。
4. **可选：审批超时。** 增加配置 `runtime.approvalTimeoutMs`，超时自动回复 `decline`，并发出 `approval.resolved`（附带 `reason: "timeout"`）。

**测试**

- 每种请求方法各一个用例，断言回复结构与生成的类型一致。
- 找不到上下文的审批请求：立即收到 `decline`。
- 对不存在的 requestId 调用审批接口：返回 404，并且不会向 Codex 写入任何内容。
- 释放会话时还有待审批请求：Codex 收到 `cancel`。

---

### 2.6 [#11] 恢复会话失败时静默新开会话，历史丢失

**现象**

- Codex：`thread/resume` 报错，且错误信息里含 `"no rollout found"` 时，直接 `startSession` 新建一个 thread（`codex.ts:543`）。判断依据是错误字符串匹配。
- Pi：`SessionManager.list` 找不到对应 id 时，空 catch 吞掉错误，然后新建会话（`pi/runtime.ts:310-321`）。
- 这两种情况都没有任何事件通知上层。`runTurn` 用新 id 覆盖了 `runtimeSessionId`（`runtime.ts:746-750`），用户看到的仍是原来的会话，但 agent 已经不记得之前的对话。
- 项目从 Codex 切换到 Pi（或反过来）时，`runTurn` 只打一条警告（`runtime.ts:739-745`），然后把 Codex 的 thread id 交给 Pi 去恢复。Pi 找不到这个 id，又走一遍静默新建。
- 另外 `runTurn` 每一轮都会调用 `resumeSession`，Pi 每次都会发一条 `session.resumed` 事件并写入事件日志。

**为什么改**

- 对话上下文丢失是用户能直接感知的问题，静默发生会让人误以为 agent 「失忆」或出现了 bug。
- 用错误字符串判断，版本一升级就可能失效；空 catch 还会把权限、IO 等真正的错误一并吞掉。

**修改方案**

1. **定义类型化错误。** 在 `runtime/runtime.ts` 增加 `RuntimeSessionNotFoundError`：
   - Codex 适配器把「找不到会话」的判断收敛到一个函数里：优先用 JSON-RPC 错误码判断，没有错误码时再用字符串匹配，并配套测试锁定行为；
   - Pi 适配器在列表里找不到 id 时抛出这个错误，其他异常照常抛出，去掉空 catch。
2. **由 `ProjectRuntime` 统一决定如何处理。** `runTurn` 捕获 `RuntimeSessionNotFoundError` 后：新建运行时会话，绑定新 id，并发出一个新的标准事件 `session.runtime_reset`，payload 为 `{ reason: "not_found" | "runtime_changed", previousRuntimeSessionId, runtime }`。前端在对话流里显示一条系统提示，例如「运行时会话已重置，之前的上下文不可用」。
3. **运行时变更时不再交出别家的 id。** 如果 `route.runtime !== currentRuntime`，直接新建会话，发出 `session.runtime_reset`（`reason: "runtime_changed"`），并更新 `route.runtime`。
4. **每个进程只恢复一次。** `ProjectRuntime` 维护一个「已绑定」集合：恢复成功后加入，`releaseSession`（挂起、关闭）时移除。只有不在集合里的会话才调用 `resumeSession`。这样也解决了 Pi 每轮发 `session.resumed` 的问题。
5. **依赖 #7。** Pi 的会话列表按工作目录区分。#7 把 `workspacePath` 落库之后，路径保持稳定，因为路径变化导致「找不到会话」的情况也会随之消失。

**测试**

- 假运行时在 resume 时抛出 `RuntimeSessionNotFoundError`：发出 `session.runtime_reset`，turn 正常完成，`runtimeSessionId` 被更新。
- 运行时抛出其他错误：turn 失败，**不会**新建会话。
- 项目运行时类型变更后发消息：不会调用旧 id 的 `resumeSession`。
- 同一会话连续发两轮消息：`resumeSession` 只被调用一次。

---

### 2.7 [#13] 会话标题依赖魔法字符串

**现象**

- 默认标题有三种写法：
  - `ProjectRuntime.createSession` 默认 `"New Session"`（`runtime.ts:352`）；
  - Postgres 的 `createSession` 默认 `"新会话"`（`store.ts:419`），表结构里也是 `DEFAULT '新会话'`（`database/schema.sql:7`）；
  - 前端兜底显示 `"新会话"`。
- 「标题是否还是默认值」靠比对 `"新会话"` 和 `"New Chat"` 判断，散落在三处：
  - Memory 版 `updateSession`（`store.ts:146-158`），而且会直接修改调用方传入的对象；
  - Postgres 的 UPDATE 语句里 `COALESCE(NULLIF(NULLIF($9, '新会话'), 'New Chat'), title)`（`store.ts:530`）；
  - `GatewayService.submitTurn`（`service.ts:132`）。
- `"New Session"` 不在比对名单里。从 Web 新建一个空会话（标题为 `New Session`）后再发第一条消息，`submitTurn` 判断「已有标题」，不会自动生成标题。
- 自动生成标题失败时，会把标题写成 `"新会话"`（`service.ts:215`）。
- `renameSession` 通过 `(project as any).emit(...)` 调用了 `ProjectRuntime` 的私有方法（`service.ts:147`）。

**为什么改**

把界面文案当作持久层的「哨兵值」，任何一处改文案、加语言都会破坏逻辑，SQL 也被迫写死中英文字符串。`flush` 顺带写标题的设计，正是「标题被覆盖」这类问题需要打补丁的原因。

**修改方案**

1. **「还没有标题」用 `null` 表示。** 后端不再出现任何默认标题字符串；前端显示 `title ?? t("session.untitled")`。
2. **标题只通过专门的方法修改。**
   - `store.renameSession(id, title)`：用户手动改名，总是覆盖。
   - `store.setTitleIfEmpty(id, title)`：自动生成标题时使用，SQL 为 `UPDATE sessions SET title = $2 WHERE session_id = $1 AND title IS NULL`，原子操作，不会覆盖用户已设置的标题。
   - `updateSession`（也就是 `flush`）**不再写 `title` 列**。去掉 `COALESCE/NULLIF`，Memory 版也不再修改入参。
3. **自动生成标题的触发条件改为 `title == null`**，`createSession` 和 `submitTurn` 共用同一个判断。生成失败或结果为空时保持 `null`，不写占位字符串。
4. **改名操作收回到 `ProjectRuntime`。** 新增公开方法 `ProjectRuntime.renameSession(id, title, source)`：更新实体和存储，并发出 `session.renamed` 事件。网关直接调用它，去掉 `as any`。
5. **数据迁移。** `schema.sql` 去掉 `DEFAULT '新会话'`；另写一个一次性脚本：`UPDATE sessions SET title = NULL WHERE title IN ('新会话', 'New Chat', 'New Session')`。

**测试**

- Web 新建空会话后发送第一条消息：会自动生成标题。
- 用户改名后，自动生成的标题姗姗来迟：用户的标题保持不变。
- `flush` 不会改动标题。

---

## 3. 必须清理的 workaround

只列出会影响长期维护的部分。纯风格问题和只在关闭流程使用的轮询等待等不在此列。

### 3.1 Codex 事件归一化没有使用生成的协议类型

**现象**：`codex-normalizer.ts` 对每种方法同时匹配两种写法（例如 `"turn/completed"` 和 `"turn.completed"`），字段大量用 `??` 猜测位置（`params.delta ?? params.text ?? item.text`），找不到 id 时用 `Date.now()` 拼一个；整个文件里 `any` 随处可见。生成的 `ServerNotification` 类型从未被引用。

**为什么改**：协议升级时既不会报错也不会提示，事件只会悄悄缺字段或者落到 `runtime.unmapped`。`Date.now()` 生成的 itemId 在同一毫秒内可能重复，前端按 itemId 合并消息时会出错。

**修改方案**：以 `ServerNotification` 联合类型为输入，按 `method` 穷举分发，删除点号写法和字段猜测。itemId 一律使用协议里的 id，缺失时视为协议错误，记录日志并发出 `runtime.unmapped`。测试用例按生成的类型构造输入数据。与 #9 一起做。

### 3.2 Codex 配置透传和 TOML 处理

**现象**

- `runtimes.codex` 和 `project.runtime` 里**所有未识别的字段**都会被 `deepMerge` 写进 Codex 的 `config.toml`（`codex.ts:264-306`）。项目配置里给 Pi 用的 `provider`、`apiKey`、`baseUrl`、`thinkingLevel`、`providers` 等字段，切到 Codex 时也会被写进去，`apiKey` 因此明文落盘。
- `parseToml` 解析失败时返回 `{}`（`:112-116`）：基础配置文件写错了不会报错，只会被悄悄忽略。
- `stringifyToml` 的降级分支会输出 JSON 格式，嵌套对象时不是合法 TOML（`:132-134`）。本机 Bun 1.4.4 自带 `Bun.TOML.stringify`，这个分支实际是死代码。

**为什么改**：配置边界不清，一个运行时的字段会污染另一个运行时，排查配置问题时无从下手；解析失败被静默吞掉，同样让问题难以定位。

**修改方案**

- `project.runtime` 改为按 `type` 区分的 zod 联合类型（codex、pi、fake 各有自己的 schema），未知字段直接报错。
- 需要直接透传给 Codex 的配置，统一只走 `runtimes.codex.config` 和 `project.runtime.config` 这个显式入口。
- `parseToml` 失败时抛出带文件路径的错误。删除 stringify 的降级分支，并在 `package.json` 的 `engines` 里锁定最低 Bun 版本。

### 3.3 运行时数据目录写死

**现象**：`.data/codex/<project>`（`codex.ts:164`、`runtime.ts:253`）和 `.data/pi/<project>`（`pi/runtime.ts:275`）都是相对于进程当前目录写死的，不跟随 `storage.dataDir`。

**为什么改**：服务从其他目录启动、或者容器里配置了 `dataDir` 时，运行时数据会写到别的地方，备份和清理都会漏掉。

**修改方案**：`RuntimeFactoryContext` 增加 `dataDir` 字段，各运行时使用 `join(dataDir, "<runtime>", project.id)`。

### 3.4 通用层里写死了 Codex 专属逻辑

**现象**：`ProjectRuntime.start()` 判断项目运行时是否为 Codex，是就同步 skills 到 Codex home（`runtime.ts:246-262`）。这和 `CodexRuntime.ensureAuthAndConfig` 里的同步逻辑重复，codexHome 路径也算了两遍。

**为什么改**：每接入一个新运行时（Pi、以后的 Claude Code），通用层就要多一个 `if`。

**修改方案**：删除这段代码。如果确实需要在启动时预热，就在 `AgentRuntime` 上增加可选钩子 `prepare?(project)`，由各运行时自己实现。

### 3.5 运行时和上层的事件职责没有约定

**现象**

- `session.started`、`session.resumed`、`session.closed` 由运行时和 `ProjectRuntime` 各发一份，并且各运行时行为不一致：Codex 不发；Pi 发，而且 `releaseSession` 时发 `session.closed`。挂起会话也会调用 `releaseSession`，所以**被挂起的会话会出现一条 `session.closed` 事件**；真正关闭时又重复一条。
- Pi 的 `steerTurn` 往助手消息流里塞了一条伪造的 `[Steer] ...` 文本（`pi/runtime.ts:170`）。`FakeRuntime` 也这样做。
- `turn.interrupted` 有时由 Pi 自己发出，有时由服务端通知触发。

**为什么改**：前端和下游消费者没法依赖事件的语义。接入 Claude Code 时只会再多出一套不同的行为。

**修改方案**

- 在 `runtime/runtime.ts` 的 `AgentRuntime` 文档注释里写明约定：
  - **运行时只发**：内容事件（`agent.*`、`command.*`、`file_change.*`、`tool.*`、`mcp_call.*`）、`approval.requested`、turn 的终态（`turn.completed`、`turn.failed`、`turn.interrupted`）、`runtime.disconnected`；
  - **会话生命周期事件**（`session.*`）和 `turn.queued`、`turn.started` 只由 `ProjectRuntime` 发出。
- 删除 Pi 和 Fake 里的 `session.*` 和伪造的 steer 消息。steer 需要留痕的话，由 `ProjectRuntime.steer` 发出 `turn.steered` 事件。
- `ProjectRuntime.processRuntimeEvent` 丢弃运行时发来的 `session.*` 事件，并加一条测试断言，防止以后再出现。

### 3.6 Pi 适配器

Pi 最新版本已经让 `settings` 生效（改为使用 `SettingsManager.inMemory`），去掉了写死参数的兜底模型，`tests/pi-runtime.test.ts` 12 个用例全部通过。剩余需要改的点如下：

| 现象 | 为什么改 | 修改方案 |
| :--- | :--- | :--- |
| 配置的模型找不到时，静默使用 `getAvailable()` 的第一个模型（`resolveModelAndTools`） | 配置写错时，不会报错，而是换了一个模型继续跑，成本和行为都会悄悄变化 | 显式配置了模型但找不到时，抛出错误并列出可用模型；只有完全没有配置模型时才使用默认值 |
| 没有配置 `agentDir` 时，`ModelRuntime.create({})` 读取宿主机的 `~/.pi/agent/auth.json` 和 `models.json`；会话数据却写在 `.data/pi/<project>` | 服务会悄悄使用部署机器上的个人凭证；两份数据目录不一致 | `ModelRuntime.create` 始终传入解析后的 `agentDir` 路径，与会话目录保持一致 |
| 每次 `setupSession` 都重新 `registerProvider` 和 `setRuntimeApiKey` | 每次建会话都修改共享的 `ModelRuntime`，行为依赖调用顺序 | 在构造函数或首次初始化时注册一次 |
| 配置别名过多：`defaultProvider`/`provider`、`defaultModel`/`model`、`project.agent.model`、`thinkingLevel`/`reasoningEffort` | 同一个含义有多个入口，优先级只能靠读代码才能知道 | 只保留 `defaultProvider`、`defaultModel`、`providers`、`thinkingLevel`，其余别名删除，项目级覆盖使用同名字段 |
| 新增的顶层扁平 `pi` 配置兼容（`config/service.ts:161-167`） | Pi 是新运行时，没有需要兼容的老配置，这是在新代码里制造历史包袱 | 删除 |
| 压缩会话时用错误字符串匹配 `"Nothing to compact"` | SDK 文案一变，逻辑就会失效 | 先查 SDK 是否提供前置判断或类型化错误；没有的话，把判断收敛到一个函数里并写测试锁定 |
| `pi/` 和 `registry.ts` 一共有 14 处 `any` | 违反 AGENTS.md 的规定，配置错误要到运行时才会暴露 | 给 `PiRuntimeConfig` 定义 zod schema，启动时校验，工厂函数接收已校验的类型 |
| `releaseSession` 只调用 `dispose()`，不中断正在运行的 turn | 关闭会话时 turn 可能仍在后台运行（见 #6） | 先 `abort()`，等待 `activeTurnPromise`（设上限），再 `dispose()` |

### 3.7 配置兼容层

**现象**

同一份配置有多种写法，读取方各自兜底：

- 扁平字段自动映射到嵌套结构（`config/service.ts:110-170`）；
- `runtimes.codex ?? config.codex`（`registry.ts` 中的 codex 工厂）；
- `project.runtime ?? project.agent`（Codex、Pi、manager 都在读）；
- `auth.apiKey ?? apiKey`（`codex.ts:233-236`）。

**为什么改**：每多一个读取方，就要把所有兜底再写一遍，漏掉任何一个都会出现「同一份配置，在 A 处生效、在 B 处不生效」。

**修改方案**

- 兼容逻辑只保留在 `normalizeRawConfig` 和项目配置加载这一处：把旧字段转换成新字段，并且**每命中一个旧字段就打印一条弃用警告**。
- 业务代码只读规范化之后的字段，删除各处的 `??` 兜底。
- 在 CHANGELOG 或 README 里写明旧字段将在下个小版本移除。

### 3.8 会话标题生成

**现象**：`generateSessionTitle`（`gateway/service.ts:153-222`）写死了 dashscope 地址和 `qwen-plus` 模型，通过拼接去猜 chat completions 的 URL（判断地址里是否包含 dashscope、是否以 `/v1` 结尾），还有一句 `model.includes("decision")` 的特殊判断；生成失败时写入 `"新会话"`。

**为什么改**：这个逻辑和路由器的配置纠缠在一起，换一个服务商就要改代码。

**修改方案**：抽出 `TitleGenerator`，新增配置 `titleGenerator: { enabled, endpoint, model, apiKey }`。`endpoint` 要求填写完整的 chat completions URL，不做任何猜测；未配置时直接使用首行截断。与 #13 一起做。

### 3.9 workspace 中静默吞掉的错误

**现象**：`workspace.ts` 里有 10 处空 catch，git 失败几乎都被静默吞掉；日志用的是 `console.warn` 而不是项目的 `Logger`；还有 `"{env:"` 前缀判断、靠格式猜测 SSH key 是否为 base64、手写的 `.env` 解析。

**为什么改**：worktree 创建、清理失败时没有任何痕迹，磁盘泄漏和分支残留只能靠人工发现。

**修改方案**：随 #7 一起重构。注入 `Logger`，每个 catch 至少记录一条带 `projectId`、`sessionId`、命令的警告；`.env` 解析和 key 解析抽成独立函数并补测试；`"{env:"` 这类未解析的占位符改为在配置加载阶段报错。

---

## 4. 实施顺序与测试计划

| 阶段 | 内容 | 依赖 |
| :--- | :--- | :--- |
| 1 | #6 关闭兜底 + 启动对账；#4 会话来源（共用启动对账） | 无 |
| 2 | #7 工作区接口拆分 + `workspacePath` 落库；3.9 workspace 日志 | 无 |
| 3 | #11 会话重置；3.5 事件职责约定 | #7（路径稳定） |
| 4 | #5 Codex 连接对象；#9 请求分发；3.1 归一化改用生成类型 | 无 |
| 5 | #13 标题；3.8 标题生成器 | 无 |
| 6 | 3.2、3.3、3.4、3.6、3.7 配置与 Pi 清理 | 3.5 |

每个阶段按 AGENTS.md 的要求提交（例如 `fix: always complete session close`），并执行：

```bash
bun run typecheck
bun run lint
bun test
```

涉及前端显示的阶段（#11 的系统提示、#13 的标题兜底）还需要执行 `cd web && bun run build`。

需要数据迁移的变更：#4（source 改为 `dispatch`）、#7（新增 `workspace_path` 列）、#13（标题改为 `NULL`）。`database/schema.sql` 同步更新为最终结构，存量数据的迁移脚本放在 `database/migrations/` 下，按文件名顺序手动执行。

**本轮未纳入、建议另行处理的审查项**

- #1：默认监听 `0.0.0.0` 且不鉴权，同时 Codex 默认 `danger-full-access`；Web Studio 不支持 token，开启鉴权后无法使用。
- #2：Git token 通过 `git config http.extraheader` 明文写进 `.git/config`，agent 可以读到。
- #3：`repository.url` 是本地路径时，基础仓库同步会对用户自己的仓库执行 `reset --hard` 并改写 git 身份。

---

## 5. 实施结果

全部条目已实施，按 `label: title` 规范提交（未 push）：

| 提交 | 内容 |
| :--- | :--- |
| `f9908df fix: always complete session close` | #6 |
| `ff89a09 fix: treat dispatched sessions as regular sessions` | #4 |
| `2799a3a refactor: stop re-syncing workspaces on every session operation` | #7、3.9 |
| `0e16702 fix: report runtime session resets instead of starting over silently` | #11、3.5 |
| `4e61d70 refactor: rebuild codex adapter on the generated app-server protocol` | #5、#9、3.1 |
| `f735712 fix: replace session title placeholders with a nullable title` | #13、3.8 |
| `51c0123 refactor: keep codex home generation inside the codex adapter` | 3.2、3.3、3.4 |
| `dbe4087 refactor: tighten pi runtime configuration and session handling` | 3.6 |
| `d3da715 refactor: merge the project agent section into runtime at load time` | 3.7 |

存量 PostgreSQL 数据库需要按顺序执行 `database/migrations/` 下的三个脚本：

- `20261118_01_dispatch_session_source.sql`
- `20261118_02_session_workspace_path.sql`
- `20261118_03_session_title_null.sql`

验证：`bun run typecheck`、`bun run lint`、`bun test`（329 个通过）、`bun run build`、`cd web && bun run build` 均通过。迁移脚本和 `PostgresStore` 的会话相关 SQL 在 `postgres` 容器的临时数据库上验证过。另外用 fake 运行时把服务实际启动，对接口做了一次冒烟测试。

### 与方案的差异

- **#7**：没有加 `baseSyncIntervalMs`。基础仓库只在服务启动时和创建新会话时同步，并发请求由已有的单飞机制合并，所以不需要额外的时间间隔。git 执行器也没有改成可注入，测试通过继承 `WorkspaceManager` 统计调用次数。
- **#9**：权限申请、旧版 `execCommandApproval`/`applyPatchApproval`、MCP elicitation、用户输入请求一律回复 JSON-RPC 错误 `-32601`，没有逐个实现拒绝语义，也没有加审批超时。审批接口的请求体改为 `{ requestId, decision: "approved" | "rejected" }`。
- **3.1**：订阅了但没有对应标准事件的通知（token 用量、限流、实时音频等）直接不产生事件，不再落成 `runtime.unmapped`，避免事件日志里堆满噪音。
- **3.2**：服务级 `runtimes.codex` 仍然整体透传。这是 Codex 自己的配置命名空间，原来的设计和测试都依赖这一点。只有项目级 `runtime` 收紧为「`config` 显式透传 + 映射字段」，没有为每种运行时拆分 schema。
- **3.5**：没有新增 `turn.steered` 事件。
- **3.7**：范围收窄。`AppConfig` 上的扁平访问器和 YAML 扁平字段的兼容映射都保留了：它们只在一处统一转换，并且测试里大量用到，改动面大、收益小。实际做的是：
  - 项目的 `agent` 在 schema 解析时并入 `runtime`；
  - 删除 `codex.auth.apiKey`、`codex.configPath` 和顶层 `pi` 这几个别名；
  - 注册表只读 `runtimes.codex`。
- **3.8**：新增的配置段叫 `titles: { model, apiKey, baseUrl }`，`baseUrl` 写 OpenAI 兼容的 API 根地址，程序固定拼上 `/chat/completions`。

### 需要注意的行为变化

- 自动生成标题不再借用 `router` 的配置。想用模型生成标题，需要配置 `titles`；不配置时使用消息首行。
- `runtimes.pi` 不再接受单 provider 简写（顶层的 `provider/model/apiKey/baseUrl`），需要改用 `defaultProvider`、`defaultModel`、`providers`。显式配置了但 Pi 不认识的模型会直接报错。
- Pi 的 `auth.json` 和 `models.json` 改为从项目的 agentDir（默认 `<dataDir>/pi/<project>`）读取，不再读宿主机的 `~/.pi`。
- Codex 的 `baseConfigPath` 指向的文件不存在或解析失败时会报错，不再被忽略。

