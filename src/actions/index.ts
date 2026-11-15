export * from "./types.ts";
export * from "./context.ts";
export * from "./registry.ts";
export * from "./builtin/index.ts";

import { ActionRegistry } from "./registry.ts";
import { builtinActions } from "./builtin/index.ts";

/**
 * Default global ActionRegistry singleton with builtin actions registered.
 */
export const defaultActionRegistry = new ActionRegistry();
defaultActionRegistry.registerAll(builtinActions);
