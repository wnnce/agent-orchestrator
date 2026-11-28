# Review standards

What a change to Agent Orchestrator is checked against. Each section says what good looks like and
what to look for. Thresholds are prompts to look closer, not automatic findings.

## 1. Behavior and intent

- The change does what the request, issue, or design asked, and nothing it did not ask for.
- The changed behavior is right in the cases that realistically happen: empty or missing input,
  the thing not existing, the same request arriving twice, the operation running while the session
  or task is busy, and the service restarting in the middle.
- Behavior visible to users or other modules (events, API responses, stored records, tool results)
  stays truthful: an event is recorded only when the thing happened, a failure keeps its reason,
  and a fallback that changes what the user gets is reported rather than silent.

## 2. Design and placement

- **The code lives with what it is about.** A rule sits on the object that owns the data it
  governs: cross-project lookup on `ProjectManager`, session behavior in the `src/session/` part
  that owns it, a capability on the project context, vendor handling inside its runtime adapter,
  chat-platform handling inside its channel directory.
- **Rules sit where every caller passes through them.** A rule that only one entry point (one HTTP
  route) applies is bypassed by the others (webhook, chat, tools, tasks).
- **Layers are respected.** Routes are thin (section 5). `src/main.ts` assembles; `ProjectRuntime`
  only assembles a project and does not get forwarding methods. Shared code does not branch on a
  runtime type or channel name.
- **Dependencies point one way.** New imports do not point from a lower module (`domain/`,
  `persistence/`, `runtime/`, `session/`, `context/`, `tools/`) up into `project/`, `app/`,
  `gateway/`, or `channels/`, and add no import cycles. Existing exceptions are not a precedent.
  Reverse calls are callbacks injected at construction.
- **State has one owner.** Persisted session state lives on `SessionEntity`, per-session execution
  state on `SessionSlot`. A new parallel `Map` keyed by session or task ID that several code paths
  must remember to clean up is a design problem.
- **Reuse before writing.** The change does not reimplement something the codebase already has:
  `fetchPage`, `withSpan` / `startSpan`, the `AppError` classes, `createContext`, `defineTool` and
  the other SDKs, the test helpers.
- **No leftovers.** Replaced code, old names, forwarding methods, compatibility shims, and flags
  for the old behavior are removed, and callers, `projects/example/`, tests, and docs are migrated.
- **No speculative structure.** No interface with one implementation "for later", no config knob
  nobody sets, no handling for states that cannot occur.

## 3. Complexity

Look closer when a function is longer than about 50 lines, nests more than three levels, takes more
than three positional parameters, or takes a boolean that switches its behavior; or when a file
passes about 500 lines while gaining another responsibility.

It is a finding when you can name the responsibilities that should be separate, for example
"validates, persists, emits, and notifies", or when a reader has to hold too much state to follow
it. Suggest the split along those responsibilities, with names.

Also look for:

- The same logic written twice in the change, or a third copy of something that exists.
- Long `if` / `switch` chains over a type tag that a discriminated union or a lookup table would
  express directly.
- Conditions built from several negations or flags that a well-named helper would explain.

## 4. Readability

- **Names** say what something is in the domain vocabulary: project, session, turn, task,
  execution, pipeline, run, node run, hook, tool, origin, owner. The same thing has the same name
  everywhere. Booleans read as predicates (`isBusy`, `hasPending`); units are in names
  (`timeoutMs`).
- **Types carry meaning.** States are discriminated unions rather than bags of optional fields.
  No `any`; `as` casts only at validated boundaries. `readonly` on deps, records, and inputs that
  are not mutated.
- **Control flow** uses early returns instead of deep nesting; no clever one-liners that need a
  second read.
- **Constants** that matter (timeouts, limits, intervals) are named, with units.
- **Comments** explain why something is done or what a contract guarantees, not what the next line
  does. A public class or method with a non-obvious contract has a doc comment. No commented-out
  code, no `TODO` without context.
- **No dead code**: unused exports, parameters, branches, or fields introduced or left behind.

## 5. API conventions

### HTTP

- Every route is declared in `src/gateway/contracts/<area>.ts` with `createRoute` and zod schemas,
  and registered with `router.openapi`. Handlers read input only through `c.req.valid(...)`.
- A route calls one method on `ProjectManager`, a `ProjectRuntime` part, `Store`, or an
  application service, and maps the result to the contract. Branching and business rules go into
  that method, where they can be tested without Hono.
- Paths use plural kebab-case nouns and camelCase path parameters (`/pipeline-runs/{runId}`).
  Collections owned by a project nest under `/projects/{projectId}/...`. An operation that is not
  CRUD is `POST /<resource>/{id}/<verb>` (`/sessions/{sessionId}/interrupt`).
- JSON fields are camelCase. Responses are objects with named keys (`{ run }`, `{ projects }`),
  never bare arrays, so fields can be added. Lists are paginated with `limit` and `hasMore` via
  `fetchPage`.
- Creation returns 201, other successes 200. Failures throw `AppError` subclasses, which produce
  `{ error: <code>, message }`; every error status a route can return is declared in its contract.
  A client that must tell failures apart gets a specific `ErrorCode`.
- `/api/v1` routes sit behind bearer auth. Anything mounted outside it is public on purpose and
  does not leak internal messages on errors.
- A response shape the web uses changes together with `web/src/api/`.

### TypeScript

- Exported functions and classes have explicit parameter and return types. Exports are the
  minimum the callers need.
- More than two optional parameters become an options object. Inputs and records are `readonly`.
- The project SDKs (`defineTool`, `defineTask`, `definePipeline` / `node.*`, `defineHook`, the
  context types) are a contract for `projects/*`. A change to them updates `projects/example/` and
  `docs/references/`.
- Built-in agent tool names and parameters are referenced by project prompts; changing them needs
  a reason and a migration.

## 6. Async and lifecycle

- **Every promise is handled.** It is awaited, returned, or deliberately detached with `void` plus a
  `.catch` that logs, and a comment saying why it must not be awaited.
- **No check-then-act across `await`.** Code that reads shared state, awaits, and then acts on what
  it read can interleave with another caller. Serialize per key (as the session slot does), make
  the operation single-flight, or make the write itself conditional.
- **Periodic and background work** cannot overlap with itself unless that is safe, and one slow
  item does not hold up unrelated ones.
- **Waits on things outside the process** (an agent runtime, a child process, the network, MCP)
  are bounded by a timeout or cancellable through the `AbortSignal` that the context provides, and
  the signal is passed down to `fetch` and MCP calls.
- **Everything started is stopped.** Timers, intervals, listeners, subscriptions, and child
  processes have an owner that releases them in `stop()` / `close()`. Long-lived work starts in
  `start()`, not in a constructor. A step that fails during shutdown does not skip the steps after
  it.
- **Concurrency is chosen, not accidental.** `Promise.all` for work that fails together,
  `Promise.allSettled` when each item's failure is independent, sequential `await` in a loop only
  when order matters.
- **Order is preserved where it matters.** Events for one session are handled in the order they
  happened.
- **No timing-based coordination** in production code: no sleeps to wait for something else to
  finish.

## 7. Dependencies

- A class with more than two collaborators takes a single `deps` object typed by a
  `<Name>Deps` interface, not a positional list.
- Dependencies are required by default. Optional only when there is a real default behavior, never
  to let a capability silently do nothing (no `logger?` that falls back to a new `Logger`, no
  "skip if missing").
- Depend on the narrowest shape that is used: `Pick<SessionTurns, "submit" | "waitForIdle">` or a
  small interface, so tests can pass a fake.
- No module-level mutable state or singletons. Configuration is loaded in `src/config/` and passed
  in; new code does not read `process.env` deep inside modules.
- External effects that tests need to control (fetch, clock, child processes) are injectable.
- A new package is justified (not trivially written in a few lines, maintained), added with Bun,
  and the right `bun.lock` is updated.

## 8. Errors

- Failures a caller or user sees are `AppError` subclasses from `src/domain/errors.ts` with a
  specific code, not bare `Error` or string matching.
- Errors are not swallowed. A `catch` either handles the failure meaningfully, or adds context and
  rethrows, or is a boundary that logs once. Not log-and-rethrow at every level.
- No silent fallback that hides a broken configuration or user script; fail with a clear message.
  Code does not do a user script's job when the script fails.
- Messages name the identifiers involved (project, session, task) and never contain secrets.

## 9. Logging and tracing

- Logging goes through the injected `Logger`; no `console.*` outside config bootstrap.
- Messages are short, lowercase, static phrases (`"session closed"`); variable data goes in
  structured fields (`{ projectId, sessionId, error }`), not string interpolation.
- Levels: `debug` for detail useful only when diagnosing, `info` for lifecycle milestones, `warn`
  for recovered or degraded situations, `error` for failures that need attention. Per-event or
  per-delta paths do not log at `info`.
- A failure is logged once, where it is handled, with the identifiers needed to find it.
- Never log credentials, tokens, webhook secrets, authorization headers, or full connection URLs.
- New units of work that matter (an agent turn, a tool call, a task execution, an outbound call)
  get a span through `withSpan` / `startSpan`, with the parent trace context passed explicitly.
  Existing span names change only on purpose.

## 10. Tests

Judge with the `orchestrator-testing` skill. In short:

- Every behavior change has a test, and every fix a regression test that would fail without it.
- The test exercises the rule at the object that owns it, and makes concurrency deterministic.
- Existing tests were not deleted or loosened just to make the change pass.
- Tests clean up what they start.

## 11. Persistence, security, and hygiene

- **Persistence**: a schema change has its generated migration and `meta/` snapshot
  (`bun run db:generate`); `MemoryStore` and `PostgresStore` implement it with the same semantics;
  partial updates touch only their own columns.
- **Security**: untrusted input is not interpolated into shell or Git command strings or joined into
  file paths without validation; secrets stay out of logs, errors, events, and artifacts; the
  `_global_` workspace stays read-only.
- **Hygiene**: no generated output, local config, `.env`, or local `projects/*` directories; no
  hand edits under `src/runtime/codex/generated/`; configuration changes are reflected in
  `config.example.yaml` or `projects/example/`; docs describing changed behavior are updated.
