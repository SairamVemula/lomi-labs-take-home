import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { FileNotFoundError, type FileStorage, type S3Config } from "./types.js";

function errInfo(err: unknown): { name?: string; status?: number } {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return { name: e?.name, status: e?.$metadata?.httpStatusCode };
}

export class S3FileStorage implements FileStorage {
  readonly kind = "s3" as const;
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(cfg: S3Config) {
    this.bucket = cfg.bucket;
    this.client = new S3Client({
      region: cfg.region,
      ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
      forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, ContentType: contentType }),
    );
  }

  async get(key: string): Promise<Uint8Array> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!res.Body) throw new Error(`Empty body for ${key}`);
      return await res.Body.transformToByteArray();
    } catch (err) {
      const { name, status } = errInfo(err);
      if (name === "NoSuchKey" || name === "NotFound" || status === 404) throw new FileNotFoundError(key);
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      const { name, status } = errInfo(err);
      if (name === "NotFound" || name === "NoSuchKey" || status === 404) return false;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async list(prefix: string): Promise<{ key: string; lastModified: Date }[]> {
    const out: { key: string; lastModified: Date }[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const o of res.Contents ?? []) {
        if (o.Key && o.LastModified) out.push({ key: o.Key, lastModified: o.LastModified });
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  async signedGetUrl(key: string, ttlSeconds: number, opts?: { filename?: string }): Promise<string | null> {
    const filename = opts?.filename?.replace(/["\\\r\n]/g, "_");
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentType: "application/pdf",
        ...(filename ? { ResponseContentDisposition: `inline; filename="${filename}"` } : {}),
      }),
      { expiresIn: ttlSeconds },
    );
  }
}
