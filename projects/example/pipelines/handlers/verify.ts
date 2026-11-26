import { defineHandler, z } from "../../../../src/pipeline/index.ts";

/**
 * Reusable external TypeScript code-node handler created with `defineHandler`.
 * Declares its own strongly-typed `input` contract; `ctx.data` is statically typed
 * and runtime-validated before `run()` executes.
 */
export const verifyHandler = defineHandler({
  input: z.object({
    changedFiles: z
      .array(z.string())
      .default([])
      .describe("Optional list of modified files reported by the implementation stage"),
  }),
  async run(ctx) {
    const info = await ctx.step("collect-info", () => ({
      runId: ctx.runId,
      branch: ctx.branchName ?? "unknown",
      changedFileCount: ctx.data.changedFiles.length,
      checkedAt: new Date().toISOString(),
    }));

    // Replace with an actual external status check (e.g. CI job or deployment health).
    const ready = await ctx.waitUntil(
      "check-ready",
      { intervalMs: 30_000, summary: "Waiting for verification check" },
      () => true,
    );

    ctx.logger.info("verification completed", { ...info, ready });

    return {
      action: "next",
      summary: `Verification passed on ${info.branch} (${info.changedFileCount} changed files)`,
      content: `Verified run \`${info.runId}\` at ${info.checkedAt}.`,
      metadata: info,
    };
  },
});
