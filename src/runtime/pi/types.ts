import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { RuntimeContext } from "../runtime.ts";

export const PI_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/**
 * In-memory wrapper tracking a live Pi AgentSession and its turn context.
 */
export interface PiSessionWrapper {
  session: AgentSession;
  sessionId: string;
  workspacePath: string;
  context: RuntimeContext;
  currentTurnId?: string | undefined;
  currentRuntimeTurnId?: string | undefined;
  lastAssistantText?: string | undefined;
  isTurnEnded?: boolean | undefined;
  activeTurnPromise?: Promise<void> | undefined;
  unsubscribe?: (() => void) | undefined;
}
