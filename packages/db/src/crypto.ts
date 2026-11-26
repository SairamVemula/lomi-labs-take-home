import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

const IV_LEN = 12;
const TAG_LEN = 16;

function key(keyHex: string): Buffer {
  const k = Buffer.from(keyHex, "hex");
  if (k.length !== 32) throw new Error("KEY_ENCRYPTION_KEY must be 32 bytes (64 hex chars)");
  return k;
}

/** AES-256-GCM; layout: 12-byte IV | ciphertext | 16-byte tag. */
export function encryptKey(plain: string, keyHex: string): Buffer {
  const iv = randomBytes(IV_LEN);
  const c = createCipheriv("aes-256-gcm", key(keyHex), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]);
}

export function decryptKey(buf: Buffer, keyHex: string): string {
  if (buf.length < IV_LEN + TAG_LEN) throw new Error("ciphertext too short");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ct = buf.subarray(IV_LEN, buf.length - TAG_LEN);
  const d = createDecipheriv("aes-256-gcm", key(keyHex), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

/** HMAC-SHA256(secret, normalizedBaseUrl + "\n" + apiKey), hex. */
export function identityHash(secret: string, baseUrl: string, apiKey: string): string {
  const normalized = baseUrl.trim().toLowerCase().replace(/\/+$/, "");
  return createHmac("sha256", secret).update(`${normalized}\n${apiKey}`).digest("hex");
}
