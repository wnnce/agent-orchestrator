# TypeScript Pipeline SDK Reference

Agent Orchestrator pipelines are authored in pure TypeScript under:

```text
projects/<projectId>/pipelines/*.ts
```

Every `.ts` module in `pipelines/` (excluding `*.test.ts`, `*.d.ts`, and files prefixed with `_`) must `export default definePipeline(...)`.

## 1. Core Exports

Import the authoring primitives from `src/pipeline/index.ts`:

```ts
import { definePipeline, defineHandler, node, z } from "../../../src/pipeline/index.ts";
```

| Export | Purpose |
| --- | --- |
| `definePipeline(config)` | Declares a pipeline blueprint (`id`, `name`, `description`, `enabled`, `notifyOn`, `nodes`). |
| `defineHandler({ input?, run })` | Declares a reusable, strongly-typed external handler for `node.code`. |
| `node.agent(config)` | AI Agent stage backed by a dedicated session and prompt template. |
| `node.code(config)` | Deterministic TypeScript stage supporting durable `ctx.step` and zero-token `ctx.waitUntil`. |
| `node.human(config)` | Human review/approval gate (`waiting_confirmation`). |
| `node.end(config)` | Terminal stage (must be the final node in `nodes`). |

## 2. Node Data Contract (`data`) vs Free-Form `metadata`

Pipelines enforce an explicit, zero-workaround separation between **typed stage contracts** (`data`) and **arbitrary passthrough context** (`metadata`):

- **`data` is opt-in and strictly typed**:
  - A node declares its input contract via `input: z.object(...)` (Zod object schema).
  - If a node does **not** declare `input`, its runtime `data` is unconditionally `{}` (and TypeScript infers `ctx.data` as `Readonly<Record<string, never>>`).
  - If a node **does** declare `input`, the engine validates incoming `data` with Zod before entering the node (applying any `.default(...)` values) and rejects malformed payloads with field-level errors.
- **`metadata` is always free-form**:
  - Any `startRun`, `pipeline_next`, `pipeline_prev`, `pipeline_request_confirmation`, `pipeline_fail`, `approveRun`, `rejectRun`, or `node.code` return value can attach arbitrary JSON in `metadata?: Record<string, unknown>`.
  - `metadata` is never restricted by node schemas and merges run-level metadata with upstream handoff metadata (`{ ...run.metadata, ...upstream.metadata }`).

## 3. Native Dynamic `pipeline_next` Tool Schema

When an Agent runs at node $N$, the orchestrator inspects node $N+1$ and generates a **session-specific Zod/JSON Schema** for that session's `pipeline_next` tool across all runtimes (Codex, Claude, Pi, ACP):

- **If node $N+1$ declares `input`**: `pipeline_next` natively exposes `data` as a **required** parameter with node $N+1$'s exact JSON Schema (types, required keys, descriptions, defaults). The LLM cannot advance without supplying valid structured fields.
- **If node $N+1$ does NOT declare `input` (or is `node.end`)**: `pipeline_next` omits `data` completely (`{ summary, content, artifacts?, metadata? }`).
- **Registry fallback**: if a per-session override cannot be resolved (e.g. missing session metadata, deleted/renamed pipeline definition, or direct `ActionRegistry` invocation), `pipeline_next` falls back to its generic registry schema where `data` is an optional JSON object; the engine still validates or drops `data` to `{}` before committing any transition.

No prompt-injection hacks or parsing workarounds are needed.

## 4. `node.agent` and `{{ data.xxx }}` Prompt Templating

`node.agent` prompts support full template interpolation via `{{ ... }}`:

- `{{ data.<field> }}` — strongly-typed fields from the current node's declared `input` schema.
- `{{ metadata.<key> | fallback }}` — free-form metadata values.
- `{{ pipeline.title }}`, `{{ pipeline.runId }}`, `{{ pipeline.branchName }}`, `{{ pipeline.attempt }}`, etc.
- `{{ project.displayName }}`, `{{ vars.<key> }}`, `{{ now.iso }}`.

### Load-Time Static Validation

When loading a pipeline, the loader statically scans every `node.agent` prompt for `{{ data.<key> }}` placeholders:

- If a prompt references `{{ data.foo }}` without a `| default` fallback and the node did **not** declare `foo` in its `input` schema, loading fails fast with a `PipelineValidationError`.

### Loading Long Prompts from Markdown Files

Short prompts can be written inline as template literals; longer prompts can live in sibling `.md` files loaded with Bun:

```ts
const designPrompt = await Bun.file(new URL("./prompts/design.md", import.meta.url)).text();
```

## 5. `node.code`: Inline vs External Reusable Handlers

`node.code` supports two mutually exclusive styles — both with full TypeScript type inference on `ctx.data`:

### Inline Handler

Best for concise, pipeline-specific logic:

```ts
node.code({
  id: "deploy_preview",
  name: "Deploy Preview",
  input: z.object({
    branch: z.string().min(1),
    dryRun: z.boolean().default(false),
  }),
  async run(ctx) {
    // ctx.data is typed as Readonly<{ branch: string; dryRun: boolean }>
    const url = await ctx.step("deploy", () => deployBranch(ctx.data.branch, ctx.data.dryRun));
    return {
      action: "next",
      summary: `Deployed ${ctx.data.branch}`,
      content: `Preview live at ${url}`,
      metadata: { previewUrl: url },
    };
  },
})
```

### External Reusable Handler (`defineHandler`)

Best for complex or shared handlers stored under `pipelines/handlers/*.ts`:

```ts
// pipelines/handlers/pr-watch.ts
import { z } from "zod";
import { defineHandler } from "../../../../src/pipeline/index.ts";

export const prWatchHandler = defineHandler({
  input: z.object({
    prNumber: z.number().int().positive(),
    prUrl: z.string().url(),
    branch: z.string().min(1),
  }),
  async run(ctx) {
    const { prNumber, prUrl, branch } = ctx.data;
    // ... durable ctx.step / ctx.waitUntil ...
    return {
      action: "next",
      summary: `PR #${prNumber} merged`,
      content: `Merged ${prUrl} (${branch})`,
      metadata: { prNumber, prUrl, branch },
    };
  },
});
```

```ts
// pipelines/issue-to-pr.ts
import { prWatchHandler } from "./handlers/pr-watch.ts";

node.code({
  id: "pr_watch",
  name: "Watch PR Merge",
  handler: prWatchHandler,
  allowPrev: true,
  prevTargets: ["implement"],
})
```

> [!NOTE]
> Mixing `handler` with `input` or `run` on the same `node.code(...)` call is forbidden at both compile time and runtime — declare `input` inside `defineHandler(...)` so the handler remains the single source of truth for its contract.

## 6. Rework (`pipeline_prev` / `rejectRun`) Data Inheritance

When a downstream node rejects work back to an upstream node (e.g. `pr_watch` -> `implement`), the rejecting node does **not** need to reconstruct the upstream node's original input schema:

1. The engine looks up the target node's latest validated `inputContext` from this run.
2. If the rejection includes optional `data`, it shallow-merges `{ ...inheritedData, ...overrideData }`.
3. The merged object is re-validated against the target node's `input` schema (or `{}` if undeclared) and stored on the new attempt.
4. For `node.code`, rejection details are also exposed via `ctx.rework` (`{ fromNodeId, reason, feedback }`).
5. For `approveRun`, any human-supplied `data` / `metadata` is shallow-merged on top of the node's approval handoff payload (`own.context` for `gate: "manual"`, or upstream handoff for `node.human`) and then validated against the next node's `input` schema (or collapsed to `{}` if undeclared).
6. For `retryRun`, the failed attempt's validated `inputContext` is preserved directly.

## 7. Complete Example

```ts
import { z } from "zod";
import { definePipeline, node } from "../../../src/pipeline/index.ts";
import { verifyHandler } from "./handlers/verify.ts";

export default definePipeline({
  id: "feature-delivery",
  name: "Feature Delivery",
  enabled: true,
  notifyOn: ["failed", "completed"],
  nodes: [
    node.agent({
      id: "design",
      name: "Design",
      input: z.object({
        issueNumber: z.number().int().positive(),
        requirement: z.string().min(1),
      }),
      prompt: `Design a solution for #{{ data.issueNumber }}:\n\n{{ data.requirement }}`,
      gate: "manual",
    }),
    node.agent({
      id: "implement",
      name: "Implement",
      prompt: "Implement the approved design and list all modified files in data.changedFiles.",
      allowPrev: true,
      prevTargets: ["design"],
    }),
    node.code({
      id: "verify",
      name: "Verify",
      handler: verifyHandler,
      allowPrev: true,
      prevTargets: ["implement"],
    }),
    node.human({
      id: "approve",
      name: "Approve",
      allowPrev: true,
      prevTargets: ["implement"],
    }),
    node.end({
      id: "done",
      name: "Done",
    }),
  ],
});
```

## 8. Live Contract vs Topology Versioning

A node's `input` schema is tightly coupled to its live `prompt` (`{{ data.xxx }}`) and live `run(ctx)` handler (`ctx.data.xxx`). Like `prompt`, `handler`, `runtime`, and `concurrency`, `input` is read from the **live pipeline definition** and is **not** hashed into `topologyHash`:

- Adding optional or `.default(...)` fields to a node's `input` does not split the Kanban board into a new topology version and remains backwards-compatible with in-flight runs.
- Adding a new required field to a node that an in-flight run has not entered yet is enforced by the live schema on transition (and exposed via the dynamic `pipeline_next` tool schema to the preceding agent).
- The entry node's compiled JSON Schema is exposed as `entryInputSchema` on the live `GET /projects/:projectId/pipelines` summary for UI forms.
