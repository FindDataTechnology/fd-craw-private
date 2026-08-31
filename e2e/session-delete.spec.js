import { test, expect } from "@playwright/test";
import { gotoChat, waitForIdle } from "./helpers.js";

// Session row right-click → ChatSessionMenu (Delete) → confirmation dialog →
// DELETE /api/chat-history/sessions/:id. Covers:
//   - happy path: row is removed after confirm
//   - active session: Delete is disabled with a tooltip
//   - API: 404 on missing id, 409 on current id (covered by the UI; the
//     409 case is what disables the menu entry)
//
// The test first sends one message on the boot session: a session only gains
// a persistent row on its first message (recordMessage upserts chat_sessions),
// and listSessions merges ONLY the current in-memory session — a messageless
// session vanishes from the sidebar once another becomes current, so without
// that message "+ New" can never produce a second row in a fresh store.

test.describe("session right-click delete", () => {
  test("creates a new session then deletes a non-active one", async ({ page }) => {
    await gotoChat(page);
    const currentRow = () =>
      page.locator('[data-testid="session-row"][data-current="true"]').first();

    // Persist the boot session (see file comment). The turn errors offline —
    // the fast project's LLM_BASE_URL is a dead port — but the user message
    // is mirrored to SQLite before the prompt is issued.
    await waitForIdle(page, 30000);
    await page.getByTestId("composer-input").fill("session-delete persistence ping");
    await page.getByTestId("composer-send").click();
    // No idle wait here: offline the errored turn never emits agent_start, so
    // client isStreaming stays false from the start and waitForIdle is a no-op,
    // while the server (ctx.isStreaming set synchronously on send) would still
    // reject new_session. The "+ New" block below retries instead.

    // "+ New" starts a fresh session — wait for the CURRENT id to change.
    // "A current row is visible" also holds BEFORE the new_session broadcast
    // lands, and right-clicking that stale row races the broadcast: isCurrent
    // flips mid-render and Delete shows enabled instead of disabled (CI flake).
    // Wrapped in toPass: if the server is still finishing the errored turn, it
    // rejects new_session ("Cannot start a new chat while the agent is
    // responding") and the click retries once the turn ends. Note the message
    // above lands in whatever session is current — earlier specs (chat-polish)
    // may have renamed it, so the row title is not a stable wait key.
    await expect(currentRow()).toBeVisible({ timeout: 5000 });
    const beforeId = await currentRow().getAttribute("data-session-id");
    await expect(async () => {
      await page.getByTestId("new-chat-btn").click();
      await expect
        .poll(async () => currentRow().getAttribute("data-session-id"), { timeout: 5000 })
        .not.toBe(beforeId);
    }).toPass({ timeout: 30000 });

    // Right-click the current row — Delete should be DISABLED with a tooltip
    // (cannot delete the active session).
    await currentRow().click({ button: "right" });
    const menu = page.getByTestId("session-menu");
    await expect(menu).toBeVisible();
    await expect(page.getByTestId("session-menu-delete")).toBeDisabled();
    // Dismiss.
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();

    // Two rows now: the persisted (non-current) one + the fresh current one.
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
    expect(await page.locator('[data-testid="session-row"]').count()).toBeLessThan(beforeCount);
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
