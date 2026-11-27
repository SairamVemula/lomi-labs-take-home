"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ToastProvider } from "../components/Toast";
import { setUnauthorizedHandler } from "../lib/api";
import { CONFIG_KEY, type AuthConfig } from "../lib/auth";

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  const router = useRouter();
  const pathname = usePathname();
  const path = useRef(pathname);
  path.current = pathname;

  useEffect(() => {
    // In byok mode a 401 from any call means the session is gone: go sign in again.
    setUnauthorizedHandler(() => {
      const mode = client.getQueryData<AuthConfig>(CONFIG_KEY)?.mode;
      // Local mode has no sessions; if the mode is not known yet, /login sorts it out.
      if (mode !== "local" && path.current !== "/login") router.replace("/login");
    });
    return () => setUnauthorizedHandler(null);
  }, [client, router]);

  return (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}
