"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { LlmForm, type LlmValues } from "../../components/LlmForm";
import { useToast } from "../../components/Toast";
import { ApiError, apiPut } from "../../lib/api";
import { useAuthConfig } from "../../lib/auth";
import { linkClass } from "../../lib/focus";

export default function SettingsPage() {
  const router = useRouter();
  const client = useQueryClient();
  const toast = useToast();
  const config = useAuthConfig();

  useEffect(() => {
    if (config.data?.mode === "byok") router.replace("/");
  }, [config.data?.mode, router]);

  const save = useMutation({
    mutationFn: (v: LlmValues) => apiPut<{ llmConfigured: true; retried: number }>("/settings/llm", v),
    onSuccess: async ({ retried }) => {
      toast(`Saved — retrying ${retried} ${retried === 1 ? "document" : "documents"}`);
      await client.invalidateQueries();
      router.push("/");
    },
  });

  if (!config.data || config.data.mode === "byok") return <p className="p-6 text-ink-muted">Loading…</p>;

  const err = save.error;
  const error = err
    ? {
        title: err instanceof ApiError && err.code === "PROVIDER_REJECTED" ? "The provider rejected this key." : "Could not save.",
        detail: err.message,
      }
    : null;

  return (
    <main className="mx-auto flex max-w-[560px] flex-col gap-6 px-4 py-8 md:px-6 md:py-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-[28px] leading-[34px] font-semibold md:text-display">LLM settings</h1>
        <Link href="/" className={`inline-flex min-h-11 items-center self-start ${linkClass}`}>
          ← Back to documents
        </Link>
      </div>
      {config.data.llmSource === "env" ? (
        <div role="status" className="rounded-md border border-border bg-surface-raised p-4 text-ink-muted">
          The LLM is configured through the environment (<span className="font-mono text-evidence">LLM_*</span> in .env) and
          cannot be changed here.
        </div>
      ) : (
        <div className="flex flex-col gap-4 rounded-md border border-border bg-surface-raised p-6">
          <LlmForm
            idPrefix="settings"
            presets={config.data.presets}
            submitLabel="Save and retry failed documents"
            pendingLabel="Checking the key…"
            error={error}
            pending={save.isPending}
            onSubmit={(v) => save.mutate(v)}
          />
        </div>
      )}
    </main>
  );
}
