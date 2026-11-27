import { describe, expect, it } from "vitest";
import { SsrfBlockedError, createSafeFetch, isBlockedAddress } from "../src/safe-fetch.js";

describe("isBlockedAddress", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1"])(
    "blocks %s",
    (ip) => expect(isBlockedAddress(ip)).toBe(true),
  );
  it.each(["1.1.1.1", "2606:4700::1111", "172.32.0.1", "::ffff:8.8.8.8"])("allows %s", (ip) =>
    expect(isBlockedAddress(ip)).toBe(false),
  );
});

describe("createSafeFetch", () => {
  it("rejects http unless private hosts allowed", async () => {
    await expect(createSafeFetch({ allowPrivateHosts: false })("http://example.com")).rejects.toThrow(/https required/);
  });
  it("rejects literal blocked IPs before connecting", async () => {
    await expect(createSafeFetch({ allowPrivateHosts: false })("https://127.0.0.1/x")).rejects.toThrow(/blocked/);
    await expect(createSafeFetch({ allowPrivateHosts: false })("https://[::1]/x")).rejects.toThrow(/blocked/);
  });
  it("rejects hostnames resolving to blocked addresses", async () => {
    await expect(createSafeFetch({ allowPrivateHosts: false })("https://localhost/x")).rejects.toSatisfy(
      (e: unknown) => {
        const c = (e as { cause?: unknown }).cause;
        return e instanceof SsrfBlockedError || c instanceof SsrfBlockedError || /blocked/.test(String((c as Error)?.message ?? (e as Error).message));
      },
    );
  });
});
