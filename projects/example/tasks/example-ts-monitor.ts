import type { TaskExtensionAPI } from "../../../src/task/sdk.ts";

/**
 * Example TypeScript task module using Pi-style dynamic injection.
 *
 * Contract:
 * 1. Must default-export a factory function: `export default function (api: TaskExtensionAPI)`
 * 2. Register one or more tasks via `api.registerTask({ ... })`
 * 3. When registering multiple tasks in one file, every task must specify a unique `id`
 * 4. Helper files starting with `_` (e.g. `_helpers.ts`) are ignored by the task loader
 */
export default function (api: TaskExtensionAPI) {
  // Values from `projects/example/.env` and `project.yaml` `env:` are injected into `api.env` / `ctx.env`.
  const targetRepo = api.env.GITHUB_REPO ?? "example/example-service";

  // Task 1: Zero-token deterministic polling -> dispatch an Agent session only when needed.
  api.registerTask({
    id: "example-issue-poll",
    name: "Example TS Issue Poll",
    cron: "*/10 * * * *",
    timezone: "Asia/Shanghai",
    enabled: false,
    timeoutMs: 30_000,
    description:
      "Polls GitHub issues with zero LLM tokens and dispatches a project-default Agent session only when actionable issues arrive.",
    async run(ctx) {
      const token = ctx.env.GITHUB_TOKEN;
      if (!token) {
        ctx.logger.warn("GITHUB_TOKEN is not configured; skipping poll", { repo: targetRepo });
        return { summary: { skipped: true, reason: "missing_github_token" } };
      }

      const prevState = await ctx.getState();
      const since =
        typeof prevState.lastCheckedAt === "string" ? prevState.lastCheckedAt : undefined;
      const now = new Date().toISOString();

      const query = new URLSearchParams({
        state: "open",
        labels: "issue:ready",
        ...(since ? { since } : {}),
      });

      const response = await fetch(
        `https://api.github.com/repos/${targetRepo}/issues?${query.toString()}`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
          },
          signal: ctx.signal,
        },
      );

      if (!response.ok) {
        throw new Error(`GitHub API returned ${response.status}: ${response.statusText}`);
      }

      const issues = (await response.json()) as Array<{
        number: number;
        title: string;
        html_url: string;
        pull_request?: unknown;
      }>;
      const actionable = issues.filter((item) => !item.pull_request);

      const dispatchedSessions: string[] = [];
      for (const issue of actionable) {
        // Sessions dispatched via `ctx.dispatchTask` always follow `project.yaml`'s default runtime & model.
        const dispatched = await ctx.dispatchTask({
          title: `dev(issue-#${issue.number}): ${issue.title}`,
          prompt: `Please investigate and resolve GitHub Issue #${issue.number} (${issue.html_url}):\n\n${issue.title}`,
          metadata: { issueNumber: issue.number, issueUrl: issue.html_url },
        });
        dispatchedSessions.push(dispatched.sessionId);
      }

      if (dispatchedSessions.length > 0) {
        await ctx.notify({
          title: `[${ctx.projectId}] Dispatched ${dispatchedSessions.length} issue session(s)`,
          text: `Dispatched sessions: ${dispatchedSessions.join(", ")}`,
          level: "info",
        });
      }

      return {
        state: {
          lastCheckedAt: now,
          lastDispatchedCount: dispatchedSessions.length,
        },
        summary: {
          repo: targetRepo,
          checkedSince: since ?? null,
          dispatchedCount: dispatchedSessions.length,
          dispatchedSessions,
        },
      };
    },
  });

  // Task 2: Lightweight scheduled digest that persists an artifact and sends a notification.
  api.registerTask({
    id: "example-daily-heartbeat",
    name: "Example TS Daily Heartbeat",
    cron: "0 10 * * 1-5",
    timezone: "Asia/Shanghai",
    enabled: false,
    description: "Writes a daily status artifact and posts a concise notification.",
    async run(ctx) {
      const prev = await ctx.getState();
      const runCount = typeof prev.runCount === "number" ? prev.runCount + 1 : 1;
      const report = [
        `# Daily Heartbeat (#${runCount})`,
        `- Project: ${ctx.projectId}`,
        `- Repo: ${targetRepo}`,
        `- Workdir: ${ctx.workdir}`,
        `- Timestamp: ${new Date().toISOString()}`,
      ].join("\n");

      const artifact = await ctx.createArtifact({
        kind: "daily-heartbeat",
        content: report,
        contentType: "text/markdown; charset=utf-8",
      });

      await ctx.notify({
        title: `[${ctx.projectId}] Daily Heartbeat #${runCount}`,
        text: `Heartbeat recorded (artifact: ${artifact.id}).`,
        markdown: report,
        level: "info",
      });

      return {
        state: { runCount, lastArtifactId: artifact.id },
        summary: { runCount, artifactId: artifact.id },
      };
    },
  });
}
