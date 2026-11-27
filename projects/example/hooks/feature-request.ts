import { defineHook } from "../../../src/hooks/index.ts";

interface FeatureRequest {
  readonly key: string;
  readonly title: string;
  readonly description?: string;
}

/**
 * Example project hook, served at `POST /hooks/<projectId>/feature-request`.
 *
 * Files under `projects/<projectId>/hooks/*.ts` are loaded when the project starts. A hook gets
 * the request exactly as it arrived and answers it itself, so checking the sender, parsing the
 * payload and deciding what to do all happen here.
 *
 * This one expects JSON such as `{"key": "FR-12", "title": "Export to CSV"}`, signed with an
 * `x-signature` header: the hex HMAC-SHA256 of the body under `FEATURE_HOOK_SECRET` from `.env`.
 * It starts the `feature-delivery` pipeline once per key; a resent request gets the same run.
 */
export default defineHook({
  name: "Feature request",
  description: "Starts the feature-delivery pipeline for a signed feature request",
  async handle(request, ctx) {
    if (request.method !== "POST") return new Response(null, { status: 405 });

    const body = await request.text();
    const secret = ctx.project.env.FEATURE_HOOK_SECRET;
    if (!secret || !(await isSigned(body, request.headers.get("x-signature"), secret))) {
      return Response.json({ error: "invalid_signature" }, { status: 401 });
    }

    const feature = parseFeatureRequest(body);
    if (!feature) return Response.json({ error: "invalid_payload" }, { status: 400 });

    const { run, created } = await ctx.pipelines.start({
      pipelineId: "feature-delivery",
      externalKey: feature.key,
      title: feature.title,
      ...(feature.description ? { description: feature.description } : {}),
    });
    ctx.logger.info("feature request received", { key: feature.key, runId: run.runId, created });
    return Response.json({ runId: run.runId, created }, { status: created ? 201 : 200 });
  },
});

/** Whether `signature` is the hex HMAC-SHA256 of `body` under `secret`, compared in constant time. */
async function isSigned(body: string, signature: string | null, secret: string): Promise<boolean> {
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, Uint8Array.fromHex(signature), encoder.encode(body));
}

function parseFeatureRequest(body: string): FeatureRequest | undefined {
  try {
    const value = JSON.parse(body) as Partial<FeatureRequest>;
    if (typeof value.key !== "string" || typeof value.title !== "string") return undefined;
    return {
      key: value.key,
      title: value.title,
      ...(typeof value.description === "string" ? { description: value.description } : {}),
    };
  } catch {
    return undefined;
  }
}
