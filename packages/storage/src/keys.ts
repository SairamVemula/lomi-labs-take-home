import { createHash } from "node:crypto";

const MAX_SLUG = 80;

function slugify(name: string): string {
  const base = name.replace(/\.pdf$/i, "");
  const slug = base
    .replace(/[ªº°№]/g, "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, "");
  return slug || "document";
}

/** `pdfs/<slug>-<sha256>.pdf`; slug is derived from the original filename. */
export function pdfStorageKey(originalFilename: string, sha256Hex: string): string {
  return `pdfs/${slugify(originalFilename)}-${sha256Hex.toLowerCase()}.pdf`;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
