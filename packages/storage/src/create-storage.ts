import { LocalFileStorage } from "./local.js";
import { S3FileStorage } from "./s3.js";
import type { FileStorage, S3Config } from "./types.js";

type Env = Record<string, string | undefined>;

const get = (env: Env, name: string): string | undefined => {
  const v = env[name];
  return v === undefined || v === "" ? undefined : v;
};

/** Returns null when no S3 bucket/credential var is set; throws on partial config. */
export function parseS3Config(env: Env): S3Config | null {
  const bucket = get(env, "S3_BUCKET");
  const accessKeyId = get(env, "S3_ACCESS_KEY_ID");
  const secretAccessKey = get(env, "S3_SECRET_ACCESS_KEY");
  if (!bucket && !accessKeyId && !secretAccessKey) return null;
  const missing = [
    ["S3_BUCKET", bucket],
    ["S3_ACCESS_KEY_ID", accessKeyId],
    ["S3_SECRET_ACCESS_KEY", secretAccessKey],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(`Incomplete S3 configuration: missing ${missing.join(", ")}`);
  }
  const style = get(env, "S3_FORCE_PATH_STYLE")?.toLowerCase();
  const endpoint = get(env, "S3_ENDPOINT");
  return {
    ...(endpoint ? { endpoint } : {}),
    region: get(env, "S3_REGION") ?? "us-east-1",
    bucket: bucket!,
    accessKeyId: accessKeyId!,
    secretAccessKey: secretAccessKey!,
    forcePathStyle: style === "true" || style === "1",
  };
}

export function createStorage(env: Env): FileStorage {
  const s3 = parseS3Config(env);
  if (s3) return new S3FileStorage(s3);
  return new LocalFileStorage(get(env, "STORAGE_DIR") ?? "/data/files");
}
