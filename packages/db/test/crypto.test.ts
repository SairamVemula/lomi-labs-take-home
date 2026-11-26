import { describe, expect, it } from "vitest";
import { decryptKey, encryptKey, identityHash } from "../src/crypto.js";

const KEY = "ab".repeat(32);

describe("crypto", () => {
  it("round-trips", () => {
    const enc = encryptKey("sk-secret", KEY);
    expect(enc.toString("utf8")).not.toContain("sk-secret");
    expect(decryptKey(enc, KEY)).toBe("sk-secret");
  });

  it("throws when a byte is tampered", () => {
    const enc = encryptKey("sk-secret", KEY);
    enc[14] = enc[14]! ^ 0xff;
    expect(() => decryptKey(enc, KEY)).toThrow();
  });

  it("throws with the wrong key", () => {
    expect(() => decryptKey(encryptKey("x", KEY), "cd".repeat(32))).toThrow();
  });

  it("identityHash normalizes the base URL", () => {
    expect(identityHash("s", "https://x/v1", "k")).toBe(identityHash("s", "https://X/v1/", "k"));
    expect(identityHash("s", "https://x/v1", "k")).not.toBe(identityHash("s", "https://x/v1", "k2"));
  });
});
