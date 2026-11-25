import React from "react";
import { AnimatePresence, LazyMotion, MotionConfig, domAnimation, m } from "motion/react";
import { Toaster } from "sonner";
import { ActivityBar } from "./components/studio/ActivityBar";
import { StudioHeader } from "./components/studio/StudioHeader";
import { NotFoundView } from "./components/views/NotFoundView";
import { ProjectInfoView } from "./components/views/ProjectInfoView";
import { ScheduledJobsView } from "./components/views/ScheduledJobsView";
import { SessionsView } from "./components/views/SessionsView";
import { TasksView } from "./components/views/TasksView";
import { ConfirmProvider } from "./context/ConfirmContext";
import { StudioProvider, useStudio } from "./context/StudioContext";
import { ThemeProvider, useTheme } from "./context/ThemeContext";
import type { StudioView } from "./types";
import { EASE_OUT_EXPO } from "./utils/motion";

function ViewOutlet({ view }: { view: StudioView }) {
  switch (view) {
    case "project":
      return <ProjectInfoView />;
    case "tasks":
      return <TasksView />;
    case "jobs":
      return <ScheduledJobsView />;
    case "sessions":
    default:
      return <SessionsView />;
  }
}

function StudioLayout() {
  const { activeProjectId, activeView, activeSessionId, isNotFound } = useStudio();
  const { theme } = useTheme();
  // Keep Task Studio's left explorer mounted across task/run switches;
  // animate top-level view switches and SessionBoard <-> SessionConversation transitions.
  const viewKey = `${activeProjectId ?? ""}:${activeView}:${activeSessionId ?? ""}`;

  if (isNotFound) {
    return <NotFoundView />;
  }

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[var(--bg-canvas)] text-[var(--text-primary)] font-sans select-none">
      {/* 1. Full-Width Top Studio Header */}
      <StudioHeader />

      {/* 2. Studio Body Below Top Header */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left Activity Bar Below Header */}
        <ActivityBar />

        {/* Animated Main Studio Canvas */}
        <main className="flex-1 flex overflow-hidden min-w-0 relative">
          <AnimatePresence mode="wait" initial={false}>
            <m.div
              key={viewKey}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -5 }}
              transition={{ duration: 0.16, ease: EASE_OUT_EXPO }}
              className="flex-1 flex overflow-hidden min-w-0"
            >
              <ViewOutlet view={activeView} />
            </m.div>
          </AnimatePresence>
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
