import type {
  ArtifactRecord,
  ProjectRouting,
  ProjectSkill,
  RuntimeEvent,
  ScheduledJobRecord,
  SessionRoute,
  TaskDefinition,
  TaskExecutionRecord,
} from "../types";

export async function fetchProjects(): Promise<ProjectRouting[]> {
  const res = await fetch("/projects");
  if (!res.ok) throw new Error(`Failed to fetch projects: ${res.statusText}`);
  const data = await res.json();
  return data.projects || [];
}

export async function fetchProjectSkills(projectId: string): Promise<ProjectSkill[]> {
  const res = await fetch(`/projects/${encodeURIComponent(projectId)}/skills`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.skills || [];
}

export async function fetchProjectTasks(projectId: string): Promise<TaskDefinition[]> {
  const res = await fetch(`/projects/${encodeURIComponent(projectId)}/tasks`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.tasks || [];
}

export async function runProjectTask(
  projectId: string,
  taskId: string,
): Promise<{ executionId?: string; status?: string; message?: string; queued?: boolean }> {
  const res = await fetch(`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/run`, {
    method: "POST",
  });
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.error || `Failed to trigger task: ${res.statusText}`);
  }
  return res.json();
}

export async function fetchTaskExecutions(params?: {
  projectId?: string;
  taskKey?: string;
  limit?: number;
}): Promise<TaskExecutionRecord[]> {
  const searchParams = new URLSearchParams();
  if (params?.projectId) searchParams.set("projectId", params.projectId);
  if (params?.taskKey) searchParams.set("taskKey", params.taskKey);
  if (params?.limit) searchParams.set("limit", String(params.limit));

  const qs = searchParams.toString();
  const url = `/tasks/executions${qs ? `?${qs}` : ""}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return data.executions || [];
}

export async function fetchScheduledJobs(params?: {
  sessionId?: string;
  projectId?: string;
  status?: number;
  limit?: number;
}): Promise<ScheduledJobRecord[]> {
  const searchParams = new URLSearchParams();
  if (params?.sessionId) searchParams.set("sessionId", params.sessionId);
  if (params?.projectId) searchParams.set("projectId", params.projectId);
  if (params?.status !== undefined) searchParams.set("status", String(params.status));
  if (params?.limit) searchParams.set("limit", String(params.limit));

  const qs = searchParams.toString();
  const url = `/scheduled-jobs${qs ? `?${qs}` : ""}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return data.jobs || [];
}

export async function cancelScheduledJob(
  jobId: string,
): Promise<{ success: boolean; jobId: string }> {
  const res = await fetch(`/scheduled-jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
  });
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.error || `Failed to cancel job: ${res.statusText}`);
  }
  return res.json();
}

export async function fetchSessions(projectId?: string): Promise<SessionRoute[]> {
  const url = projectId
    ? `/sessions?projectId=${encodeURIComponent(projectId)}`
    : "/sessions";
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return data.sessions || [];
}

export async function fetchSessionEvents(sessionId: string): Promise<RuntimeEvent[]> {
  const res = await fetch(`/sessions/${encodeURIComponent(sessionId)}/events`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.events || [];
}

export async function createSession(params: {
  projectId?: string;
  title?: string;
  query?: string;
  repositoryId?: string;
}): Promise<{ session: SessionRoute; routedProject: string; turn?: any }> {
  const res = await fetch("/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.error || `Failed to create session: ${res.statusText}`);
  }
  return res.json();
}

export async function getSession(
  sessionId: string,
): Promise<{ session: SessionRoute; project: ProjectRouting }> {
  const res = await fetch(`/sessions/${encodeURIComponent(sessionId)}`);
  if (!res.ok) throw new Error(`Failed to get session: ${res.statusText}`);
  return res.json();
}

export async function deleteSession(
  sessionId: string,
): Promise<{ status: string; sessionId: string }> {
  const res = await fetch(`/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.error || `Failed to delete session: ${res.statusText}`);
  }
  return res.json();
}

export async function renameSession(
  sessionId: string,
  title: string,
): Promise<{ status: string; sessionId: string; title: string }> {
  const res = await fetch(`/sessions/${encodeURIComponent(sessionId)}/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.error || `Failed to rename session: ${res.statusText}`);
  }
  return res.json();
}

export async function postTurn(sessionId: string, input: string): Promise<any> {
  const res = await fetch(`/sessions/${encodeURIComponent(sessionId)}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input }),
  });
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.error || `Failed to post turn: ${res.statusText}`);
  }
  return res.json();
}

export async function steerTurn(sessionId: string, input: string): Promise<void> {
  const res = await fetch(`/sessions/${encodeURIComponent(sessionId)}/steer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input }),
  });
  if (!res.ok) throw new Error(`Failed to steer turn: ${res.statusText}`);
}

export async function interruptTurn(sessionId: string): Promise<void> {
  const res = await fetch(`/sessions/${encodeURIComponent(sessionId)}/interrupt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Failed to interrupt turn: ${res.statusText}`);
}

export async function compactSession(sessionId: string): Promise<void> {
  const res = await fetch(`/sessions/${encodeURIComponent(sessionId)}/compact`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Failed to compact session: ${res.statusText}`);
}

export async function fetchArtifacts(sessionId: string): Promise<ArtifactRecord[]> {
  const res = await fetch(`/sessions/${encodeURIComponent(sessionId)}/artifacts`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.artifacts || [];
}

export function subscribeEvents(
  sessionId: string,
  onEvent: (event: RuntimeEvent) => void,
  onError?: (err: any) => void,
  initialAfterSequence?: number,
): () => void {
  let es: EventSource | null = null;
  let closed = false;
  let lastSequence = initialAfterSequence ?? 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function connect() {
    if (closed) return;
    const url = `/sessions/${encodeURIComponent(sessionId)}/events${
      lastSequence > 0 ? `?after=${lastSequence}` : ""
    }`;
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
}
