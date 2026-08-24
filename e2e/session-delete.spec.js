import { test, expect } from "@playwright/test";
import { gotoChat } from "./helpers.js";

// Session row right-click → ChatSessionMenu (Delete) → confirmation dialog →
// DELETE /api/chat-history/sessions/:id. Covers:
//   - happy path: row is removed after confirm
//   - active session: Delete is disabled with a tooltip
//   - API: 404 on missing id, 409 on current id (covered by the UI; the
//     409 case is what disables the menu entry)

test.describe("session right-click delete", () => {
  test("creates a new session then deletes a non-active one", async ({ page, request }) => {
    await gotoChat(page);

    // Start with a fresh session ("+ New" makes it current).
    await page.getByTestId("new-chat-btn").click();
    await expect(page.locator('[data-testid="session-row"][data-current="true"]').first())
      .toBeVisible({ timeout: 5000 });

    // Right-click the current row — Delete should be DISABLED with a tooltip
    // (cannot delete the active session).
    const currentRow = page.locator('[data-testid="session-row"][data-current="true"]').first();
    await currentRow.click({ button: "right" });
    const menu = page.getByTestId("session-menu");
    await expect(menu).toBeVisible();
    const deleteBtn = page.getByTestId("session-menu-delete");
    await expect(deleteBtn).toBeDisabled();
    // Dismiss.
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();

    // Start another session so we have at least two rows.
    await page.getByTestId("new-chat-btn").click();
    await expect
      .poll(async () => page.locator('[data-testid="session-row"]').count(), { timeout: 5000 })
      .toBeGreaterThanOrEqual(2);

    // Find a non-current row, right-click, confirm.
    const nonCurrent = page.locator('[data-testid="session-row"][data-current="false"]').first();
    const nonCurrentId = await nonCurrent.getAttribute("data-session-id");
    expect(nonCurrentId).toBeTruthy();

    const beforeCount = await page.locator('[data-testid="session-row"]').count();
    await nonCurrent.click({ button: "right" });
    await expect(page.getByTestId("session-menu")).toBeVisible();
    await expect(page.getByTestId("session-menu-delete")).toBeEnabled();
    await page.getByTestId("session-menu-delete").click();
    // Confirmation dialog appears.
    await expect(page.getByTestId("session-delete-dialog")).toBeVisible();
    await page.getByTestId("session-delete-confirm").click();
    // Row removed (broadcast refreshes the sidebar).
    await expect
      .poll(async () => page.locator(`[data-testid="session-row"][data-session-id="${nonCurrentId}"]`).count(),
            { timeout: 5000 })
      .toBe(0);
    await expect(page.locator('[data-testid="session-row"]').count()).toBeLessThan(beforeCount);
  });

  test("DELETE endpoint returns 404 for missing id", async ({ request }) => {
    const r = await request.delete("/api/chat-history/sessions/no-such-id-12345");
    expect(r.status()).toBe(404);
  });

  test("DELETE endpoint returns 409 for the current session", async ({ page, request }) => {
    await gotoChat(page);
    // Pick the current session id from the sidebar.
    const currentId = await page
      .locator('[data-testid="session-row"][data-current="true"]').first()
      .getAttribute("data-session-id");
    expect(currentId).toBeTruthy();
    const r = await request.delete(`/api/chat-history/sessions/${currentId}`);
    expect(r.status()).toBe(409);
  });
});
