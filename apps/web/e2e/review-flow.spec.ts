import path from "node:path";
import { expect, test } from "@playwright/test";

const V2_PDF = path.resolve(import.meta.dirname, "../../../assignment/fixtures/documents/invoice-001.v2.pdf");

test("review an invoice, then re-extract a revised version and carry reviews over", async ({ page }) => {
  // Local mode: no login, no cookie. All three seeded documents are extracted by the worker.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();
  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(3);
  for (const row of await rows.all()) {
    await expect(row.getByText("Extracted", { exact: true })).toBeVisible();
  }

  // Open the invoice: five values, none reviewed yet.
  await page.getByRole("link", { name: /Meridian Office Supplies/ }).click();
  await expect(page.getByText("5 values need your review")).toBeVisible();

  // Approve all five (an approved row leaves the "Needs review" group, so the first button is always the next one).
  const approve = page.getByRole("button", { name: "Approve", exact: true });
  for (let left = 5; left > 0; left--) {
    await expect(approve).toHaveCount(left);
    await approve.first().click();
  }
  await expect(page.getByText("All reviewed")).toBeVisible();

  // Upload the revised invoice (only due date and total changed).
  await page.getByLabel("New version PDF").setInputFiles(V2_PDF);
  await expect(page.getByText("Uploaded — extraction started")).toBeVisible();
  await expect(page.getByText("Extracted", { exact: true })).toBeVisible();
  await expect(page.getByText("2 values need your review")).toBeVisible();

  // 3 unchanged values keep their review; the 2 changed ones are flagged and show what they were.
  const values = page.getByRole("region", { name: "Extracted values" });
  await expect(values.locator("article").getByText(/^Carried over/)).toHaveCount(3);
  await expect(values.locator("article").getByText("Changed", { exact: true })).toHaveCount(2);
  await expect(values.getByText(/^Previously · version 1$/)).toHaveCount(2);
});
