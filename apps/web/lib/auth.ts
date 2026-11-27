import { useQuery } from "@tanstack/react-query";
import { apiGet } from "./api";

export type AuthConfig = {
  mode: "local" | "byok";
  llmConfigured: boolean;
  llmSource: "env" | "settings" | null;
  presets: { name: string; baseUrl: string }[];
};
export type Me = { mode: string; model: string | null; baseUrl: string | null };

export const CONFIG_KEY = ["auth", "config"] as const;
export const ME_KEY = ["auth", "me"] as const;

export function useAuthConfig() {
  return useQuery({ queryKey: CONFIG_KEY, queryFn: () => apiGet<AuthConfig>("/auth/config"), staleTime: 30_000 });
}

export function useMe(enabled: boolean) {
  return useQuery({ queryKey: ME_KEY, queryFn: () => apiGet<Me>("/auth/me"), enabled, retry: false });
}
