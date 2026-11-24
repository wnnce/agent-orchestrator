import React from "react";
import { LazyMotion, MotionConfig, domAnimation, m } from "motion/react";
import { Toaster } from "sonner";
import { Switch, Route, Redirect } from "wouter";
import { ActivityBar } from "./components/studio/ActivityBar";
import { StudioHeader } from "./components/studio/StudioHeader";
import { ProjectInfoView } from "./components/views/ProjectInfoView";
import { SessionsView } from "./components/views/SessionsView";
import { TasksView } from "./components/views/TasksView";
import { ScheduledJobsView } from "./components/views/ScheduledJobsView";
import { StudioProvider, useStudio } from "./context/StudioContext";
import { ThemeProvider, useTheme } from "./context/ThemeContext";
import { ConfirmProvider } from "./context/ConfirmContext";
import { EASE_OUT_EXPO } from "./utils/motion";

function StudioLayout() {
  const { activeProjectId, activeView, activeSessionId } = useStudio();
  const { theme } = useTheme();
  const viewKey = `${activeProjectId ?? ""}:${activeView}:${activeSessionId ?? ""}`;

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[var(--bg-canvas)] text-[var(--text-primary)] font-sans select-none">
      {/* 1. Full-Width Top Studio Header (Banner spanning entire top) */}
      <StudioHeader />

      {/* 2. Studio Body Below Top Header */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left Activity Bar Below Header */}
        <ActivityBar />

        {/* Declarative Path-Based Router */}
        <main className="flex-1 flex overflow-hidden min-w-0">
          <m.div
            key={viewKey}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.16, ease: EASE_OUT_EXPO }}
            className="flex-1 flex overflow-hidden min-w-0"
          >
            <Switch>
              <Route path="/:projectId/sessions/:sessionId" component={SessionsView} />
              <Route path="/:projectId/sessions" component={SessionsView} />
              <Route path="/:projectId/tasks" component={TasksView} />
              <Route path="/:projectId/jobs" component={ScheduledJobsView} />
              <Route path="/:projectId/project" component={ProjectInfoView} />
              <Route path="/:projectId/overview" component={ProjectInfoView} />
              <Route path="/:projectId" component={SessionsView} />
              <Route path="*">
                {activeProjectId ? (
                  <Redirect to={`/${activeProjectId}/sessions`} replace />
                ) : null}
              </Route>
            </Switch>
          </m.div>
        </main>
      </div>

      {/* 3. Global Toast Notifications (Vercel Flat Style via Sonner) */}
      <Toaster
        theme={theme === "dark" ? "dark" : "light"}
        position="top-right"
        offset="60px"
        richColors
        closeButton
        style={{ zIndex: 99999 }}
        toastOptions={{
          style: {
            borderRadius: "var(--radius-md, 6px)",
            fontFamily: "inherit",
            fontSize: "12px",
          },
        }}
      />
    </div>
  );
}

export function App() {
  return (
    <MotionConfig reducedMotion="user">
      <LazyMotion features={domAnimation} strict>
        <ThemeProvider>
          <ConfirmProvider>
            <StudioProvider>
              <StudioLayout />
            </StudioProvider>
          </ConfirmProvider>
        </ThemeProvider>
      </LazyMotion>
    </MotionConfig>
  );
}

export default App;
