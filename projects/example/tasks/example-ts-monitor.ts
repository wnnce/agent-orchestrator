import { defineTask } from "../../../src/task/sdk.ts";

/**
 * Example TypeScript task module.
 *
 * Contract:
 * 1. Default-export `defineTask({ ... })`, or an array of them.
 * 2. When a file exports several tasks, every task must specify a unique `id`.
 * 3. `run(ctx)` gets the project context acting as this execution: `ctx.project.env` / `vars`,
 *    `ctx.notify`, `ctx.artifacts`, `ctx.mcp`, `ctx.sessions`, `ctx.pipelines`, `ctx.render`.
 * 4. `ctx.state` holds the task's state between executions; it is saved when `run` succeeds.
 *    An object `run` returns is recorded as the execution's summary.
 * 5. Helper files starting with `_` (e.g. `_helpers.ts`) are ignored by the task loader.
 */

interface PollState {
  lastCheckedAt?: string;
  lastDispatchedCount?: number;
}

interface HeartbeatState {
  runCount?: number;
  lastArtifactId?: string;
}

export default [
  // Zero-token deterministic polling -> start an agent session only when needed.
  defineTask<PollState>({
    id: "example-issue-poll",
    name: "Example TS Issue Poll",
    cron: "*/10 * * * *",
    timezone: "Asia/Shanghai",
    enabled: false,
    timeoutMs: 30_000,
    description:
      "Polls GitHub issues with zero LLM tokens and starts a project-default agent session only when actionable issues arrive.",
    async run(ctx) {
      // Values from `projects/example/.env` and `project.yaml` `env:`.
      const repo = ctx.project.env.GITHUB_REPO ?? "example/example-service";
      const token = ctx.project.env.GITHUB_TOKEN;
      if (!token) {
        ctx.logger.warn("GITHUB_TOKEN is not configured; skipping poll", { repo });
        return { skipped: true, reason: "missing_github_token" };
      }

      const since = ctx.state.get().lastCheckedAt;
      const now = new Date().toISOString();
      const query = new URLSearchParams({
        state: "open",
        labels: "issue:ready",
        ...(since ? { since } : {}),
      });

      const response = await fetch(`https://api.github.com/repos/${repo}/issues?${query}`, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
        },
        signal: ctx.signal,
      });
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

      const startedSessions: string[] = [];
      for (const issue of actionable) {
        // Sessions use project.yaml's runtime and model unless `runtime` / `model` are given.
        const started = await ctx.sessions.start({
          title: `dev(issue-#${issue.number}): ${issue.title}`,
          prompt: `Please investigate and resolve GitHub Issue #${issue.number} (${issue.html_url}):\n\n${issue.title}`,
          metadata: { issueNumber: issue.number, issueUrl: issue.html_url },
        });
        startedSessions.push(started.sessionId);
      }

      if (startedSessions.length > 0) {
        await ctx.notify({
          title: `[${ctx.project.id}] Started ${startedSessions.length} issue session(s)`,
          text: `Sessions: ${startedSessions.join(", ")}`,
          level: "info",
        });
      }

      ctx.state.set({ lastCheckedAt: now, lastDispatchedCount: startedSessions.length });
      return {
        repo,
        checkedSince: since ?? null,
        startedCount: startedSessions.length,
        startedSessions,
      };
    },
  }),

  // Lightweight scheduled digest that persists an artifact and sends a notification.
  defineTask<HeartbeatState>({
    id: "example-daily-heartbeat",
    name: "Example TS Daily Heartbeat",
    cron: "0 10 * * 1-5",
    timezone: "Asia/Shanghai",
    enabled: false,
    description: "Writes a daily status artifact and posts a concise notification.",
    async run(ctx) {
      const runCount = (ctx.state.get().runCount ?? 0) + 1;
      const report = ctx.render(
        [
          "# Daily Heartbeat (#{{ runCount }})",
          "- Project: {{ project.id }}",
          "- Time: {{ now.local }}",
        ].join("\n"),
        { runCount },
      );

      const artifact = await ctx.artifacts.create({
        kind: "daily-heartbeat",
        content: report,
        contentType: "text/markdown; charset=utf-8",
      });

      await ctx.notify({
        title: `[${ctx.project.id}] Daily Heartbeat #${runCount}`,
        text: `Heartbeat recorded (artifact: ${artifact.id}).`,
        markdown: report,
        level: "info",
      });

      ctx.state.set({ runCount, lastArtifactId: artifact.id });
      return { runCount, artifactId: artifact.id };
    },
  }),
];
