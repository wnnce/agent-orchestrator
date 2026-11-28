---
name: orchestrator-testing
description: How to write and run tests for Agent Orchestrator. Use when adding or changing behavior in this repository, fixing a bug (regression test), writing or reviewing files under tests/ or web/src/**/*.test.ts, or deciding whether a change is covered well enough.
---

# Testing Agent Orchestrator

Tests prove behavior that a user, an agent, or another module can observe. They run fast, offline,
and without any real agent runtime, database, or chat platform.

## Ground rules

- Backend tests live flat in `tests/<area>.test.ts` (`bunfig.toml` sets `tests` as the root) and use
  `bun:test`. Web unit tests sit next to the code as `web/src/**/*.test.ts`.
- No real network, agent login, `~/.codex` / `~/.claude`, Postgres, Feishu, or WeCom. Use
  `MemoryStore`, `FakeRuntime` (or a subclass), injected `fetch`, and the helpers below.
- Every behavior change gets a test. Every bug fix gets a regression test that **fails on the old
  code**: write it first, or stash the fix and run it, and say in the handoff that you checked.
- Assert what can be observed: returned values, records in the store, emitted events, calls to an
  injected fake, HTTP responses. Do not reach into private fields or `as any` casts to inspect
  state.
- Assert absence when the bug was something extra happening: a duplicate execution, an event that
  should not be recorded (`notification.queued` with notifications off), a second clone.
- Name tests after the behavior (`"a long turn does not hold up other sessions' jobs"`), not the
  method.
- Code and test names are in English.

## Pick the smallest real unit

Test a rule through the object that owns it. Reach for a whole `ProjectRuntime` or the HTTP
gateway only when the behavior really spans them.

| Behavior under test                                                       | Build                                                                                                                          | Example                                                                              |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| One session part (`ScheduledJobs`, `AgentRuntimes`, `SessionEvents`, ...) | The part with fake deps typed as `Pick<...>` of what it uses                                                                   | `tests/scheduled-jobs.test.ts` (`HeldTurns`), `tests/agent-runtimes.test.ts`         |
| Session lifecycle, turns, queueing, close/archive                         | `ProjectRuntime` with a controlled `FakeRuntime` subclass, `MemoryStore`, `WorkspaceManager` and `ArtifactStore` on a temp dir | `tests/session-execution.test.ts` (`ControlledRuntime`)                              |
| Project context, tools, tasks, pipeline code nodes                        | `testProject`, `testContextServices`, `contextFactory` from `tests/helpers/project-context.ts`                                 | `tests/project-context.test.ts`, `tests/tools.test.ts`, `tests/ts-task.test.ts`      |
| A runtime adapter                                                         | Feed vendor messages to the adapter/normalizer; tools from `fakeSessionTools` (`tests/helpers/session-tools.ts`)               | `tests/pi-runtime.test.ts`, `tests/codex.test.ts`, `tests/claude-normalizer.test.ts` |
| Application services                                                      | `SessionService` / `InboundService` with a `ProjectManager` over `MemoryStore`                                                 | `tests/session-service.test.ts`, `tests/inbound-service.test.ts`                     |
| HTTP routes and contracts                                                 | `createGateway(...)` from `tests/helpers/gateway.ts`, then `gateway.handle(new Request(...))`                                  | `tests/gateway.test.ts`, `tests/openapi.test.ts`                                     |
| `PostgresStore` SQL                                                       | Drizzle over a mock `pg` pool that captures SQL and params                                                                     | `tests/persistence-drizzle.test.ts`                                                  |
| Chat channels                                                             | The channel client with an injected `fetch` / fake SDK client                                                                  | `tests/feishu-outbound.test.ts`, `tests/wecom-channel.test.ts`                       |
| Tracing                                                                   | `InMemorySpanExporter`                                                                                                         | `tests/tracing.test.ts`                                                              |
| Task executors                                                            | `MockTaskExecutor` (`tests/helpers/mock-executor.ts`)                                                                          | `tests/task.test.ts`                                                                 |

A business rule enforced in a service (for example the read-only guard for task sessions) is tested
on the service, and once through each entry point that must respect it (HTTP route, webhook,
inbound chat), because a rule that lives only in one route gets bypassed by the others.

## Controlling time and concurrency

Most bugs in this codebase were races and lifecycle ordering. Tests must make the interleaving
deterministic.

- **Hold work open with promises you control.** A fake runtime records `startTurn` calls and only
  emits the terminal event when the test calls `finish(i)`; `started(n)` resolves once `n` turns
  have started. `HeldTurns.hold(sessionId)` returns a `release()`. Use this to create "turn still
  running" states, overlapping polls, and close-while-busy.
- **Call one-shot methods instead of waiting for timers**: `scheduledJobs.poll(asOf)`,
  `sessions.sweepIdle()`, `tasks.reload()`. Pass small timeouts through deps (`controlTimeoutMs`,
  `queueLimit`, idle/archive timeouts in the project config) rather than sleeping past real ones.
- **No fixed sleeps to "let things settle".** If there is no hook to await, poll a condition with a
  bounded loop (the `until(condition)` helper in `tests/scheduled-jobs.test.ts`) and assert the
  condition afterwards so a timeout fails loudly.
- For a race fix, write the test that reproduces the interleaving: two overlapping calls, a slow
  item next to fast ones, a stop or close in the middle of a turn. Check it fails on the old code.

## Isolation and cleanup

- Temp directories come from `mkdtemp` under `/tmp` with a test-specific prefix and are removed in
  `finally` or `afterEach` with `rm(root, { recursive: true, force: true })`.
- Always `await runtime.stop()` (and stop any channel, scheduler, or engine you started) in
  `finally` / `afterEach`, so no timer or pump outlives the test.
- Silence logs with `new Logger({ sink: () => {} })`. To assert on logging, collect lines from the
  sink and check message and fields; also check that secrets do not appear.
- Tests must not depend on each other or on file order. Build fresh state in `beforeEach`.

## What a change must cover

Go through the list that matches the change:

- **Session / turn / runtime code**: the happy path; failure keeps the runtime's reason on the
  turn; interrupt, close, and archive while a turn runs; behavior after a restart (`reconcile`);
  per-session state is released when the session goes idle; events arrive in order with the
  terminal event last.
- **Runtime adapters**: each vendor event maps to the canonical event; one `itemId` maps to exactly
  one kind; `tool.call.started` is emitted before the tool runs; adapters never emit `session.*`,
  `turn.queued`, or `turn.started`; resume failure throws `RuntimeSessionNotFoundError` instead of
  silently starting over.
- **Periodic or background work**: overlapping invocations run each item once; one slow item does
  not block others; `stop()` waits for in-flight work.
- **Context, tools, tasks, pipelines, hooks**: attribution by `Origin` (notification source,
  artifact owner, `createdBy`); which tools a session sees (`when`) for plain, task, and pipeline
  sessions; a missing dependency is an error, not a silent success; aborting `signal` fails the
  call.
- **Persistence**: new behavior in both `MemoryStore` and `PostgresStore`; partial updates do not
  overwrite unrelated columns; pagination and filters match between the two stores.
- **HTTP**: status codes and error codes for not-found, validation, and auth; response shape matches
  the OpenAPI contract; public routes (`/hooks/...`) do not leak internals on errors.
- **Web**: pure logic (parsers, routing, formatting) gets a unit test in `web/src`; UI behavior is
  verified by running the app when it matters.

## Running tests

```bash
bun test tests/session-execution.test.ts          # one file
bun test tests/session-execution.test.ts -t "close"  # tests whose name matches
bun test                                          # all backend tests
bun test ./web/src                                # web unit tests
bun run check                                     # typecheck + lint + backend tests
```

Report exactly which commands ran and their results. A test that was not run is not passing.
