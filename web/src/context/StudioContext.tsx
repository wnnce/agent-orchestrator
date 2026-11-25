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
import { parseStudioLocation } from "../utils/routing";

interface StudioContextType {
  activeView: StudioView;
  setActiveView: (view: StudioView) => void;
  isNotFound: boolean;
  goHome: () => void;
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
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [sessions, setSessions] = useState<SessionRoute[]>([]);
  const [isReady, setIsReady] = useState(false);
  const [showInspector, setShowInspector] = useState(false);

  const parsedRoute = useMemo(() => parseStudioLocation(location), [location]);
  const {
    projectId: activeProjectId,
    view: activeView,
    sessionId: activeSessionId,
    taskId: activeTaskId,
    executionId: activeExecutionId,
  } = parsedRoute;

  const activeProject = useMemo(() => {
    return projects.find((p) => p.projectId === activeProjectId) || null;
  }, [projects, activeProjectId]);

  const isNotFound =
    !parsedRoute.matched || (projectsLoaded && Boolean(activeProjectId) && !activeProject);

  const resolveDefaultProjectId = useCallback((): string | undefined => {
    try {
      const stored = localStorage.getItem("last_active_project");
      if (stored && projects.some((p) => p.projectId === stored)) {
        return stored;
      }
    } catch {
      /* ignore */
    }
    return projects[0]?.projectId;
  }, [projects]);

  // Load project list
  const refreshProjects = useCallback(async () => {
    try {
      const list = await projectsApi.list();
      setProjects(list);
    } catch (err) {
      console.error("Failed to load projects:", err);
    } finally {
      setProjectsLoaded(true);
    }
  }, []);

  // Load session list for active project
  const refreshSessions = useCallback(async () => {
    if (!activeProjectId || (projectsLoaded && !activeProject)) return;
    try {
      const list = await sessionsApi.list(activeProjectId);
      setSessions(list);
    } catch (err) {
      console.error("Failed to load sessions:", err);
    }
  }, [activeProjectId, projectsLoaded, activeProject]);

  // Initial ready check and projects fetch
  useEffect(() => {
    systemApi.checkReady().then(setIsReady);

    refreshProjects();
  }, [refreshProjects]);

  // Refresh sessions when a valid activeProjectId is selected
  useEffect(() => {
    if (activeProjectId && (!projectsLoaded || activeProject)) {
      refreshSessions();
    }
  }, [activeProjectId, projectsLoaded, activeProject, refreshSessions]);

  // Persist last visited valid project; redirect ONLY root "/" to default project
  useEffect(() => {
    if (projects.length === 0) return;

    if (activeProject) {
      try {
        localStorage.setItem("last_active_project", activeProject.projectId);
      } catch {
        /* ignore */
      }
      return;
    }

    if (!parsedRoute.isRoot) return;

    const targetProject = resolveDefaultProjectId();
    if (targetProject) {
      navigate(`/${encodeURIComponent(targetProject)}/sessions`, { replace: true });
    }
  }, [projects, activeProject, parsedRoute.isRoot, resolveDefaultProjectId, navigate]);

  const activeSession = useMemo(() => {
    return sessions.find((s) => s.sessionId === activeSessionId) || null;
  }, [sessions, activeSessionId]);

  const getValidProjectId = useCallback(() => {
    return activeProject?.projectId || resolveDefaultProjectId() || "default";
  }, [activeProject, resolveDefaultProjectId]);

  const goHome = useCallback(() => {
    const targetProject = resolveDefaultProjectId();
    if (targetProject) {
      navigate(`/${encodeURIComponent(targetProject)}/sessions`);
    } else {
      navigate("/");
    }
  }, [resolveDefaultProjectId, navigate]);

  // Navigation handlers (drive the browser URL)
  const setActiveView = useCallback(
    (view: StudioView) => {
      const targetProj = getValidProjectId();
      navigate(`/${encodeURIComponent(targetProj)}/${view}`);
    },
    [getValidProjectId, navigate],
  );

  const setActiveProjectId = useCallback(
    (id: string | null) => {
      if (!id) return;
      try {
        localStorage.setItem("last_active_project", id);
      } catch {
        /* ignore */
      }
      navigate(`/${encodeURIComponent(id)}/${isNotFound ? "sessions" : activeView}`);
    },
    [activeView, isNotFound, navigate],
  );

  const setActiveSessionId = useCallback(
    (id: string | null) => {
      const targetProj = getValidProjectId();
      if (id) {
        navigate(`/${encodeURIComponent(targetProj)}/sessions/${encodeURIComponent(id)}`);
      } else {
        navigate(`/${encodeURIComponent(targetProj)}/sessions`);
      }
    },
    [getValidProjectId, navigate],
  );

  const openSession = useCallback(
    (sessionId: string) => {
      const targetProj = getValidProjectId();
      navigate(`/${encodeURIComponent(targetProj)}/sessions/${encodeURIComponent(sessionId)}`);
    },
    [getValidProjectId, navigate],
  );

  const closeToBoard = useCallback(() => {
    const targetProj = getValidProjectId();
    navigate(`/${encodeURIComponent(targetProj)}/sessions`);
  }, [getValidProjectId, navigate]);

  const openTask = useCallback(
    (taskId: string, executionId?: string | null) => {
      const targetProj = getValidProjectId();
      const base = `/${encodeURIComponent(targetProj)}/tasks/${encodeURIComponent(taskId)}`;
      navigate(executionId ? `${base}/${encodeURIComponent(executionId)}` : base);
    },
    [getValidProjectId, navigate],
  );

  const closeToTasks = useCallback(() => {
    const targetProj = getValidProjectId();
    navigate(`/${encodeURIComponent(targetProj)}/tasks`);
  }, [getValidProjectId, navigate]);

  const toggleInspector = useCallback(() => setShowInspector((prev) => !prev), []);

  return (
    <StudioContext.Provider
      value={{
        activeView,
        setActiveView,
        isNotFound,
        goHome,
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
