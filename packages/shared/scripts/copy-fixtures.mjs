import { copyFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
copyFileSync(
  resolve(root, "assignment/fixtures/expected-fields.json"),
  resolve(import.meta.dirname, "../src/expected-fields.json"),
);
