import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
} from "react";
import { useLocation } from "wouter";
import { projectsApi, sessionsApi, systemApi } from "../api";
import type { ProjectRouting, SessionRoute, StudioView } from "../types";

interface StudioContextType {
  activeView: StudioView;
  setActiveView: (view: StudioView) => void;
  projects: ProjectRouting[];
  activeProjectId: string | null;
  setActiveProjectId: (id: string | null) => void;
  activeProject: ProjectRouting | null;
  sessions: SessionRoute[];
  setSessions: React.Dispatch<React.SetStateAction<SessionRoute[]>>;
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;
  activeSession: SessionRoute | null;
  activeTaskId: string | null;
  activeExecutionId: string | null;
  isReady: boolean;
  showInspector: boolean;
  setShowInspector: (show: boolean) => void;
  toggleInspector: () => void;
  openSession: (sessionId: string) => void;
  closeToBoard: () => void;
  openTask: (taskId: string, executionId?: string | null) => void;
  closeToTasks: () => void;
  refreshProjects: () => Promise<void>;
  refreshSessions: () => Promise<void>;
}

const StudioContext = createContext<StudioContextType | null>(null);

export function StudioProvider({ children }: { children: React.ReactNode }) {
  const [location, navigate] = useLocation();
  const [projects, setProjects] = useState<ProjectRouting[]>([]);
  const [sessions, setSessions] = useState<SessionRoute[]>([]);
  const [isReady, setIsReady] = useState(false);
  const [showInspector, setShowInspector] = useState(false);

  // Synchronously parse routing parameters from location
  const { activeProjectId, activeView, activeSessionId, activeTaskId, activeExecutionId } = useMemo(() => {
    // 1. Match /:projectId/sessions/:sessionId
    const sessionMatch = location.match(/^\/([^/]+)\/sessions\/([^/]+)\/?$/);
    if (sessionMatch) {
      return {
        activeProjectId: decodeURIComponent(sessionMatch[1]!),
        activeView: "sessions" as StudioView,
        activeSessionId: decodeURIComponent(sessionMatch[2]!),
        activeTaskId: null,
        activeExecutionId: null,
      };
    }

    // 2. Match /:projectId/tasks/:taskId/:executionId
    const taskExecMatch = location.match(/^\/([^/]+)\/tasks\/([^/]+)\/([^/]+)\/?$/);
    if (taskExecMatch) {
      return {
        activeProjectId: decodeURIComponent(taskExecMatch[1]!),
        activeView: "tasks" as StudioView,
        activeSessionId: null,
        activeTaskId: decodeURIComponent(taskExecMatch[2]!),
        activeExecutionId: decodeURIComponent(taskExecMatch[3]!),
      };
    }

    // 3. Match /:projectId/tasks/:taskId
    const taskMatch = location.match(/^\/([^/]+)\/tasks\/([^/]+)\/?$/);
    if (taskMatch) {
      return {
        activeProjectId: decodeURIComponent(taskMatch[1]!),
        activeView: "tasks" as StudioView,
        activeSessionId: null,
        activeTaskId: decodeURIComponent(taskMatch[2]!),
        activeExecutionId: null,
      };
    }

    // 4. Match /:projectId/:view
    const viewMatch = location.match(/^\/([^/]+)\/([^/]+)\/?$/);
    if (viewMatch) {
      const rawView = viewMatch[2]!;
      let v: StudioView = "sessions";
      if (rawView === "sessions" || rawView === "tasks" || rawView === "jobs" || rawView === "project") {
        v = rawView;
      } else if (rawView === "overview") {
        v = "project";
      }
      return {
        activeProjectId: decodeURIComponent(viewMatch[1]!),
        activeView: v,
        activeSessionId: null,
        activeTaskId: null,
        activeExecutionId: null,
      };
    }

    // 5. Match /:projectId
    const projMatch = location.match(/^\/([^/]+)\/?$/);
    if (projMatch) {
      return {
        activeProjectId: decodeURIComponent(projMatch[1]!),
        activeView: "sessions" as StudioView,
        activeSessionId: null,
        activeTaskId: null,
        activeExecutionId: null,
      };
    }

    // 6. Root "/" or other paths
    return {
      activeProjectId: null,
      activeView: "sessions" as StudioView,
      activeSessionId: null,
      activeTaskId: null,
      activeExecutionId: null,
    };
  }, [location]);

  // Load project list
  const refreshProjects = useCallback(async () => {
    try {
      const list = await projectsApi.list();
      setProjects(list);
    } catch (err) {
      console.error("Failed to load projects:", err);
    }
  }, []);

  // Load session list for active project
  const refreshSessions = useCallback(async () => {
    if (!activeProjectId) return;
    try {
      const list = await sessionsApi.list(activeProjectId);
      setSessions(list);
    } catch (err) {
      console.error("Failed to load sessions:", err);
    }
  }, [activeProjectId]);

  // Initial ready check and projects fetch
  useEffect(() => {
    systemApi.checkReady().then(setIsReady);

    refreshProjects();
  }, [refreshProjects]);

  // Refresh sessions when activeProjectId changes
  useEffect(() => {
    if (activeProjectId) {
      refreshSessions();
    }
  }, [activeProjectId, refreshSessions]);

  // Auto-redirect for root "/" or unassigned project URLs using last visited memory
  useEffect(() => {
    if (projects.length === 0) return;

    if (activeProjectId) {
      // Remember last visited valid project
      try {
        localStorage.setItem("last_active_project", activeProjectId);
      } catch (e) {
        /* ignore */
      }
      return;
    }

    // Root "/" or unassigned project: fallback to stored or first available project
    let targetProject: string | undefined;
    try {
      const stored = localStorage.getItem("last_active_project");
      if (stored && projects.some((p) => p.projectId === stored)) {
        targetProject = stored;
      }
    } catch (e) {
      /* ignore */
    }

    if (!targetProject) {
      targetProject = projects[0]?.projectId;
    }

    if (targetProject) {
      navigate(`/${targetProject}/sessions`, { replace: true });
    }
  }, [projects, activeProjectId, navigate]);

  // Resolved active entities
  const activeProject = useMemo(() => {
    return projects.find((p) => p.projectId === activeProjectId) || null;
  }, [projects, activeProjectId]);

  const activeSession = useMemo(() => {
    return sessions.find((s) => s.sessionId === activeSessionId) || null;
  }, [sessions, activeSessionId]);

  // Navigation handlers (drive the browser URL)
  const setActiveView = useCallback(
    (view: StudioView) => {
      const targetProj = activeProjectId || projects[0]?.projectId || "default";
      navigate(`/${targetProj}/${view}`);
    },
    [activeProjectId, projects, navigate],
  );

  const setActiveProjectId = useCallback(
    (id: string | null) => {
      if (!id) return;
      try {
        localStorage.setItem("last_active_project", id);
      } catch (e) {
        /* ignore */
      }
      navigate(`/${id}/${activeView}`);
    },
    [activeView, navigate],
  );

  const setActiveSessionId = useCallback(
    (id: string | null) => {
      const targetProj = activeProjectId || projects[0]?.projectId || "default";
      if (id) {
        navigate(`/${targetProj}/sessions/${id}`);
      } else {
        navigate(`/${targetProj}/sessions`);
      }
    },
    [activeProjectId, projects, navigate],
  );

  const openSession = useCallback(
    (sessionId: string) => {
      const targetProj = activeProjectId || projects[0]?.projectId || "default";
      navigate(`/${targetProj}/sessions/${sessionId}`);
    },
    [activeProjectId, projects, navigate],
  );

  const closeToBoard = useCallback(() => {
    const targetProj = activeProjectId || projects[0]?.projectId || "default";
    navigate(`/${targetProj}/sessions`);
  }, [activeProjectId, projects, navigate]);

  const openTask = useCallback(
    (taskId: string, executionId?: string | null) => {
      const targetProj = activeProjectId || projects[0]?.projectId || "default";
      const base = `/${encodeURIComponent(targetProj)}/tasks/${encodeURIComponent(taskId)}`;
      navigate(executionId ? `${base}/${encodeURIComponent(executionId)}` : base);
    },
    [activeProjectId, projects, navigate],
  );

  const closeToTasks = useCallback(() => {
    const targetProj = activeProjectId || projects[0]?.projectId || "default";
    navigate(`/${encodeURIComponent(targetProj)}/tasks`);
  }, [activeProjectId, projects, navigate]);

  const toggleInspector = useCallback(() => setShowInspector((prev) => !prev), []);

  return (
    <StudioContext.Provider
      value={{
        activeView,
        setActiveView,
        projects,
        activeProjectId,
        setActiveProjectId,
        activeProject,
        sessions,
        setSessions,
        activeSessionId,
        setActiveSessionId,
        activeSession,
        activeTaskId,
        activeExecutionId,
        isReady,
        showInspector,
        setShowInspector,
        toggleInspector,
        openSession,
        closeToBoard,
        openTask,
        closeToTasks,
        refreshProjects,
        refreshSessions,
      }}
    >
      {children}
    </StudioContext.Provider>
  );
}

export function useStudio(): StudioContextType {
  const context = useContext(StudioContext);
  if (!context) {
    throw new Error("useStudio must be used within a StudioProvider");
  }
  return context;
}
