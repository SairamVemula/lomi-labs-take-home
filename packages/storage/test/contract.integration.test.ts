import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileNotFoundError, LocalFileStorage, S3FileStorage, type FileStorage, type S3Config } from "../src/index.js";

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

let dir: string;
let container: StartedTestContainer;
let s3cfg: S3Config;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "storage-"));
  // minio/minio is no longer published on Docker Hub or quay; rustfs is an
  // S3-compatible stand-in. Override the image with S3_TEST_IMAGE if needed.
  container = await new GenericContainer(process.env.S3_TEST_IMAGE ?? "rustfs/rustfs")
    .withExposedPorts(9000)
    .withEnvironment({ RUSTFS_ACCESS_KEY: "minioadmin", RUSTFS_SECRET_KEY: "minioadmin" })
    .withWaitStrategy(Wait.forHttp("/health", 9000))
    .start();
  s3cfg = {
    endpoint: `http://${container.getHost()}:${container.getMappedPort(9000)}`,
    region: "us-east-1",
    bucket: "test-bucket",
    accessKeyId: "minioadmin",
    secretAccessKey: "minioadmin",
    forcePathStyle: true,
  };
  const client = new S3Client({
    endpoint: s3cfg.endpoint,
    region: s3cfg.region,
    forcePathStyle: true,
    credentials: { accessKeyId: s3cfg.accessKeyId, secretAccessKey: s3cfg.secretAccessKey },
  });
  await client.send(new CreateBucketCommand({ Bucket: s3cfg.bucket }));
  client.destroy();
});

afterAll(async () => {
  await container?.stop();
  if (dir) await rm(dir, { recursive: true, force: true });
});

const impls: [string, () => FileStorage][] = [
  ["local", () => new LocalFileStorage(dir)],
  ["s3", () => new S3FileStorage(s3cfg)],
];

describe.each(impls)("FileStorage contract: %s", (kind, make) => {
  it("put/exists/get roundtrip and idempotent overwrite", async () => {
    const s = make();
    const key = `pdfs/${kind}-a.pdf`;
    expect(await s.exists(key)).toBe(false);
    await s.put(key, bytes("hello"), "application/pdf");
    expect(await s.exists(key)).toBe(true);
    expect(text(await s.get(key))).toBe("hello");
    await s.put(key, bytes("hello"), "application/pdf");
    expect(text(await s.get(key))).toBe("hello");
  });

  it("get missing throws FileNotFoundError; delete missing resolves", async () => {
    const s = make();
    const key = `pdfs/${kind}-missing.pdf`;
    const err = await s.get(key).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FileNotFoundError);
    expect((err as FileNotFoundError).key).toBe(key);
    await expect(s.delete(key)).resolves.toBeUndefined();
  });

  it("delete removes", async () => {
    const s = make();
    const key = `pdfs/${kind}-del.pdf`;
    await s.put(key, bytes("x"), "application/pdf");
    await s.delete(key);
    expect(await s.exists(key)).toBe(false);
  });

  it("list returns put keys with recent lastModified", async () => {
    const s = make();
    await s.put(`pdfs/${kind}-l1.pdf`, bytes("1"), "application/pdf");
    await s.put(`pdfs/${kind}-l2.pdf`, bytes("2"), "application/pdf");
    await s.put(`other/${kind}-l3.pdf`, bytes("3"), "application/pdf");
    const items = await s.list("pdfs/");
    const keys = items.map((i) => i.key);
    expect(keys).toContain(`pdfs/${kind}-l1.pdf`);
    expect(keys).toContain(`pdfs/${kind}-l2.pdf`);
    expect(keys).not.toContain(`other/${kind}-l3.pdf`);
    for (const i of items) expect(Math.abs(Date.now() - i.lastModified.getTime())).toBeLessThan(60_000);
  });

  if (kind === "local") {
    it("signedGetUrl is null and bad keys throw", async () => {
      const s = make();
      expect(await s.signedGetUrl("pdfs/a.pdf", 300)).toBeNull();
      for (const bad of ["../x", "/abs", "a\\b", "", "a/../b"]) {
        await expect(s.put(bad, bytes("x"), "application/pdf")).rejects.toThrow();
      }
    });
  } else {
    it("signedGetUrl serves the bytes", async () => {
      const s = make();
      const key = "pdfs/s3-signed.pdf";
      await s.put(key, bytes("signed"), "application/pdf");
      const url = await s.signedGetUrl(key, 300, { filename: "Orig.pdf" });
      expect(url).toContain("X-Amz-Expires=300");
      const res = await fetch(url!);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/pdf");
      expect(res.headers.get("content-disposition")).toBe('inline; filename="Orig.pdf"');
      expect(text(new Uint8Array(await res.arrayBuffer()))).toBe("signed");
    });
  }
});
