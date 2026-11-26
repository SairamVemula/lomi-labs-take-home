export interface FileStorage {
  readonly kind: "local" | "s3";
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<{ key: string; lastModified: Date }[]>;
  signedGetUrl(key: string, ttlSeconds: number, opts?: { filename?: string }): Promise<string | null>;
}

export class FileNotFoundError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`File not found: ${key}`);
    this.name = "FileNotFoundError";
    this.key = key;
  }
}

export type S3Config = {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
};
