"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import type { DocumentSummary } from "@lomi/shared";
import { LlmBanner } from "../components/LlmBanner";
import { ProgressBar } from "../components/ProgressBar";
import { StatusBadge } from "../components/StatusBadge";
import { UploadDialog } from "../components/UploadDialog";
import { ApiError, apiPost } from "../lib/api";
import { useAuthConfig } from "../lib/auth";
import { linkClass, primaryButton } from "../lib/focus";
import { DOCUMENTS_KEY, usePollWhileBusy } from "../lib/usePollWhileBusy";

const TYPE_LABEL: Record<DocumentSummary["type"], string> = {
  invoice: "Invoice",
  lease: "Lease",
  market_report: "Market report",
};

function Title({ doc, className }: { doc: DocumentSummary; className: string }) {
  if (doc.status === "queued") return <span className={className}>{doc.title}</span>;
  return (
    <Link href={`/documents/${doc.id}`} className={`${className} ${linkClass} no-underline`}>
      {doc.title}
    </Link>
  );
}

function RetryButton({ id }: { id: string }) {
  const client = useQueryClient();
  const retry = useMutation({
    mutationFn: () => apiPost(`/documents/${id}/retry`),
    onSuccess: () => client.invalidateQueries({ queryKey: DOCUMENTS_KEY }),
  });
  return (
    <span className="inline-flex flex-col items-start gap-1 self-start">
      <button
        type="button"
        onClick={() => retry.mutate()}
        disabled={retry.isPending}
        className="inline-flex min-h-11 items-center rounded-md border border-border bg-surface-raised px-3 text-label font-medium text-ink hover:bg-border/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60 md:min-h-8"
      >
        {retry.isPending ? "Retrying…" : "Retry"}
      </button>
      {retry.error && <span className="text-caption text-failed">{retry.error.message}</span>}
    </span>
  );
}

function StatusCell({ doc }: { doc: DocumentSummary }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <StatusBadge status={doc.status} />
      {doc.status === "failed" && <RetryButton id={doc.id} />}
    </div>
  );
}

function progressCell(doc: DocumentSummary) {
  if (doc.status === "failed") return <span className="text-label text-ink-muted">—</span>;
  return <ProgressBar progress={doc.progress} />;
}

function DocumentTable({ docs }: { docs: DocumentSummary[] }) {
  return (
    <div className="hidden overflow-x-auto rounded-md border border-border bg-surface-raised md:block">
      <table className="w-full min-w-[760px] border-collapse text-body">
        <thead>
          <tr className="text-left text-label text-ink-muted">
            <th scope="col" className="border-b border-border px-4 py-3 font-medium">Document</th>
            <th scope="col" className="border-b border-border px-4 py-3 font-medium">Status</th>
            <th scope="col" className="border-b border-border px-4 py-3 font-medium">Version</th>
            <th scope="col" className="w-80 border-b border-border px-4 py-3 font-medium">Review progress</th>
          </tr>
        </thead>
        <tbody>
          {docs.map((doc) => (
            <tr key={doc.id} className="border-b border-border last:border-b-0">
              <td className="p-4">
                <Title doc={doc} className="font-medium" />
                <div className="text-label text-ink-muted">{TYPE_LABEL[doc.type]}</div>
              </td>
              <td className="p-4">
                <StatusCell doc={doc} />
              </td>
              <td className="p-4">v{doc.currentVersion}</td>
              <td className="p-4">{progressCell(doc)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DocumentCards({ docs }: { docs: DocumentSummary[] }) {
  return (
    <ul className="flex flex-col gap-4 md:hidden">
      {docs.map((doc) => (
        <li key={doc.id} className="flex flex-col gap-2 rounded-md border border-border bg-surface-raised p-4">
          <div className="flex items-start justify-between gap-2">
            <Title doc={doc} className="font-semibold" />
            <StatusBadge status={doc.status} />
          </div>
          <span className="text-label text-ink-muted">
            {TYPE_LABEL[doc.type]} · v{doc.currentVersion}
          </span>
          {doc.status === "failed" ? <RetryButton id={doc.id} /> : progressCell(doc)}
        </li>
      ))}
    </ul>
  );
}

export default function DocumentsPage() {
  const config = useAuthConfig();
  const docs = usePollWhileBusy();
  const [uploadOpen, setUploadOpen] = useState(false);

  const list = docs.data ?? [];
  const needReview = list.filter((d) => d.progress.pending > 0);
  const pendingTotal = needReview.reduce((n, d) => n + d.progress.pending, 0);
  const waiting = list.filter((d) => d.status === "failed" || d.status === "queued").length;
  const showBanner = config.data?.mode === "local" && !config.data.llmConfigured;
  const polling = list.some((d) => d.status === "queued" || d.status === "extracting");

  return (
    <main className="mx-auto flex max-w-[1120px] flex-col gap-6 px-4 py-6 md:px-6 md:py-8">
      {showBanner && <LlmBanner waiting={waiting} />}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-[28px] leading-[34px] font-semibold md:text-display">Documents</h1>
          <p className="text-ink-muted" aria-live="polite">
            {docs.isPending
              ? "Loading…"
              : pendingTotal > 0
                ? `${pendingTotal} ${pendingTotal === 1 ? "value needs" : "values need"} your review${
                    needReview.length > 1 ? ` across ${needReview.length} documents` : ""
                  }`
                : list.length > 0
                  ? "Nothing waiting for review"
                  : "No documents yet"}
          </p>
        </div>
        <button type="button" onClick={() => setUploadOpen(true)} className={`${primaryButton} w-full md:w-auto`}>
          Upload document
        </button>
      </div>

      {docs.isError && !(docs.error instanceof ApiError && docs.error.status === 401) && (
        <div role="alert" className="rounded-md bg-failed/15 p-3 text-label text-failed">
          {docs.error.message}
        </div>
      )}

      {list.length > 0 && (
        <>
          <DocumentTable docs={list} />
          <DocumentCards docs={list} />
        </>
      )}
      {docs.isSuccess && list.length === 0 && (
        <p className="rounded-md border border-border bg-surface-raised p-6 text-ink-muted">
          Upload a PDF to extract its values and review them against the source text.
        </p>
      )}
      {polling && (
        <p className="text-caption text-ink-muted">Status refreshes every 2 seconds while a document is queued or extracting.</p>
      )}
      <UploadDialog open={uploadOpen} onClose={() => setUploadOpen(false)} />
    </main>
  );
}
