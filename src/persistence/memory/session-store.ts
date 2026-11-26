import type { InboundMessageRecord, SessionRoute } from "../../domain/types.ts";
import type { ListSessionsOptions } from "../types.ts";

/** In-memory repository for `sessions` and `inbound_messages`. */
export class MemorySessionStore {
  readonly sessions = new Map<string, SessionRoute>();
  readonly inboundMessages = new Map<string, string | undefined>();

  async createSession(route: SessionRoute): Promise<SessionRoute> {
    const stored: SessionRoute = {
      ...structuredClone(route),
      source: route.source ?? "unknown",
      runtime:
        route.runtime ?? (route.metadata?.runtime as string | undefined) ?? "unknown",
    };
    this.sessions.set(route.sessionId, stored);
    return structuredClone(stored);
  }

  async getSession(sessionId: string): Promise<SessionRoute | null> {
    const found = this.sessions.get(sessionId);
    return found ? structuredClone(found) : null;
  }

  async listSessions(projectId?: string, options?: ListSessionsOptions): Promise<SessionRoute[]> {
    const result: SessionRoute[] = [];
    for (const session of this.sessions.values()) {
      if (projectId && session.projectId !== projectId) continue;
      if (!options?.includeTasks && session.source === "task") continue;
      if (!options?.includePipelines && session.source === "pipeline") continue;
      result.push(structuredClone(session));
    }
    return result.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  }

  async updateSession(route: SessionRoute): Promise<void> {
    const existing = this.sessions.get(route.sessionId);
    const { title: _ignored, ...state } = structuredClone(route);
    const next: SessionRoute = {
      ...state,
      ...(existing?.title ? { title: existing.title } : {}),
    };
    this.sessions.set(route.sessionId, next);
  }

  async updateSessionTitle(sessionId: string, title: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.title = title;
    return true;
  }

  async setTitleIfEmpty(sessionId: string, title: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || session.title) return false;
    session.title = title;
    return true;
  }

  async findSessionByExternal(
    channel: string,
    conversationId: string,
    threadId?: string,
  ): Promise<SessionRoute | null> {
    let best: SessionRoute | undefined;
    for (const session of this.sessions.values()) {
      if (
        session.externalChannel === channel &&
        session.externalConversationId === conversationId &&
        (session.externalThreadId ?? undefined) === (threadId ?? undefined) &&
        session.status !== "archived" &&
        (!best || session.lastActiveAt > best.lastActiveAt)
      ) {
        best = session;
      }
    }
    return best ? structuredClone(best) : null;
  }

  async claimInboundMessage(message: InboundMessageRecord): Promise<boolean> {
    if (this.inboundMessages.has(message.messageId)) return false;
    this.inboundMessages.set(message.messageId, message.sessionId);
    return true;
  }

  async releaseInboundMessage(messageId: string): Promise<void> {
    this.inboundMessages.delete(messageId);
  }

  deleteBySession(sessionId: string): void {
    this.sessions.delete(sessionId);
    for (const [messageId, inboundSessionId] of this.inboundMessages) {
      if (inboundSessionId === sessionId) {
        this.inboundMessages.delete(messageId);
      }
    }
  }
}
