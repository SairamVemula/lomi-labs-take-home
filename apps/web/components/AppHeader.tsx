"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiPost } from "../lib/api";
import { useAuthConfig, useMe } from "../lib/auth";
import { linkClass, secondaryButton } from "../lib/focus";

export function AppHeader() {
  const router = useRouter();
  const client = useQueryClient();
  const config = useAuthConfig();
  const mode = config.data?.mode;
  const me = useMe(mode === "local" || mode === "byok");

  async function signOut() {
    try {
      await apiPost("/auth/logout");
    } finally {
      client.clear();
      router.replace("/login");
    }
  }

  const fromEnv = config.data?.llmSource === "env";
  return (
    <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border bg-surface-raised px-4 py-3 md:px-6 md:py-4">
      <div className="flex items-center gap-3">
        <Link href="/" className={`text-[18px] font-semibold ${linkClass} text-ink hover:no-underline`}>
          Lomi Review
        </Link>
        {mode === "local" && (
          <span className="rounded-pill bg-ink-muted/15 px-2 py-0.5 text-caption text-ink-muted">Local mode</span>
        )}
      </div>
      <div className="flex items-center gap-3 text-label text-ink-muted">
        {mode === "local" && me.data?.model && (
          <span>
            {me.data.model}
            {fromEnv ? " · from .env" : ""}
          </span>
        )}
        {mode === "local" && !fromEnv && (
          <Link href="/settings" className={`inline-flex min-h-11 items-center ${linkClass}`}>
            LLM settings
          </Link>
        )}
        {mode === "byok" && me.data && (
          <>
            {me.data.model && <span>{me.data.model}</span>}
            <button type="button" onClick={signOut} className={secondaryButton}>
              Sign out
            </button>
          </>
        )}
      </div>
    </header>
  );
}
