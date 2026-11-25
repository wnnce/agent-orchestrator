import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { projectsApi, sessionsApi, systemApi } from "../api";
import type { ProjectRouting, SessionRoute } from "../types";

interface StudioContextType {
  projects: ProjectRouting[];
  projectsLoaded: boolean;
  sessions: SessionRoute[];
  setSessions: React.Dispatch<React.SetStateAction<SessionRoute[]>>;
  isReady: boolean;
  showInspector: boolean;
  setShowInspector: (show: boolean) => void;
  toggleInspector: () => void;
  refreshProjects: () => Promise<void>;
  refreshSessions: (projectId: string) => Promise<void>;
  resolveDefaultProjectId: () => string | undefined;
}

const StudioContext = createContext<StudioContextType | null>(null);

export function StudioProvider({ children }: { children: React.ReactNode }) {
  const [projects, setProjects] = useState<ProjectRouting[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [sessions, setSessions] = useState<SessionRoute[]>([]);
  const [isReady, setIsReady] = useState(false);
  const [showInspector, setShowInspector] = useState(false);

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

  const refreshSessions = useCallback(async (projectId: string) => {
    if (!projectId) return;
    try {
      const list = await sessionsApi.list(projectId);
      setSessions(list);
    } catch (err) {
      console.error("Failed to load sessions:", err);
    }
  }, []);

  useEffect(() => {
    systemApi.checkReady().then(setIsReady);
    refreshProjects();
  }, [refreshProjects]);

  const toggleInspector = useCallback(() => setShowInspector((prev) => !prev), []);

  return (
    <StudioContext.Provider
      value={{
        projects,
        projectsLoaded,
        sessions,
        setSessions,
        isReady,
        showInspector,
        setShowInspector,
        toggleInspector,
        refreshProjects,
        refreshSessions,
        resolveDefaultProjectId,
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
