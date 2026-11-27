import { randomUUID } from "node:crypto";
import { untilAborted } from "../context/abort.ts";
import type { ContextOptions, ScopedContext } from "../context/index.ts";
import { originSpanAttributes, type HookOrigin } from "../domain/origin.ts";
import { annotateActiveSpan } from "../observability/tracing.ts";
import type { LoadedHook } from "./loader.ts";
import type { HookContext } from "./sdk.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

/** Builds the project context a hook delivery acts through. */
export type HookContextFactory = (origin: HookOrigin, options: ContextOptions) => ScopedContext;

/**
 * Hands one HTTP request to `hook` and returns its response; a handler that returns nothing
 * answers 204. The handler's context aborts after the hook's timeout, independently of the
 * client: platforms often hang up before slow work finishes, which should not cancel it.
 */
export async function deliverHook(
  hook: LoadedHook,
  request: Request,
  createContext: HookContextFactory,
): Promise<Response> {
  const deliveryId = `dlv_${randomUUID()}`;
  const origin: HookOrigin = { kind: "hook", hookId: hook.id, deliveryId };
  const signal = AbortSignal.timeout(hook.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const scoped = createContext(origin, { signal });
  annotateActiveSpan({ "project.id": scoped.context.project.id, ...originSpanAttributes(origin) });
  const ctx: HookContext = {
    ...scoped.context,
    origin,
    hook: { id: hook.id, name: hook.name, deliveryId },
  };
  try {
    const response = await untilAborted(Promise.resolve(hook.handle(request, ctx)), signal);
    return response ?? new Response(null, { status: 204 });
  } finally {
    await scoped.dispose();
  }
}
