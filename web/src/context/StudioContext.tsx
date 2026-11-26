import React, { createContext, useCallback, useContext, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { projectsApi, sessionsApi, systemApi } from "../api";
import { queryKeys } from "../queries";
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
  /** Bind active project for cached session queries (no forced refetch if cache is fresh). */
  bindProjectSessions: (projectId: string) => void;
  refreshSessions: (projectId: string) => Promise<void>;
  resolveDefaultProjectId: () => string | undefined;
}

const StudioContext = createContext<StudioContextType | null>(null);

export function StudioProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const [activeSessionsProjectId, setActiveSessionsProjectId] = useState<string>("");
  const [showInspector, setShowInspector] = useState(false);

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects,
    queryFn: projectsApi.list,
    staleTime: 60_000,
  });

  const readyQuery = useQuery({
    queryKey: queryKeys.systemReady,
    queryFn: systemApi.checkReady,
    staleTime: 60_000,
  });

  const sessionsQuery = useQuery({
    queryKey: queryKeys.sessions(activeSessionsProjectId),
    queryFn: () => sessionsApi.list(activeSessionsProjectId),
    enabled: Boolean(activeSessionsProjectId),
  });

  const projects = projectsQuery.data ?? [];
  const projectsLoaded = !projectsQuery.isPending;
  const sessions = sessionsQuery.data ?? [];
  const isReady = readyQuery.data ?? false;

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
    await qc.invalidateQueries({ queryKey: queryKeys.projects });
  }, [qc]);

  const bindProjectSessions = useCallback((projectId: string) => {
    if (!projectId) return;
    setActiveSessionsProjectId(projectId);
  }, []);

  const refreshSessions = useCallback(
    async (projectId: string) => {
      if (!projectId) return;
      setActiveSessionsProjectId(projectId);
      await qc.invalidateQueries({ queryKey: queryKeys.sessions(projectId) });
    },
    [qc],
  );

  const setSessions: React.Dispatch<React.SetStateAction<SessionRoute[]>> = useCallback(
    (updater) => {
      if (!activeSessionsProjectId) return;
      qc.setQueryData<SessionRoute[]>(queryKeys.sessions(activeSessionsProjectId), (prev) => {
        const current = prev ?? [];
        return typeof updater === "function" ? updater(current) : updater;
      });
    },
    [activeSessionsProjectId, qc],
  );

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
        bindProjectSessions,
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
