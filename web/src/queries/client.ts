import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "../api";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Keep data fresh for 15s so back-navigation renders immediately with zero spinner flash.
      staleTime: 15_000,
      gcTime: 5 * 60_000,
      // Real-time updates arrive via SSE streams; disable noisy window-focus refetches.
      refetchOnWindowFocus: false,
      retry(failureCount, error) {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
          return false;
        }
        return failureCount < 1;
      },
    },
    mutations: {
      retry: false,
    },
  },
});
