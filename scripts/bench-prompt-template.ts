/**
 * Reproducible micro-benchmark for `src/prompt/template.ts` (Design Doc 10).
 *
 * Run with:
 *   bun run scripts/bench-prompt-template.ts
 */
import type { ProjectConfig } from "../src/domain/types.ts";
import {
  buildNowPromptScope,
  buildProjectPromptScope,
  findMissingProjectVars,
  renderPromptTemplate,
} from "../src/prompt/template.ts";

interface BenchStats {
  readonly name: string;
  readonly iterations: number;
  readonly opsPerSec: number;
  readonly avgMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly targetMs: number;
  readonly pass: boolean;
}

/** Legacy multi-pass replaceAll + regex baseline (prior ProjectRuntime.renderTaskPrompt). */
function legacyRenderTaskPrompt(
  template: string,
  vars: {
    state: Record<string, unknown>;
    projectId: string;
    taskId: string;
    taskKey: string;
    taskName: string;
  },
): string {
  let result = template;
  result = result.replaceAll("{{projectId}}", vars.projectId);
  result = result.replaceAll("{{taskId}}", vars.taskId);
  result = result.replaceAll("{{taskKey}}", vars.taskKey);
  result = result.replaceAll("{{taskName}}", vars.taskName);
  result = result.replaceAll("{{state}}", JSON.stringify(vars.state, null, 2));
  result = result.replace(/\{\{state\.([a-zA-Z0-9_]+)\}\}/g, (_, field: string) => {
    const val = vars.state[field];
    if (val === undefined || val === null) return "";
    return typeof val === "object" ? JSON.stringify(val) : String(val);
  });
  return result;
}

function runBench(
  name: string,
  fn: () => unknown,
  options: { warmup: number; iterations: number; targetMs: number },
): BenchStats {
  let sink: unknown;
  for (let i = 0; i < options.warmup; i++) {
    sink = fn();
  }

  const samples = new Float64Array(options.iterations);
  const totalStart = Bun.nanoseconds();
  for (let i = 0; i < options.iterations; i++) {
    const t0 = Bun.nanoseconds();
    sink = fn();
    samples[i] = (Bun.nanoseconds() - t0) / 1e6;
  }
  const totalMs = (Bun.nanoseconds() - totalStart) / 1e6;
  if (sink === "__never__") console.log(sink);

  samples.sort();
  const percentile = (p: number) => {
    const idx = Math.min(samples.length - 1, Math.floor((samples.length - 1) * p));
    return samples[idx] ?? 0;
  };

  const avgMs = totalMs / options.iterations;
  const opsPerSec = (options.iterations / totalMs) * 1000;
  const p50Ms = percentile(0.5);
  const p95Ms = percentile(0.95);
  const p99Ms = percentile(0.99);

  return {
    name,
    iterations: options.iterations,
    opsPerSec,
    avgMs,
    p50Ms,
    p95Ms,
    p99Ms,
    targetMs: options.targetMs,
    pass: avgMs <= options.targetMs,
  };
}

const sampleProject: ProjectConfig = {
  id: "example-service",
  displayName: "Example Service",
  description: "Benchmark project configuration",
  routing: { projectId: "example-service" },
  repository: {
    url: "git@github.com:example/example-service.git",
    baseBranch: "main",
    committer: { name: "Orchestrator Bot", email: "bot@example.com" },
  },
  vars: {
    githubAuthor: "alice",
    issueReadyLabel: "issue:ready",
    defaultBranch: "main",
    maxIssues: 25,
    reviewChecklist: "Check error handling, concurrency, and tests.",
  },
};

const standardScopes = {
  project: buildProjectPromptScope(sampleProject),
  vars: sampleProject.vars ?? {},
  task: {
    id: "issue-triage",
    key: "example-service:issue-triage",
    name: "Issue Triage",
    cron: "0,30 * * * *",
    timezone: "Asia/Shanghai",
  },
  state: {
    lastCheckedAt: "2026-11-24T10:00:00Z",
    cursor: { page: 4, total: 120 },
    processedIds: [101, 102, 103, 104],
  },
  now: buildNowPromptScope("Asia/Shanghai"),
};

// S1: Small prompt (~500 B, 5 vars)
const s1Small = [
  "# Task {{task.name}} ({{task.key}})",
  "Project: {{project.id}} | Repo: {{project.repo.slug}} ({{project.repo.baseBranch}})",
  "Search: repo:{{project.repo.slug}} author:{{vars.githubAuthor}} label:{{vars.issueReadyLabel | issue:ready}}",
  "Cursor: {{state.cursor.page}} | Now: {{now.iso}}",
  "Review notes: {{vars.reviewChecklist}} ".repeat(5),
].join("\n");

// S2: Typical Markdown task prompt (~5 KB, 25 vars + 20 foreign code-block {{...}})
const s2Block = [
  "## Section for {{project.repo.slug}}",
  "Author: {{vars.githubAuthor}}, Batch: {{vars.maxIssues | 10}}, Branch: {{project.repo.baseBranch}}",
  "State cursor: {{state.cursor.page}}, Last checked: {{state.lastCheckedAt}}",
  "```yaml",
  "image: {{ .Values.image.repository }}:{{ .Values.image.tag }}",
  "replicas: {{ item.replicas }}",
  "template: {{ component.name }}",
  "env: {{ unknown.nested.value }}",
  "```",
  "Guidelines: Check code conventions, verify tests, and ensure no secrets are logged in output. ".repeat(
    6,
  ),
].join("\n");
const s2Typical = Array.from({ length: 5 }, () => s2Block).join("\n\n");

// Legacy equivalent of S2 (~5 KB) for apples-to-apples baseline comparison
const s2LegacyEquivalent = s2Typical
  .replaceAll("{{project.repo.slug}}", "{{projectId}}")
  .replaceAll("{{vars.githubAuthor}}", "{{taskId}}")
  .replaceAll("{{vars.maxIssues | 10}}", "{{taskName}}")
  .replaceAll("{{project.repo.baseBranch}}", "{{taskKey}}")
  .replaceAll("{{state.cursor.page}}", "{{state.lastCheckedAt}}");

// S3: Large prompt (~100 KB, 200 vars + 100 foreign {{...}})
const s3Large = Array.from({ length: 100 }, (_, idx) => {
  return [
    `### Chunk ${idx}`,
    `Ref: {{project.repo.slug}} / {{vars.githubAuthor}} / {{state.cursor.page}} / {{vars.opt${idx} | default_${idx}}}`,
    "Code: {{ foreign.a }} {{ foreign.b }}",
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ".repeat(
      7,
    ),
  ].join("\n");
}).join("\n");

// S4: Pathological unclosed / half-closed braces (~50 KB, ReDoS stress test)
const s4Pathological =
  "{{".repeat(12_000) +
  "{{ vars.githubAuthor ".repeat(1_000) +
  "{{project.repo.slug}}" +
  "{{".repeat(2_000);

const results: BenchStats[] = [
  runBench(
    `S1: Small prompt (${s1Small.length} B, 5 vars)`,
    () => renderPromptTemplate(s1Small, standardScopes),
    { warmup: 2_000, iterations: 20_000, targetMs: 0.02 },
  ),
  runBench(
    `S2: Typical prompt (${(s2Typical.length / 1024).toFixed(1)} KB, 25 vars + 20 foreign)`,
    () => renderPromptTemplate(s2Typical, standardScopes),
    { warmup: 1_000, iterations: 10_000, targetMs: 0.1 },
  ),
  runBench(
    `S2-Baseline: Legacy multi-pass replaceAll (${(s2LegacyEquivalent.length / 1024).toFixed(1)} KB)`,
    () =>
      legacyRenderTaskPrompt(s2LegacyEquivalent, {
        projectId: "example-service",
        taskId: "issue-triage",
        taskKey: "example-service:issue-triage",
        taskName: "Issue Triage",
        state: standardScopes.state,
      }),
    { warmup: 1_000, iterations: 10_000, targetMs: 1.0 },
  ),
  runBench(
    `S3: Large prompt (${(s3Large.length / 1024).toFixed(1)} KB, 400 vars + 200 foreign)`,
    () => renderPromptTemplate(s3Large, standardScopes),
    { warmup: 100, iterations: 1_000, targetMs: 2.0 },
  ),
  runBench(
    `S4: Pathological unclosed braces (${(s4Pathological.length / 1024).toFixed(1)} KB, ReDoS test)`,
    () => renderPromptTemplate(s4Pathological, standardScopes),
    { warmup: 100, iterations: 1_000, targetMs: 5.0 },
  ),
  runBench(
    `S5: Static findMissingProjectVars (${(s2Typical.length / 1024).toFixed(1)} KB)`,
    () => findMissingProjectVars(s2Typical, sampleProject.vars),
    { warmup: 1_000, iterations: 10_000, targetMs: 0.05 },
  ),
  runBench(
    "S6: buildProjectPromptScope + buildNowPromptScope (cached Intl)",
    () => ({
      project: buildProjectPromptScope(sampleProject),
      now: buildNowPromptScope("Asia/Shanghai"),
    }),
    { warmup: 1_000, iterations: 10_000, targetMs: 0.05 },
  ),
];

console.log("\n=== Prompt Template Variables Benchmark ===\n");
console.table(
  results.map((r) => ({
    Scenario: r.name,
    "ops/sec": Math.round(r.opsPerSec).toLocaleString(),
    "avg (ms)": r.avgMs.toFixed(4),
    "p50 (ms)": r.p50Ms.toFixed(4),
    "p95 (ms)": r.p95Ms.toFixed(4),
    "p99 (ms)": r.p99Ms.toFixed(4),
    "target (ms)": r.targetMs.toFixed(2),
    status: r.pass ? "PASS" : "FAIL",
  })),
);

const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(
    `\nBenchmark thresholds failed for: ${failed.map((f) => f.name).join(", ")}`,
  );
  process.exit(1);
}
