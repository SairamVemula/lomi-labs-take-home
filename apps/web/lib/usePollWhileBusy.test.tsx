import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { DocumentSummary } from "@lomi/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POLL_MS, busyRefetchInterval, usePollWhileBusy } from "./usePollWhileBusy";

const doc = (status: DocumentSummary["status"], id: string = status): DocumentSummary => ({
  id,
  title: id,
  type: "invoice",
  status,
  currentVersion: 1,
  progress: { pending: 0, approved: 0, corrected: 0, carried_over: 0, total: 0 },
  latestError: null,
});

describe("busyRefetchInterval", () => {
  it("polls every 2s while any document is queued or extracting", () => {
    expect(POLL_MS).toBe(2000);
    expect(busyRefetchInterval([doc("extracted"), doc("queued")])).toBe(2000);
    expect(busyRefetchInterval([doc("extracting")])).toBe(2000);
  });

  it("stops when nothing is busy, or there is no data yet", () => {
    expect(busyRefetchInterval([doc("extracted"), doc("failed"), doc("superseded")])).toBe(false);
    expect(busyRefetchInterval([])).toBe(false);
    expect(busyRefetchInterval(undefined)).toBe(false);
  });
});

describe("usePollWhileBusy", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("refetches while busy and stops once settled", async () => {
    const responses = [[doc("queued")], [doc("extracted")]];
    const fetchMock = vi.fn(async () => {
      const body = responses.length > 1 ? responses.shift() : responses[0];
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => usePollWhileBusy(), { wrapper });
    await waitFor(() => expect(result.current.data?.[0]?.status).toBe("queued"));
    await waitFor(() => expect(result.current.data?.[0]?.status).toBe("extracted"), { timeout: 4000 });
    const calls = fetchMock.mock.calls.length;
    await new Promise((r) => setTimeout(r, 2500));
    expect(fetchMock.mock.calls.length).toBe(calls);
  }, 12000);
});
