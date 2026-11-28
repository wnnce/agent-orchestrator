# AGENTS.md

Guidance for agents developing Agent Orchestrator itself. It applies to the whole repository
unless a more specific `AGENTS.md` exists in a subdirectory. User instructions always take
precedence.

## What This Project Is

Agent Orchestrator is a self-hosted Bun/TypeScript service that runs long-lived, project-scoped
coding agents. Each managed project (defined under `projects/<id>/`) gets its own agent runtime
(Codex, Claude Code, Pi, or an ACP agent such as Antigravity `agy`), its own Git worktree per
session, and its own project code: scheduled tasks, pipelines, custom agent tools, and HTTP hooks.
Users reach the agents through the Web Studio, the REST/SSE API, webhooks, and Feishu or WeCom
chats.

It is a personal project. That shapes how changes should be made:

- Readability and maintainability come first. Prefer the straightforward design over a clever or
  defensive one.
- Badly shaped existing code may be refactored directly. Do not keep old names, forwarding
  methods, or compatibility layers alive; migrate callers, `projects/example`, and tests in the
  same change.
- Do not add large, special-cased workarounds. Vendor quirks belong inside the runtime adapter
  that needs them, not in shared code.
- Extreme edge cases do not need elaborate handling. Fail clearly instead.
- When a user script or project config fails (for example `scripts/init.sh` not cloning), fix the
  script. Code reports the failure; it does not compensate for it.

## Architecture

`src/main.ts` is the composition root: it loads config and projects, creates the `Store`,
`SessionManager`, `EventHub`, `ProjectManager`, chat channels, the application services, and the
HTTP `Gateway`, and owns startup and shutdown order.

### Entry points

- `src/gateway/`: HTTP only. Hono app with OpenAPI contracts (`contracts/`, zod via
  `@hono/zod-openapi`) and routes (`routes/`) under `/api/v1`, plus `/hooks/:projectId/:hookId`,
  health and docs. A route may call **one** method on `ProjectManager`, `ProjectRuntime` (or one of
  its parts), `Store`, or an application service, and map the result to its contract. Anything with
  branching, composition, or business rules lives outside the route where it can be tested
  without Hono.
- `src/channels/`: two-way chat channels (Feishu WebSocket/webhook, WeCom bot WebSocket). Each one
  implements `Channel`; channel-specific streaming and card rendering stay inside its directory.
- `src/app/`: application services shared by every external entry point. `SessionService`
  (create with routing, runtime override and title; submit a user turn with the read-only guard for
  task sessions) and `InboundService` (dedupe, `/cancel`, `/close`, delivery to sessions). Add a
  service only for a use case that spans several objects and has rules, never for pure forwarding.
- `src/router/`: picks a project for a new session (sticky, keyword, optional LLM, `_global_`).

### Projects and sessions

- `src/project/manager.ts`: `ProjectManager` owns all `ProjectRuntime`s and cross-project lookup
  (`runtimeForSession`, `runtimeForPipelineRun`, `runtimeForNodeRun`).
- `src/project/runtime.ts`: `ProjectRuntime` only assembles a project's parts, builds contexts
  (`createContext`), and starts/stops them. Callers use the parts directly:
  `sessions`, `turns`, `scheduledJobs`, `tasks`, `pipelines`, `pipelineEvents`, `hooks`, `tools`,
  `agentTools`. Do not add forwarding methods back onto it.
- `src/session/`:
  - `SessionManager` / `SessionEntity`: the persisted session state, observed by channels and the
    event hub. Process-local execution state does not go here.
  - `SessionLifecycle`: create, get, rename, close, archive, idle sweep, startup reconcile.
  - `SessionTurns`: per-session `SessionSlot` (queue, active turn, pump), runtime events, finishing
    turns; submit / steer / interrupt / compact / approve.
  - `AgentRuntimes`: the single place that resolves runtime, model, and reasoning effort, and binds
    or releases runtime sessions.
  - `SessionEvents` (ordered event writes), `SessionWorkspaces`, `ScheduledJobs` (agent-scheduled
    wake-ups), `TurnTrace`.
- Dependencies point one way: lifecycle → turns → agent runtimes → events. The few reverse calls
  are explicit callbacks injected at construction. Do not introduce an event bus between parts.
- `src/workspace/`: base repository sync and one worktree per session on branch
  `agent/<sessionId>`. The built-in `_global_` project shares the `projects/` directory read-only.

### Agent runtimes

- `src/runtime/`: `RuntimeRegistry` with adapters `codex` (`codex app-server` JSON-RPC), `claude`
  (Claude Agent SDK), `pi` (Pi SDK, in-process), ACP via profiles (`acp/profiles/agy.ts`), and
  `fake` for tests.
- Every adapter normalizes vendor events into the canonical events in `src/domain/events.ts`.
  Transient deltas (`agent.message.delta`, `agent.reasoning.delta`, `command.output`) are published
  live but not persisted.
- Runtimes read their own native config (`~/.codex`, `~/.claude`, `~/.pi/agent`,
  `~/.gemini/antigravity-cli`); projects override only `type`, `model`, `reasoningEffort`,
  `mcpServers`. See `docs/references/runtime-setup.md`.
- Adapters receive tools as `RuntimeContext.tools` (`specs` + `call`) and never touch the tool
  registry.
- `src/runtime/codex/generated/` is generated. Regenerate with `bun run generate:codex`; never edit
  it by hand.

### Project context and project code

- `src/context/`: an explicit `Origin` (`session` | `task` | `pipeline` | `hook`) and the
  `ProjectContext` that acts for it: `notify`, `artifacts`, `mcp`, `sessions`, `pipelines`,
  `render`, `logger`, `signal`. `ProjectRuntime.createContext` is the only factory. Origin decides
  ownership, audit fields, log fields, and span attributes; never fake a session ID to attribute
  something.
- Specialized contexts (`TaskContext`, `NodeContext`, `ToolContext`, `HookContext`) extend it by
  object spread, not class inheritance, so user code can destructure them safely.
- Capabilities are required dependencies. A missing dependency is a construction error, not a
  silent "log and pretend it worked" branch.
- Project-code SDKs, imported by `projects/*` through relative paths into `src/`, are a contract:
  - `src/tools/`: `defineTool`; built-in agent tools in `tools/builtin/`; `ToolRegistry` handles
    schemas, audit (`tool_executions`), and spans. Built-in tool names and parameters are referenced
    by project prompts; do not rename them casually.
  - `src/task/`: `defineTask` TypeScript tasks and Markdown agent tasks; `ProjectTasks` wires the
    engine, scheduler, and executors.
  - `src/pipeline/`: `definePipeline` / `node.*`, the engine and state machine.
  - `src/hooks/`: `defineHook`; `ProjectHooks` loads and dispatches them.

### Cross-cutting

- `src/persistence/`: the `Store` interface with `MemoryStore` and `PostgresStore` (Drizzle).
  Schema in `schema.ts`, SQL migrations in `database/migrations/`.
- `src/events/hub.ts`: `EventHub` pub/sub and replay for SSE.
- `src/notifications/`: one-way outbound notifications (provider registry + outbox). Keep it
  separate from two-way `channels/`.
- `src/domain/`: shared types, canonical events, IDs, origins, and the `AppError` hierarchy.
- `src/observability/`: `Logger` and OpenTelemetry tracing.
- `src/config/`, `src/mcp/`, `src/prompt/`, `src/artifacts/`: config loading, MCP client, prompt
  templates, artifact storage.
- `web/`: React 19 + Vite + Tailwind v4 Web Studio, with its own `package.json` and `bun.lock`.
- `infra/agent-runtime-base/`, `docker-compose.yaml`: container images for deployment.

When behavior and a design document disagree, the code wins; most designs end with an
implementation-notes section that records where the implementation diverged.

## Managed Projects (`projects/`)

- Each project is `projects/<id>/` with `project.yaml`, optional `.env`, `scripts/init.sh` and
  `scripts/sync.sh`, and optional `tasks/`, `pipelines/`, `tools/`, `hooks/`, `.skills/`.
- Only `projects/example/`, `projects/AGENTS.md`, `projects/Taskfile.yaml`, and
  `projects/*.example.*` are tracked. Other project directories are the user's local projects; do
  not commit them.
- `projects/example/` is the reference for every project-code SDK. Update it whenever an SDK or
  project convention changes.
- `projects/AGENTS.md` is not development guidance. It is the prompt that agents in the read-only
  `_global_` workspace receive; edit it only to change that runtime behavior.

## Development Workflow

1. Read the relevant implementation, tests, and design documents before changing behavior.
2. Keep changes scoped to the task. Preserve unrelated user changes in a dirty worktree.
3. Add or update tests for every behavior change. A regression test should fail on the old code.
4. Run targeted tests while iterating, then the checks listed under Validation before handing off.
5. Never commit generated output (`dist/`, `web/dist/`, coverage, `.data/`), `config.yaml`,
   `.env` files, or secrets.

Use Bun for package management and scripts, in both the root and `web/`. Keep each `bun.lock` in
sync when dependencies change; do not add npm, pnpm, or Yarn lockfiles.

### Database changes

1. Edit `src/persistence/schema.ts`.
2. Run `bun run db:generate` and commit the new migration and its `meta/` snapshot together with
   the schema change. Do not hand-edit generated snapshots.
3. Implement the change in both `MemoryStore` and `PostgresStore`, and cover it in tests.
4. Existing databases are upgraded with `bun run db:init`.

### Live verification

The service may be deployed from this repository and running real sessions. Before restarting a
running instance, make sure no turn is still in progress. Run the service as the user that owns the
runtime credentials (`~/.codex`, `~/.claude`, ...) and SSH keys, or sessions silently lose
authentication. Report which checks were done live and which were only covered by tests.

## Code Style

- TypeScript with the strict compiler settings in `tsconfig.json` (`noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax`). Use `import type` for type-only imports.
- Keep `.ts` extensions on relative imports.
- Explicit types at public boundaries. Avoid `any`; when an external boundary forces it, validate
  the value immediately (zod is already a dependency).
- Prefer small, focused functions and constructor-injected dependencies (a `deps` object rather
  than long positional parameter lists) over hidden global state.
- Throw the `AppError` subclasses from `src/domain/errors.ts` with a specific code; the gateway maps
  them to HTTP responses.
- Handle async failures deliberately; no floating promises.
- Logging: use the injected `Logger` with a plain message and structured fields, at the right level
  (`debug` for noisy detail, `info` for lifecycle, `warn` for recoverable problems, `error` for
  failures). Never log credentials, tokens, webhook secrets, authorization headers, or full
  connection URLs.
- Code, comments, log messages, and commit messages are in English.
- Formatting is Prettier's (`bun run format`): double quotes, semicolons, trailing commas,
  100-character print width.

## Testing

- Backend tests live in `tests/` and run with `bun test` (`bunfig.toml` sets the test root). They
  use `MemoryStore` and the `fake` runtime, so they need no database, network, or agent login.
- Reuse the helpers in `tests/helpers/` (`createGateway` wires the gateway the way `main.ts` does;
  project-context and session-tool helpers build contexts for tool and task tests).
- Test business rules through the object that owns them (services, session parts, registries), not
  only through HTTP.
- Web unit tests (`web/src/**/*.test.ts`) are outside that root; run them with
  `bun test ./web/src`.

## Validation

Run from the repository root unless noted.

```bash
bun run typecheck     # tsc --noEmit
bun run lint          # biome lint
bun test              # backend tests (tests/)
bun run check         # all three above
bun run formatCheck   # prettier --check src tests
bun run build         # backend bundle
bun test ./web/src    # web unit tests
cd web && bun run build   # web type check and production build
```

Before handoff, run every check the change affects (always `bun run check`; `bun run build` for
backend code; the web tests and build for anything under `web/` or any API contract the web
uses). Report
commands that could not be run. Never claim a test or manual check passed unless it was actually
executed.

## Documentation

- `docs/designs/<NN>-<kebab-title>/README.md`: design proposals, numbered sequentially. Recent
  designs are written in Chinese; follow that. Outline: overview table (status `Draft` |
  `In Review` | `Accepted` | `Superseded`, target module, date), context and motivation, goals and
  non-goals, detailed design, configuration, implementation phases and tests, alternatives and
  tradeoffs. After implementing, add an implementation-notes section for anything that diverged.
- `docs/references/`: setup guides and SDK references (e.g. `pipeline-sdk.md`,
  `runtime-setup.md`). Update them when the behavior they describe changes.
- `docs/memory/`: local, untracked session notes. They may be stale; verify against the code.
- Write documentation as local files in the repository, not in external document services.
- Leave a new or substantially rewritten design document uncommitted until the user has reviewed it
  and asked for it to be committed.

## Commits

Use `label: title`: a short, imperative, lowercase title without a trailing period. Labels: `feat`,
`fix`, `refactor`, `test`, `docs`, `build`, `ci`, `chore`.

```text
feat: serve project hooks at /hooks/:projectId/:hookId
fix: run each due scheduled job once and independently
refactor: split session execution out of project runtime
test: cover agent runtime settings and idle session slots
docs: design the project runtime split
```

- Make atomic commits: one coherent change each, independently understandable and, where
  practical, passing the checks. Do not split tightly coupled changes just to add commits, and do
  not mix unrelated cleanup into a feature or fix.
- Large refactors land as a sequence: first a behavior-preserving split, then fixes with their own
  regression tests, then caller migration.
- Inspect the staged diff before committing: no secrets, local config, generated artifacts, or
  unrelated user changes.
- Create commits only when asked. Do not amend, rebase, push, or force-push unless asked.

## Pull Requests

Only create a pull request when the user explicitly asks. Use the `label: title` format for the
title and this body:

```markdown
## Summary

- What the change does.
- Main implementation details or behavior differences.

## Testing

- `bun run check`
- `bun run build`
- Any targeted, web, or live checks that were run.

## Notes

- Compatibility concerns, follow-up work, or checks that could not be run.
- Remove this section when empty.
```

Keep the body concise and factual, and list only validation that actually ran.
