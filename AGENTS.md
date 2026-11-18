# AGENTS.md

This file provides repository-level guidance for agents developing Agent Orchestrator.
Its rules apply to the entire repository unless a more specific `AGENTS.md` exists in a
subdirectory. User instructions always take precedence.

## Project Overview

Agent Orchestrator is a Bun and TypeScript service for coordinating agent runtimes across
projects and repositories. It exposes a Hono HTTP/SSE gateway, manages isolated Git workspaces,
persists session state through either PostgreSQL or an in-memory store, and includes a React/Vite
web interface.

## Repository Map

- `src/`: backend application code.
- `src/gateway/`: HTTP routes, SSE endpoints, and application orchestration.
- `src/runtime/`: runtime adapters and canonical event normalization.
- `src/project/`, `src/session/`, `src/workspace/`: project, session, and workspace lifecycle.
- `src/actions/`, `src/task/`: actions, task execution, and scheduling.
- `src/persistence/`: `Store`, `MemoryStore`, and `PostgresStore` implementations.
- `database/schema.sql`: complete schema for initializing a new PostgreSQL database.
- `scripts/`: explicit operational scripts such as database initialization.
- `web/`: React/Vite web application.
- `tests/`: Bun test suite.
- `projects/`: local managed-project definitions. Follow the nested `projects/AGENTS.md` there.
- `infra/`: container and runtime image definitions.

## Development Workflow

1. Inspect the relevant implementation, tests, and configuration before changing behavior.
2. Keep changes narrowly scoped. Preserve unrelated user changes in a dirty worktree.
3. Add or update tests for behavior changes and regressions.
4. Run the smallest relevant checks while iterating, then run the broader checks appropriate to
   the change before handing it off.
5. Do not commit generated output such as `dist/`, `web/dist/`, coverage files, local `.data`, or
   secrets.

Use Bun for package management and scripts. Keep `bun.lock` in sync when dependencies change.
Do not substitute npm, pnpm, or Yarn lockfiles.

Do not manually edit generated Codex protocol files under `src/runtime/codex/generated/`. Regenerate
them with `bun run generate:codex` when the upstream protocol intentionally changes.

## Documentation Guidelines

All project documentation follows a standardized directory structure under `docs/`:

- `docs/designs/<xx>-<kebab-title>/`: Technical designs, RFCs, and integration proposals.
  - `<xx>`: Two-digit sequential prefix (e.g., `01`, `02`).
  - `<kebab-title>`: Short, descriptive lowercase name separated by hyphens (e.g., `01-task-and-action`, `02-pi-agent-sdk-integration`).
  - Each design proposal must live in its own dedicated subdirectory containing a `README.md` (or main design specification) alongside any supporting diagrams, schema snippets, or examples.
- `docs/architecture/`: System-level architectural topology, canonical protocols, and subsystem blueprints.
- `docs/memory/`: Living development state, context checkpoints, and session continuity notes (e.g., `context.md`).
- `docs/references/`: Guides, environment setups, and external SDK reference specifications.

### Design Document Structure

Design documents under `docs/designs/<xx>-<kebab-title>/` should follow this standard outline:

1. **Overview & Metadata**: Title, status (`Draft` | `In Review` | `Accepted` | `Superseded`), target module, and date.
2. **Context & Motivation**: The problem statement, background, and why the change is necessary.
3. **Goals & Non-Goals**: Clear, testable boundaries defining what is and isn't in scope.
4. **Detailed Technical Design**: Component architecture, class/interface contracts, data models, event mappings, and concurrency/lifecycle handling.
5. **Configuration Specification**: YAML schema additions, defaults, and overrides.
6. **Implementation Phases & Testing Plan**: Step-by-step rollout plan, unit/integration test coverage, and validation criteria.
7. **Alternatives & Tradeoffs**: Other considered options and rationale for chosen decisions.

## Code Style

- Use TypeScript with the repository's strict compiler settings.
- Follow existing module boundaries and naming conventions.
- Use explicit types at public boundaries and avoid `any` unless an external boundary makes it
  unavoidable and the value is validated immediately.
- Preserve `.ts` extensions on relative imports.
- Prefer small, focused functions and dependency injection over hidden global state.
- Handle asynchronous failures deliberately; do not leave unhandled promises.
- Never log credentials, tokens, webhook secrets, authorization headers, or full connection URLs.
- Let Prettier apply the repository formatting rules: double quotes, semicolons, trailing commas,
  and a 100-character print width.

## Validation

Run commands from the repository root unless noted otherwise.

```bash
# TypeScript validation
bun run typecheck

# Static analysis
bun run lint

# Backend test suite
bun test

# Standard backend validation
bun run check

# Backend production build
bun run build

# Web production build
cd web && bun run build
```

For a small change, targeted tests are acceptable during development. Before handoff, run all
checks affected by the change and report commands that could not be run. Do not claim a test or
manual verification passed unless it was actually executed.

## Commit Guidelines

Commit messages use the following form:

```text
label: title
```

Use a short, imperative, lowercase title without a trailing period. Common labels include:

- `feat`: new user-visible functionality.
- `fix`: bug fix.
- `refactor`: internal restructuring without an intended behavior change.
- `test`: test-only changes.
- `docs`: documentation-only changes.
- `build`: build system or dependency changes.
- `ci`: continuous integration changes.
- `chore`: repository maintenance not covered above.

Examples:

```text
feat: add scheduled session cleanup
fix: preserve session title during flush
refactor: externalize database schema initialization
test: cover read-only global workspace actions
docs: document local runtime configuration
```

Prefer atomic commits: each commit should represent one coherent change and remain independently
understandable and testable when practical. Atomic commits are a strong preference, not an absolute
requirement; do not split tightly coupled changes merely to increase the commit count. Do not mix
unrelated cleanup with feature or bug-fix work.

Before committing, inspect the staged diff and make sure the commit contains no secrets, local
configuration, generated artifacts, or unrelated user changes. Do not amend, rebase, force-push, or
create commits unless the user has requested those operations.

## Pull Request Guidelines

When creating a pull request, use the same `label: title` format for its title. Keep the title
aligned with the primary purpose of the change. The body should briefly explain the functionality,
fix, or refactor, summarize the important implementation details, and list the validation that was
actually performed.

Use this template:

```markdown
## Summary

- Describe the feature, fix, or change.
- Note the main implementation details or behavior differences.

## Testing

- `bun run check`
- `bun run build`
- Add any targeted or web checks that were run.

## Notes

- Mention compatibility concerns, follow-up work, or checks that could not be run.
- Remove this section when there are no additional notes.
```

Keep PR bodies concise and factual. Do not state that a test or manual verification passed unless it
was run successfully. Do not create or publish a pull request unless the user explicitly asks for
it.
