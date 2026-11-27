import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { FileNotFoundError, type FileStorage } from "./types.js";

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT" || (err as NodeJS.ErrnoException)?.code === "ENOTDIR";
}

export class LocalFileStorage implements FileStorage {
  readonly kind = "local" as const;
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
  }

  private pathFor(key: string): string {
    if (
      key === "" ||
      key.startsWith("/") ||
      key.includes("\\") ||
      key.includes("\0") ||
      /^[a-zA-Z]:/.test(key) ||
      key.split("/").some((seg) => seg === ".." || seg === "." || seg === "")
    ) {
      throw new Error(`Invalid storage key: ${JSON.stringify(key)}`);
    }
    const full = resolve(this.rootDir, ...key.split("/"));
    if (!full.startsWith(this.rootDir + sep)) throw new Error(`Invalid storage key: ${JSON.stringify(key)}`);
    return full;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
    try {
      await writeFile(tmp, bytes);
      await rename(tmp, path);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  async get(key: string): Promise<Uint8Array> {
    try {
      return new Uint8Array(await readFile(this.pathFor(key)));
    } catch (err) {
      if (isNotFound(err)) throw new FileNotFoundError(key);
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      return (await stat(this.pathFor(key))).isFile();
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async list(prefix: string): Promise<{ key: string; lastModified: Date }[]> {
    const out: { key: string; lastModified: Date }[] = [];
    const walk = async (rel: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(join(this.rootDir, rel), { withFileTypes: true });
      } catch (err) {
        if (isNotFound(err)) return;
        throw err;
      }
      for (const e of entries) {
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          await walk(childRel);
        } else if (e.isFile() && childRel.startsWith(prefix) && !/\.tmp-[0-9a-f]+$/.test(e.name)) {
          const s = await stat(join(this.rootDir, childRel));
          out.push({ key: childRel, lastModified: s.mtime });
        }
      }
    };
    await walk("");
    return out;
  }

  async signedGetUrl(): Promise<string | null> {
    return null;
  }
}
