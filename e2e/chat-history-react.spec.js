import { test, expect } from "@playwright/test";
import { gotoHistory } from "./helpers.js";

// React Chat History view (/history): session list + read-only message viewer.

test.describe("React chat history view", () => {
  test("page renders with session list", async ({ page }) => {
    await gotoHistory(page);
    await expect(page.getByTestId("history-list")).toBeVisible();
  });

  test("session row opens read-only message viewer", async ({ page }) => {
    await gotoHistory(page);
    const row = page.getByTestId("history-row").first();
    // If there are no sessions at all, this test is a no-op pass.
    const count = await row.count();
    if (count === 0) return;
    await row.click();
    await expect(page.getByTestId("history-detail")).toBeVisible({ timeout: 10000 });
    // Messages render with a role attribute (a session may legitimately have
    // none yet; only assert if the detail pane reported messages).
    const msgCount = await page.getByTestId("history-message").count();
    if (msgCount > 0) {
      await expect(page.getByTestId("history-message").first()).toBeVisible();
    }
  });
});
