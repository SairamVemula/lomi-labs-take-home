"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { LlmForm, type LlmValues } from "../../components/LlmForm";
import { apiPost } from "../../lib/api";
import { providerError } from "../../lib/provider-error";
import { useAuthConfig } from "../../lib/auth";

export default function LoginPage() {
  const router = useRouter();
  const client = useQueryClient();
  const config = useAuthConfig();

  useEffect(() => {
    if (config.data?.mode === "local") router.replace("/");
  }, [config.data?.mode, router]);

  const login = useMutation({
    mutationFn: (v: LlmValues) => apiPost("/auth/login", v),
    onSuccess: async () => {
      client.removeQueries({ queryKey: ["documents"] });
      await client.invalidateQueries({ queryKey: ["auth"] });
      router.replace("/");
    },
  });

  if (config.isError) {
    return (
      <p role="alert" className="p-6 text-failed">
        Could not reach the server. Reload to try again.
      </p>
    );
  }
  if (!config.data || config.data.mode === "local") {
    return <p className="p-6 text-ink-muted">Loading…</p>;
  }

  const error = providerError(login.error, "Could not sign in.");

  return (
    <main className="flex flex-wrap items-start justify-center gap-12 px-4 py-10 md:py-16">
      <section className="flex max-w-[420px] flex-[1_1_360px] flex-col gap-4 pt-2">
        <h1 className="text-[28px] leading-[34px] font-semibold md:text-display">
          Review LLM-extracted values against their source
        </h1>
        <p className="text-ink-muted">
          Sign in with your own OpenAI-compatible API key. Your workspace starts with three sample documents, extracted
          with your key — it costs well under a cent.
        </p>
        <ul className="flex list-disc flex-col gap-1.5 pl-5">
          <li>Every value is shown beside the exact quote it came from</li>
          <li>Upload a revised PDF and only changed values come back for review</li>
          <li>The same key and endpoint bring back the same workspace</li>
        </ul>
      </section>
      <div className="flex max-w-[440px] flex-[1_1_360px] flex-col gap-4 rounded-md border border-border bg-surface-raised p-6">
        <h2 className="text-title font-semibold">Sign in</h2>
        <LlmForm
          idPrefix="login"
          presets={config.data.presets}
          submitLabel="Sign in"
          pendingLabel="Signing in…"
          error={error}
          pending={login.isPending}
          onSubmit={(v) => login.mutate(v)}
          note="Your key is encrypted and only used for your extractions. It is never shown again, and signing out deletes it."
        />
      </div>
    </main>
  );
}
