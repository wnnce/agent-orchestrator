import type { PipelineTsResult, PipelineTsRunContext } from "../../../../src/pipeline/types.ts";

/**
 * Minimal example TypeScript pipeline node handler.
 * Demonstrates durable `ctx.step`, `ctx.waitUntil`, and structured flow return.
 */
export default async function verifyHandler(
  ctx: PipelineTsRunContext,
): Promise<PipelineTsResult> {
  const info = await ctx.step("collect-info", () => ({
    runId: ctx.runId,
    branch: ctx.branchName ?? "unknown",
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
    summary: `Verification passed on ${info.branch}`,
    content: `Verified run \`${info.runId}\` at ${info.checkedAt}.`,
    data: info,
  };
}
