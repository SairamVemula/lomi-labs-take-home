import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { ensureLocalUser, users, type Db, type User } from "@lomi/db";
import { DATABASE } from "../tokens.js";
import type { UserResolver } from "./user-resolver.js";

/** AUTH_MODE=local: always the single built-in local user. Reads no cookie, writes no session. */
@Injectable()
export class LocalUserResolver implements UserResolver {
  constructor(@Inject(DATABASE) private readonly database: { db: Db }) {}

  async resolve(): Promise<User | null> {
    const [u] = await this.database.db.select().from(users).where(eq(users.identityHash, "local"));
    return u ?? (await ensureLocalUser(this.database.db));
  }
}
