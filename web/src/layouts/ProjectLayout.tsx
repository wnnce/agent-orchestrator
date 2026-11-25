import React, { useEffect, useMemo } from "react";
import { AnimatePresence, m } from "motion/react";
import { useLocation, useMatches, useOutlet, useOutletContext, useParams } from "react-router";
import { ActivityBar } from "../components/studio/ActivityBar";
import { StudioHeader } from "../components/studio/StudioHeader";
import { NotFoundView } from "../components/views/NotFoundView";
import { useStudio } from "../context/StudioContext";
import type { ProjectRouting, StudioView } from "../types";
import { EASE_OUT_EXPO } from "../utils/motion";

export interface RouteHandle {
  nav: StudioView;
  title: string;
  transitionKey?: string;
}

export interface ProjectRouteContext {
  project: ProjectRouting;
}

export function useCurrentRouteHandle(): RouteHandle | undefined {
  const matches = useMatches();
  for (let i = matches.length - 1; i >= 0; i--) {
    const handle = matches[i]?.handle as RouteHandle | undefined;
    if (handle?.nav) return handle;
  }
  return undefined;
}

export function useCurrentProject(): ProjectRouting {
  return useOutletContext<ProjectRouteContext>().project;
}

function AnimatedOutlet({ project }: { project: ProjectRouting }) {
  const location = useLocation();
  const outlet = useOutlet({ project } satisfies ProjectRouteContext);
  const handle = useCurrentRouteHandle();

  const transitionKey = handle?.transitionKey
    ? `${project.projectId}:${handle.transitionKey}`
    : location.pathname;

  return (
    <AnimatePresence mode="wait" initial={false}>
      <m.div
        key={transitionKey}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -5 }}
        transition={{ duration: 0.16, ease: EASE_OUT_EXPO }}
        className="flex-1 flex overflow-hidden min-w-0"
      >
        {outlet}
      </m.div>
    </AnimatePresence>
  );
}

export function ProjectLayout() {
  const { projectId } = useParams<{ projectId: string }>();
  const { projects, projectsLoaded, refreshSessions } = useStudio();

  const project = useMemo(
    () => projects.find((p) => p.projectId === projectId) ?? null,
    [projects, projectId],
  );

  useEffect(() => {
    if (!project) return;
    try {
      localStorage.setItem("last_active_project", project.projectId);
    } catch {
      /* ignore */
    }
    refreshSessions(project.projectId);
  }, [project, refreshSessions]);

  if (!projectsLoaded) {
    return <div className="h-screen w-screen bg-[var(--bg-canvas)]" />;
  }

  if (!project) {
    return <NotFoundView />;
  }

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[var(--bg-canvas)] text-[var(--text-primary)] font-sans select-none">
      <StudioHeader project={project} />

      <div className="flex flex-1 min-h-0 overflow-hidden">
        <ActivityBar projectId={project.projectId} />

        <main className="flex-1 flex overflow-hidden min-w-0 relative">
          <AnimatedOutlet project={project} />
        </main>
      </div>
    </div>
  );
}
