import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiGet, apiPost, apiUpload, setUnauthorizedHandler } from "./api";

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthorizedHandler(null);
});

describe("api client", () => {
  it("apiGet returns parsed JSON from /api", async () => {
    const fn = mockFetch(200, [{ id: "1" }]);
    await expect(apiGet("/documents")).resolves.toEqual([{ id: "1" }]);
    expect(fn).toHaveBeenCalledWith("/api/documents", expect.objectContaining({ credentials: "same-origin" }));
  });

  it("apiPost sends JSON", async () => {
    const fn = mockFetch(200, { ok: true });
    await apiPost("/auth/login", { a: 1 });
    const init = fn.mock.calls[0]![1]!;
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"a":1}');
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
  });

  it("apiUpload sends FormData without a content-type header", async () => {
    const fn = mockFetch(201, { id: "x" });
    const form = new FormData();
    form.set("type", "invoice");
    await apiUpload("/documents", form);
    const init = fn.mock.calls[0]![1]!;
    expect(init.body).toBe(form);
    expect(new Headers(init.headers).has("content-type")).toBe(false);
  });

  it("throws ApiError built from {code,message}", async () => {
    mockFetch(400, { code: "PROVIDER_REJECTED", message: "Incorrect API key" });
    const err = await apiPost("/auth/login", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, code: "PROVIDER_REJECTED", message: "Incorrect API key" });
  });

  it("falls back to a generic error when the body is not {code,message}", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>bad gateway</html>", { status: 502 })));
    await expect(apiGet("/documents")).rejects.toMatchObject({ status: 502, code: "HTTP_502" });
  });

  it("calls the unauthorized handler on 401 and still throws", async () => {
    mockFetch(401, { code: "UNAUTHENTICATED", message: "Sign in required" });
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    await expect(apiGet("/documents")).rejects.toMatchObject({ status: 401 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not run the handler for a 401 from login itself", async () => {
    mockFetch(401, { code: "PROVIDER_REJECTED", message: "bad key" });
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    await expect(apiPost("/auth/login", {})).rejects.toBeInstanceOf(ApiError);
    expect(handler).not.toHaveBeenCalled();
  });
});
