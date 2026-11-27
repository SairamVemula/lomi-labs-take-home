import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import type { User } from "@lomi/db";
import { DocumentTypeSchema, type DocumentDetail, type DocumentSummary, type Progress } from "@lomi/shared";
import { FileNotFoundError, type FileStorage } from "@lomi/storage";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { ApiError } from "../errors.js";
import { UuidPipe, VersionNumberPipe } from "../params.js";
import { STORAGE } from "../tokens.js";
import { DocumentsService, type UploadedFile as Upload } from "./documents.service.js";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const upload = () => FileInterceptor("file", { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

/** Presence and `%PDF-` magic bytes; the 5 MB limit was enforced by multer already. */
function requirePdf(file: Upload | undefined): Upload {
  if (!file) throw new ApiError(400, "FILE_REQUIRED", 'A PDF file is required (multipart field "file")');
  if (file.buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw new ApiError(400, "NOT_A_PDF", "The uploaded file is not a PDF");
  }
  return file;
}

const headerSafe = (name: string) => name.replace(/["\\\r\n]/g, "_");

@Controller("documents")
export class DocumentsController {
  constructor(
    @Inject(DocumentsService) private readonly docs: DocumentsService,
    @Inject(STORAGE) private readonly storage: FileStorage,
  ) {}

  @Get()
  list(@CurrentUser() user: User): Promise<DocumentSummary[]> {
    return this.docs.list(user.id);
  }

  @Post()
  @UseInterceptors(upload())
  create(
    @CurrentUser() user: User,
    @UploadedFile() file: Upload | undefined,
    @Body() body: Record<string, unknown> | undefined,
  ): Promise<{ id: string; status: "queued"; version: 1 }> {
    const pdf = requirePdf(file);
    const type = DocumentTypeSchema.safeParse(body?.type);
    if (!type.success) {
      throw new ApiError(400, "INVALID_TYPE", `type must be one of ${DocumentTypeSchema.options.join(", ")}`);
    }
    const title = typeof body?.title === "string" && body.title.trim() ? body.title.trim() : undefined;
    return this.docs.create(user.id, type.data, title, pdf);
  }

  @Post(":id/versions")
  @UseInterceptors(upload())
  uploadVersion(
    @CurrentUser() user: User,
    @Param("id", new UuidPipe()) id: string,
    @UploadedFile() file: Upload | undefined,
  ): Promise<{ id: string; version: number; status: "queued" }> {
    return this.docs.uploadVersion(user.id, id, requirePdf(file));
  }

  @Post(":id/retry")
  @HttpCode(202)
  retry(@CurrentUser() user: User, @Param("id", new UuidPipe()) id: string): Promise<{ id: string; status: "queued" }> {
    return this.docs.retry(user.id, id);
  }

  @Get(":id/progress")
  progress(@CurrentUser() user: User, @Param("id", new UuidPipe()) id: string): Promise<Progress> {
    return this.docs.progress(user.id, id);
  }

  @Get(":id/versions/:n/file")
  async file(
    @CurrentUser() user: User,
    @Param("id", new UuidPipe()) id: string,
    @Param("n", new VersionNumberPipe()) n: number,
    @Res() res: Response,
  ): Promise<void> {
    const f = await this.docs.file(user.id, id, n);
    const filename = headerSafe(f.originalFilename);
    if (this.storage.kind === "s3") {
      const url = await this.storage.signedGetUrl(f.storageKey, 300, { filename });
      if (url) {
        res.redirect(302, url);
        return;
      }
    }
    let bytes: Uint8Array;
    try {
      bytes = await this.storage.get(f.storageKey);
    } catch (err) {
      if (err instanceof FileNotFoundError) throw new ApiError(404, "FILE_NOT_FOUND", "The stored file is missing");
      throw err;
    }
    res
      .status(200)
      .setHeader("Content-Type", "application/pdf")
      .setHeader("Content-Disposition", `inline; filename="${filename}"`)
      .setHeader("Cache-Control", "private, no-store")
      .send(Buffer.from(bytes));
  }

  @Get(":id")
  detail(
    @CurrentUser() user: User,
    @Param("id", new UuidPipe()) id: string,
    @Query("version") version?: string,
  ): Promise<DocumentDetail> {
    let n: number | undefined;
    if (version !== undefined) {
      if (!/^[1-9]\d{0,8}$/.test(version)) throw new ApiError(400, "BAD_REQUEST", "version must be a positive integer");
      n = Number(version);
    }
    return this.docs.detail(user.id, id, n);
  }
}
