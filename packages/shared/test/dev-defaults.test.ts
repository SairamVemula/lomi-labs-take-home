import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { DEV_KEY_ENCRYPTION_KEY, DEV_SESSION_SECRET } from "../src/dev-defaults.js";

it("matches the defaults literally written in compose.yml", () => {
  const compose = readFileSync(resolve(import.meta.dirname, "../../../compose.yml"), "utf8");
  expect(compose).toContain(`:-${DEV_SESSION_SECRET}}`);
  expect(compose).toContain(`:-${DEV_KEY_ENCRYPTION_KEY}}`);
});
