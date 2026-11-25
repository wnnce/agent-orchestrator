import type {
  ArtifactRecord,
  ProjectRouting,
  RuntimeEvent,
  SessionRoute,
  SessionUsageSummary,
} from "../types";
import { buildApiUrl, http } from "./http";

export interface CreateSessionParams {
  projectId?: string;
  title?: string;
  query?: string;
  runtime?: string;
  model?: string;
  reasoningEffort?: string;
}

export interface GetSessionResult {
  session: SessionRoute;
  project: ProjectRouting;
  usage?: SessionUsageSummary | null;
}

export const sessionsApi = {
  async list(projectId?: string): Promise<SessionRoute[]> {
    const data = await http.get<{ sessions?: SessionRoute[] }>("/sessions", {
      projectId,
    });
    return data.sessions ?? [];
  },

  get(sessionId: string): Promise<GetSessionResult> {
    return http.get(`/sessions/${encodeURIComponent(sessionId)}`);
  },

  create(
    params: CreateSessionParams,
  ): Promise<{ session: SessionRoute; routedProject: string; turn?: unknown }> {
    return http.post("/sessions", params);
  },

  delete(sessionId: string): Promise<{ status: string; sessionId: string }> {
    return http.delete(`/sessions/${encodeURIComponent(sessionId)}`);
  },

  rename(
    sessionId: string,
    title: string,
  ): Promise<{ status: string; sessionId: string; title: string }> {
    return http.post(`/sessions/${encodeURIComponent(sessionId)}/rename`, { title });
  },

  async listEvents(sessionId: string): Promise<RuntimeEvent[]> {
    const data = await http.get<{ events?: RuntimeEvent[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/events`,
    );
    return data.events ?? [];
  },

  postTurn(
    sessionId: string,
    input: string,
  ): Promise<{ turn?: { id?: string; createdAt?: string }; [key: string]: unknown }> {
    return http.post(`/sessions/${encodeURIComponent(sessionId)}/turns`, { input });
  },

  async steerTurn(sessionId: string, input: string): Promise<void> {
    await http.post(`/sessions/${encodeURIComponent(sessionId)}/steer`, { input });
  },

  async interruptTurn(sessionId: string): Promise<void> {
    await http.post(`/sessions/${encodeURIComponent(sessionId)}/interrupt`);
  },

  async compact(sessionId: string): Promise<void> {
    await http.post(`/sessions/${encodeURIComponent(sessionId)}/compact`);
  },

  async listArtifacts(sessionId: string): Promise<ArtifactRecord[]> {
    const data = await http.get<{ artifacts?: ArtifactRecord[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/artifacts`,
    );
    return data.artifacts ?? [];
  },

  getArtifactDownloadUrl(sessionId: string, artifactId: string): string {
    return buildApiUrl(
      `/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifactId)}`,
    );
  },

  subscribeEvents(
    sessionId: string,
    onEvent: (event: RuntimeEvent) => void,
    onError?: (err: Event) => void,
    initialAfterSequence?: number,
  ): () => void {
    let es: EventSource | null = null;
    let closed = false;
    let lastSequence = initialAfterSequence ?? 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      if (closed) return;
      const url = buildApiUrl(`/sessions/${encodeURIComponent(sessionId)}/events`, {
        after: lastSequence > 0 ? lastSequence : undefined,
      });
      es = new EventSource(url);

      es.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data && typeof data.sequence === "number") {
            lastSequence = Math.max(lastSequence, data.sequence);
          }
          onEvent(data);
        } catch (err) {
          console.warn("Failed to parse SSE event:", err, e.data);
        }
      };

      es.onerror = (err) => {
        if (onError) onError(err);
        if (es) {
          es.close();
          es = null;
        }
        if (!closed) {
          retryTimer = setTimeout(connect, 1500);
        }
      };
    }

    connect();

    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (es) es.close();
    };
  },
};
