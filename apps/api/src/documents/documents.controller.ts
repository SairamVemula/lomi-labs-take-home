import { Controller, Get, Inject } from "@nestjs/common";
import { listDocuments, type Db, type User } from "@lomi/db";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { DATABASE } from "../tokens.js";

/** Minimal listing so the auth modes are exercised end to end; the rest of the document API lands with the documents task. */
@Controller("documents")
export class DocumentsController {
  constructor(@Inject(DATABASE) private readonly database: { db: Db }) {}

  @Get()
  list(@CurrentUser() user: User): ReturnType<typeof listDocuments> {
    return listDocuments(this.database.db, user.id);
  }
}
