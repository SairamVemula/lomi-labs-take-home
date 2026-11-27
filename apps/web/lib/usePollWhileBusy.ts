import { useQuery } from "@tanstack/react-query";
import type { DocumentSummary } from "@lomi/shared";
import { apiGet } from "./api";

export const POLL_MS = 2000;
export const DOCUMENTS_KEY = ["documents"] as const;

/** Poll while any document is still being worked on; stop once everything settled. */
export function busyRefetchInterval(docs: DocumentSummary[] | undefined): number | false {
  return docs?.some((d) => d.status === "queued" || d.status === "extracting") ? POLL_MS : false;
}

export function usePollWhileBusy() {
  return useQuery({
    queryKey: DOCUMENTS_KEY,
    queryFn: () => apiGet<DocumentSummary[]>("/documents"),
    refetchInterval: (query) => busyRefetchInterval(query.state.data),
  });
}
