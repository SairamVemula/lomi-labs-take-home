import { type PipeTransform } from "@nestjs/common";
import { ApiError } from "./errors.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Malformed ids are simply "not found", never a 500 from Postgres. */
export class UuidPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!UUID_RE.test(value)) throw new ApiError(404, "NOT_FOUND", "Not found");
    return value;
  }
}

/** Positive-integer version number path param; anything else is a 404. */
export class VersionNumberPipe implements PipeTransform<string, number> {
  transform(value: string): number {
    if (!/^[1-9]\d{0,8}$/.test(value)) throw new ApiError(404, "NOT_FOUND", "Not found");
    return Number(value);
  }
}
