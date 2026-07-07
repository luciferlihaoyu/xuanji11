import { createTRPCReact } from "@trpc/react-query";
import { httpBatchLink } from "@trpc/client";
import { QueryClient, QueryClientProvider, MutationCache } from "@tanstack/react-query";
import superjson from "superjson";
import type { AppRouter } from "../../api/router";
import type { ReactNode } from "react";

export const trpc = createTRPCReact<AppRouter>();

const LOGIN_PATH = "/login";

function isUnauthorizedError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as Record<string, unknown>;
  if (e.data && typeof e.data === "object") {
    const data = e.data as Record<string, unknown>;
    return data.code === "UNAUTHORIZED";
  }
  // Also check message-based detection
  if (e.message === "UNAUTHORIZED") return true;
  return false;
}

function handleTrpcError(error: unknown) {
  if (isUnauthorizedError(error)) {
    // 避免在登录页无限重定向
    if (window.location.pathname !== LOGIN_PATH) {
      window.location.href = LOGIN_PATH;
    }
  }
}

const mutationCache = new MutationCache({
  onError: (error) => {
    handleTrpcError(error);
  },
});

const queryClient = new QueryClient({
  mutationCache,
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        if (isUnauthorizedError(error)) {
          handleTrpcError(error);
          return false;
        }
        return failureCount < 3;
      },
    },
    mutations: {
      retry: false,
    },
  },
});

export const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      headers: { "X-Requested-With": "XMLHttpRequest" },
      fetch(input, init) {
        return globalThis.fetch(input, {
          ...(init ?? {}),
          credentials: "include",
        });
      },
    }),
  ],
});

export function TRPCProvider({ children }: { children: ReactNode }) {
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </trpc.Provider>
  );
}
