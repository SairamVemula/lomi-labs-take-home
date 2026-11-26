import { describe, expect, it } from "vitest";
import { createStorage } from "../src/index.js";
import { parseS3Config } from "../src/create-storage.js";

describe("createStorage", () => {
  it("defaults to local", () => {
    expect(createStorage({}).kind).toBe("local");
  });
  it("treats empty strings as unset", () => {
    expect(createStorage({ S3_BUCKET: "", S3_ACCESS_KEY_ID: "", STORAGE_DIR: "" }).kind).toBe("local");
  });
  it("uses STORAGE_DIR", () => {
    const s = createStorage({ STORAGE_DIR: "/tmp/x" });
    expect((s as unknown as { rootDir: string }).rootDir).toMatch(/tmp[\\/]x$/);
  });
  it("selects s3 with full config", () => {
    const s = createStorage({
      S3_BUCKET: "b",
      S3_ACCESS_KEY_ID: "k",
      S3_SECRET_ACCESS_KEY: "s",
      S3_FORCE_PATH_STYLE: "1",
    });
    expect(s.kind).toBe("s3");
  });
  it("names every missing var on partial config", () => {
    expect(() => createStorage({ S3_BUCKET: "b" })).toThrow(/S3_ACCESS_KEY_ID.*S3_SECRET_ACCESS_KEY/);
    expect(() => createStorage({ S3_ACCESS_KEY_ID: "k" })).toThrow(/S3_BUCKET.*S3_SECRET_ACCESS_KEY/);
  });
  it("parses S3_FORCE_PATH_STYLE and defaults", () => {
    const base = { S3_BUCKET: "b", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s" };
    expect(parseS3Config({ ...base, S3_FORCE_PATH_STYLE: "true" })?.forcePathStyle).toBe(true);
    expect(parseS3Config({ ...base, S3_FORCE_PATH_STYLE: "1" })?.forcePathStyle).toBe(true);
    expect(parseS3Config({ ...base, S3_FORCE_PATH_STYLE: "false" })?.forcePathStyle).toBe(false);
    expect(parseS3Config(base)?.forcePathStyle).toBe(false);
    expect(parseS3Config(base)?.region).toBe("us-east-1");
    expect(parseS3Config({})).toBeNull();
  });
});
