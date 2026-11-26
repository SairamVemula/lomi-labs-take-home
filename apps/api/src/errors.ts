import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { Response } from "express";

/** Every error leaves the API as `{ code, message }`. */
export type ErrorBody = { code: string; message: string };

export class ApiError extends HttpException {
  constructor(status: number, code: string, message: string) {
    super({ code, message } satisfies ErrorBody, status);
  }
}

const DEFAULT_CODES: Record<number, string> = {
  400: "BAD_REQUEST",
  401: "UNAUTHENTICATED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  429: "RATE_LIMITED",
};

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger("ApiExceptionFilter");

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const r = exception.getResponse();
      const o = typeof r === "object" ? (r as Record<string, unknown>) : { message: r };
      const message = Array.isArray(o.message) ? o.message.join("; ") : String(o.message ?? exception.message);
      const code = typeof o.code === "string" ? o.code : (DEFAULT_CODES[status] ?? "ERROR");
      res.status(status).json({ code, message } satisfies ErrorBody);
      return;
    }
    // Body-parser and similar middleware throw plain errors carrying a status.
    const status = (exception as { status?: unknown }).status;
    if (typeof status === "number" && status >= 400 && status < 500) {
      res.status(status).json({
        code: DEFAULT_CODES[status] ?? "BAD_REQUEST",
        message: (exception as Error).message,
      } satisfies ErrorBody);
      return;
    }
    this.logger.error(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception));
    res
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json({ code: "INTERNAL", message: "Internal server error" } satisfies ErrorBody);
  }
}
