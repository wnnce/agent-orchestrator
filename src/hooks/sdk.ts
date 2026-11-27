import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { ProjectContext } from "../context/types.ts";
import type { HookOrigin } from "../domain/origin.ts";

/** What a hook's `handle` receives: the project context acting as this delivery. */
export interface HookContext extends ProjectContext {
  readonly origin: HookOrigin;
  readonly hook: {
    readonly id: string;
    readonly name: string;
    /**
     * Generated for each request. The platform's own delivery ID (such as GitHub's
     * `X-GitHub-Delivery` header) is the hook's to read and log.
     */
    readonly deliveryId: string;
  };
}

/**
 * Handles one HTTP delivery. The request arrives untouched, so its body can be read raw for
 * signature checks. Returning nothing answers 204.
 */
export type HookHandle = (
  request: Request,
  ctx: HookContext,
) => Promise<Response | void> | Response | void;

export interface HookSpec {
  /** The last segment of the hook's URL, unique within the project. Defaults to the file name. */
  readonly id?: string | undefined;
  /** A name for people, shown in logs and hook listings. */
  readonly name: string;
  readonly description?: string | undefined;
  /**
   * How long the handler may run before `ctx.signal` aborts; 30s by default. Platforms give up
   * on a delivery within seconds, so slow work belongs in a pipeline run or session.
   */
  readonly timeoutMs?: number | undefined;
  readonly handle: HookHandle;
}

const HOOK_BRAND = "AgentOrchestratorHook" as const;

/** A hook as `defineHook` returns it; the loader accepts nothing else. */
export interface DefinedHook extends HookSpec {
  readonly __brand: typeof HOOK_BRAND;
}

/**
 * Declares an HTTP hook. A file under `projects/<id>/hooks/` default-exports one hook, served at
 * `/hooks/<projectId>/<hookId>` for any HTTP method. Verifying that a request really comes from
 * the platform is up to the hook.
 *
 * ```ts
 * export default defineHook({
 *   name: "GitHub events",
 *   async handle(request, ctx) {
 *     const body = await request.text();
 *     const signature = request.headers.get("x-hub-signature-256");
 *     if (!verifyHmacSha256(body, signature, ctx.project.env.GITHUB_SECRET ?? "", "sha256=")) {
 *       return new Response("invalid signature", { status: 401 });
 *     }
 *     // ...
 *   },
 * });
 * ```
 */
export function defineHook(spec: HookSpec): DefinedHook {
  return { ...spec, __brand: HOOK_BRAND };
}

export function isDefinedHook(value: unknown): value is DefinedHook {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __brand?: unknown }).__brand === HOOK_BRAND
  );
}

/** Hook ids appear in URLs; the same rule as pipeline ids. */
export const HOOK_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;

/** Validates what `defineHook` was given. */
export const hookSpecSchema = z
  .object({
    __brand: z.literal(HOOK_BRAND),
    id: z.string().regex(HOOK_ID_RE, "invalid hook id").optional(),
    name: z.string().trim().min(1),
    description: z.string().optional(),
    timeoutMs: z.number().positive().optional(),
    handle: z.custom<HookHandle>((value) => typeof value === "function", {
      message: "handle must be a function",
    }),
  })
  .strict();

/**
 * Checks an HMAC-SHA256 signature of `body`, as sent by GitHub, GitLab and many others. The
 * signature is hex, optionally after `prefix` (GitHub's is `"sha256="`). Compares in constant
 * time; a missing or malformed signature is simply invalid.
 */
export function verifyHmacSha256(
  body: string | Uint8Array,
  signature: string | null | undefined,
  secret: string,
  prefix = "",
): boolean {
  if (!signature || !secret || !signature.startsWith(prefix)) return false;
  const given = Buffer.from(signature.slice(prefix.length), "hex");
  const expected = createHmac("sha256", secret).update(body).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}
