import React, { useMemo } from "react";
import { LazyMotion, MotionConfig, domAnimation } from "motion/react";
import { RouterProvider } from "react-router";
import { Toaster } from "sonner";
import { ConfirmProvider } from "./context/ConfirmContext";
import { StudioProvider } from "./context/StudioContext";
import { ThemeProvider, useTheme } from "./context/ThemeContext";
import { createAppRouter } from "./router";

function AppShell() {
  const { theme } = useTheme();
  const router = useMemo(() => createAppRouter(), []);

  return (
    <>
      <RouterProvider router={router} />
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
    </>
  );
}

export function App() {
  return (
    <MotionConfig reducedMotion="user">
      <LazyMotion features={domAnimation} strict>
        <ThemeProvider>
          <ConfirmProvider>
            <StudioProvider>
              <AppShell />
            </StudioProvider>
          </ConfirmProvider>
        </ThemeProvider>
      </LazyMotion>
    </MotionConfig>
  );
}

export default App;
