"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useRef, useState } from "react";
import { EXPECTED_FIELDS, type DocumentDetail, type ReviewRequest } from "@lomi/shared";
import { HistoryTable } from "../../../components/HistoryTable";
import { EvidenceText } from "../../../components/EvidenceText";
import { ProgressBar } from "../../../components/ProgressBar";
import { StatusBadge } from "../../../components/StatusBadge";
import { useToast } from "../../../components/Toast";
import { ValueRow } from "../../../components/ValueRow";
import { VersionSwitcher } from "../../../components/VersionSwitcher";
import { ApiError, apiGet, apiPost, apiUpload } from "../../../lib/api";
import { linkClass, primaryButton, secondaryButton } from "../../../lib/focus";
import { groupValues, headline, isPending, progressOf, subline, type GroupKey } from "../../../lib/review";
import { DOCUMENTS_KEY, detailRefetchInterval, documentKey } from "../../../lib/usePollWhileBusy";

const GROUP_STYLE: Record<GroupKey, { label: string; cls: string }> = {
  pending: { label: "Needs review", cls: "text-pending" },
  carried: { label: "Carried over", cls: "text-carried" },
  reviewed: { label: "Reviewed", cls: "text-ink-muted" },
};

function useDocument(id: string, version: number | null) {
  return useQuery({
    queryKey: [...documentKey(id), version],
    queryFn: () => apiGet<DocumentDetail>(`/documents/${id}${version ? `?version=${version}` : ""}`),
    refetchInterval: (q) => detailRefetchInterval(q.state.data),
  });
}

function useInvalidate(id: string) {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: documentKey(id) }),
      client.invalidateQueries({ queryKey: DOCUMENTS_KEY }),
    ]);
}

function UploadVersionButton({ id }: { id: string }) {
  const input = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const invalidate = useInvalidate(id);
  const upload = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.set("file", file);
      return apiUpload(`/documents/${id}/versions`, form);
    },
    onSuccess: async () => {
      await invalidate();
      toast("Uploaded — extraction started");
    },
  });
  return (
    <span className="flex flex-col gap-1 max-md:w-full">
      <input
        ref={input}
        type="file"
        accept="application/pdf,.pdf"
        aria-label="New version PDF"
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) upload.mutate(file);
          e.target.value = "";
        }}
      />
      <button type="button" disabled={upload.isPending} onClick={() => input.current?.click()} className={`${secondaryButton} max-md:w-full`}>
        {upload.isPending ? "Uploading…" : "Upload new version"}
      </button>
      {upload.error && (
        <span role="alert" className="text-caption text-failed">
          {upload.error.message}
        </span>
      )}
    </span>
  );
}

function RetryButton({ id }: { id: string }) {
  const invalidate = useInvalidate(id);
  const retry = useMutation({ mutationFn: () => apiPost(`/documents/${id}/retry`), onSuccess: invalidate });
  return (
    <span className="flex flex-col gap-1 self-start max-md:w-full">
      <button type="button" disabled={retry.isPending} onClick={() => retry.mutate()} className={`${primaryButton} max-md:w-full`}>
        {retry.isPending ? "Retrying…" : "Retry extraction"}
      </button>
      {retry.error && (
        <span role="alert" className="text-caption text-failed">
          {retry.error.message}
        </span>
      )}
    </span>
  );
}

function Skeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-14 animate-pulse rounded-md bg-border/60" />
      ))}
    </div>
  );
}

function DocumentView() {
  const { id } = useParams<{ id: string }>();
  const search = useSearchParams();
  const requested = Number(search.get("version"));
  const version = Number.isInteger(requested) && requested > 0 ? requested : null;
  const doc = useDocument(id, version);
  const invalidate = useInvalidate(id);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [scrollKey, setScrollKey] = useState(0);

  const review = useMutation({
    mutationFn: ({ valueId, body }: { valueId: string; body: ReviewRequest }) =>
      apiPost(`/values/${valueId}/review`, body),
    // Refresh on success and on failure (a 409 VALUE_NOT_CURRENT means the page is stale).
    onSettled: invalidate,
  });

  if (doc.isPending) return <Shell>Loading…</Shell>;
  if (doc.isError) {
    const notFound = doc.error instanceof ApiError && doc.error.status === 404;
    return (
      <Shell>
        <p role="alert" className="rounded-md bg-failed/15 p-3 text-label text-failed">
          {notFound ? "Document not found." : doc.error.message}
        </p>
      </Shell>
    );
  }

  const d = doc.data;
  const viewing = d.versions.find((v) => v.number === d.viewingVersion);
  const historical = d.viewingVersion !== d.currentVersion;
  const grouped = groupValues(d.values);
  const busy = d.latestRun?.status === "queued" || d.latestRun?.status === "extracting";
  const failed = !historical && d.status === "failed";
  const showValues = d.values.length > 0 && !busy && !failed;

  // Selected row wins, then the hovered one, then the first pending value.
  const selectedValid = selectedId !== null && d.values.some((v) => v.id === selectedId) ? selectedId : null;
  const shownId = selectedValid ?? hoverId ?? d.values.find(isPending)?.id ?? null;
  const active = d.values.find((v) => v.id === shownId) ?? null;
  const highlight =
    active && active.evidenceStart !== null && active.evidenceEnd !== null
      ? { start: active.evidenceStart, end: active.evidenceEnd }
      : null;

  const onReview = (valueId: string, body: ReviewRequest) => review.mutateAsync({ valueId, body });
  const rows = (values: typeof d.values) =>
    values.map((v) => (
      <ValueRow
        key={v.id}
        value={v}
        version={d.viewingVersion}
        selected={v.id === selectedValid}
        readOnly={historical}
        onSelect={(vid) => {
          setSelectedId(vid);
          setScrollKey((k) => k + 1);
        }}
        onHover={setHoverId}
        onReview={onReview}
      />
    ));

  const pdfLink = viewing && (
    <a
      href={viewing.fileUrl}
      target="_blank"
      rel="noopener"
      className={`inline-flex min-h-11 items-center px-1 text-label ${linkClass} no-underline max-md:justify-center max-md:text-body`}
    >
      {historical ? `Open PDF (v${viewing.number})` : "Open PDF"}
    </a>
  );
  const textTitle = `Document text · version ${d.viewingVersion}`;

  return (
    <Shell>
      {historical && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-border/30 px-4 py-3"
        >
          <span className="text-body">
            <strong className="font-semibold">{`You’re viewing version ${d.viewingVersion}.`}</strong>{" "}
            {`It was superseded by version ${d.currentVersion}. Its values and reviews are kept read-only.`}
          </span>
          <Link href={`/documents/${d.id}`} className={`${primaryButton} no-underline max-md:w-full`}>
            Go to current version
          </Link>
        </div>
      )}

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[17px] leading-6 font-semibold md:text-title">{d.title}</h1>
            <StatusBadge status={historical ? "superseded" : d.status} />
          </div>
          {!historical && !busy && !failed && (
            <>
              <p aria-live="polite" className="text-[26px] leading-8 font-semibold md:text-display">
                {headline(grouped.pendingCount)}
              </p>
              {subline(d.values, d.viewingVersion) && (
                <p className="text-body text-ink-muted">{subline(d.values, d.viewingVersion)}</p>
              )}
            </>
          )}
          {!historical && d.versions.length < 2 && viewing && (
            <div className="flex flex-wrap items-center gap-4 text-label text-ink-muted">
              <span>{`Version ${viewing.number} · ${viewing.originalFilename}`}</span>
              {pdfLink}
            </div>
          )}
        </div>
        <div className="flex w-full flex-col gap-2 md:w-auto md:flex-row md:flex-wrap md:items-center">
          <VersionSwitcher detail={d} />
          {(historical || d.versions.length > 1) && pdfLink}
          {!historical && <UploadVersionButton id={d.id} />}
        </div>
      </div>

      {busy && !historical && (
        <section aria-label="Extracting" className="flex flex-col gap-4 rounded-md border border-border bg-surface-raised p-6">
          <p className="text-body">
            {`Reading version ${d.viewingVersion} and extracting ${EXPECTED_FIELDS[d.type].length} fields. Values appear here when it finishes — usually under a minute.`}
          </p>
          <Skeleton />
          <p className="text-label text-ink-muted">
            Uploading another version now replaces this one — the newest version is always the one you review.
          </p>
        </section>
      )}

      {failed && (
        <section aria-label="Failed" className="flex flex-col gap-4">
          <div role="alert" className="flex flex-col gap-2 rounded-md bg-failed/15 px-4 py-3">
            <strong className="text-body font-semibold text-failed">
              {d.latestRun && d.latestRun.attempt > 1
                ? `Extraction failed after ${d.latestRun.attempt} attempts`
                : "Extraction failed"}
            </strong>
            <span className="text-label text-ink">{d.latestRun?.error ?? "No error details were recorded."}</span>
          </div>
          <RetryButton id={d.id} />
        </section>
      )}

      {showValues && (
        <>
          {!historical && (
            <div className="max-w-[560px]">
              <ProgressBar progress={progressOf(d.values)} />
            </div>
          )}
          {historical && (
            <>
              <HistoryTable values={d.values} version={d.viewingVersion} />
              <div className="flex flex-col gap-3 md:hidden">{rows(grouped.ordered)}</div>
              <p className="text-label text-ink-muted">
                {`Evidence on this page is checked against version ${d.viewingVersion}’s own text, even after version ${d.currentVersion} exists. Review actions are off for historical versions.`}
              </p>
            </>
          )}
          {!historical && (
            <div className="flex flex-wrap items-start gap-6">
              <section aria-label="Extracted values" className="flex min-w-0 flex-[999_1_560px] flex-col gap-3">
                {grouped.grouped
                  ? grouped.groups.map((g) => (
                      <div key={g.key} className="flex flex-col gap-3">
                        <h2 className={`mt-2 text-label font-semibold ${GROUP_STYLE[g.key].cls}`}>
                          {`${GROUP_STYLE[g.key].label} · ${g.values.length}`}
                        </h2>
                        {rows(g.values)}
                      </div>
                    ))
                  : rows(grouped.ordered)}
              </section>
              <aside
                aria-label={`Document text, version ${d.viewingVersion}`}
                className="hidden min-w-0 flex-[1_1_400px] flex-col gap-2 md:sticky md:top-4 md:flex"
              >
                <h2 className="text-label font-medium text-ink-muted">{textTitle}</h2>
                <EvidenceText text={d.parsedText} highlight={highlight} scrollKey={scrollKey} />
              </aside>
              <details className="w-full rounded-md border border-border bg-surface-raised md:hidden">
                <summary className="flex min-h-11 cursor-pointer items-center px-4 text-body font-medium">{textTitle}</summary>
                <div className="p-2">
                  <EvidenceText text={d.parsedText} highlight={highlight} scrollKey={scrollKey} />
                </div>
              </details>
            </div>
          )}
        </>
      )}

      {!busy && !failed && d.values.length === 0 && (
        <p className="rounded-md border border-border bg-surface-raised p-6 text-ink-muted">
          No values were extracted for this version.
        </p>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex max-w-[1280px] flex-col gap-6 px-4 py-6 md:px-6">
      <Link href="/" className={`self-start text-label ${linkClass} no-underline`}>
        ← All documents
      </Link>
      {children}
    </main>
  );
}

export default function DocumentPage() {
  return (
    <Suspense fallback={null}>
      <DocumentView />
    </Suspense>
  );
}
