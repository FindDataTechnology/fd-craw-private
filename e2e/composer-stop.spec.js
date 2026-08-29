// E2E for the composer hardening pass (critique P0s). Covers:
//   - Enter during IME composition must not submit (pinyin confirm)
//   - the stop button releases a stuck stream and swallows the orphaned
//     run's late events until its `done` clears the suppression
//   - a simulated socket drop finalizes the open turn, shows the reconnect
//     banner, and reconnect clears it
//
// All three drive the window.__chatStore seam (e2e build only) — no real LLM
// call is required.

import { test, expect } from "@playwright/test";
import { gotoChat, waitForIdle } from "./helpers.js";

test.describe("composer hardening: IME, stop, disconnect", () => {
  // No new-session click here: `new_session` broadcasts a session_loaded that
  // resets streaming state, and that async broadcast can land mid-test and
  // wipe the synthetic run these tests drive through the store seam. Only the
  // IME test needs a guaranteed fresh session — it clicks new-chat itself and
  // waits out the handshake before driving the composer.
  test.beforeEach(async ({ page }) => {
    await gotoChat(page);
  });

  test("Enter during IME composition does not submit", async ({ page }) => {
    await page.getByTestId("new-chat-btn").click();
    await expect(page.getByTestId("chat-welcome")).toBeVisible({ timeout: 5000 });
    // Let the new-session handshake (session_changed/session_loaded/sessions
    // broadcasts) finish before driving the composer.
    await page.waitForFunction(() => {
      const s = window.__chatStore?.getState();
      return s && s.currentSessionId !== null && s.turns.length === 0;
    });
    const input = page.getByTestId("composer-input");
    await input.fill("你好");

    // Enter that confirms a composition (isComposing: true, the keyCode 229
    // case) must be ignored: no submit, no picker action, draft intact.
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="composer-input"]');
      el.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
          isComposing: true,
        }),
      );
    });

    await expect(input).toHaveValue("你好");
    // No user turn was created — the welcome state survives the composition
    // Enter.
    await expect(page.getByTestId("chat-welcome")).toBeVisible();

    // The same key outside composition submits as before.
    await input.press("Enter");
    await expect(page.getByTestId("chat-welcome")).toBeHidden({ timeout: 15000 });
    await expect(input).toHaveValue("");
    await waitForIdle(page, 30000);
  });

  test("stop button releases a streaming run and swallows its late events", async ({ page }) => {
    await page.evaluate(() => {
      const s = window.__chatStore;
      s.getState().apply({ type: "agent_start" });
      s.getState().apply({ type: "text", delta: "partial answer" });
    });
    // Let the delta flush into the turn (50ms batching) before stopping —
    // text that never rendered is legitimately dropped by the stop.
    await page.waitForFunction(() => {
      const s = window.__chatStore.getState();
      const tail = s.turns[s.turns.length - 1];
      return !!tail && tail.blocks.some((b) => b.kind === "text" && b.text === "partial answer");
    });
    await expect(page.getByTestId("composer-stop")).toBeVisible();
    await expect(page.getByTestId("composer-send")).toBeHidden();

    await page.getByTestId("composer-stop").click();

    // The open turn finalized where it stood; the composer is back.
    await expect(page.getByTestId("composer-send")).toBeVisible({ timeout: 5000 });
    const afterStop = await page.evaluate(() => {
      const s = window.__chatStore.getState();
      const tail = s.turns[s.turns.length - 1];
      return {
        isStreaming: s.isStreaming,
        suppressed: s.suppressed,
        turnCount: s.turns.length,
        tailStreaming: tail?.streaming,
      };
    });
    expect(afterStop).toEqual({
      isStreaming: false,
      suppressed: true,
      turnCount: 1,
      tailStreaming: false,
    });

    // The orphaned run keeps streaming server-side — those events must not
    // re-open a turn or re-disable the composer (deltas flush at 50ms).
    await page.evaluate(() => {
      window.__chatStore.getState().apply({ type: "text", delta: " LATE" });
    });
    await page.waitForTimeout(200);
    const afterLate = await page.evaluate(() => {
      const s = window.__chatStore.getState();
      const tail = s.turns[s.turns.length - 1];
      const textBlocks = tail.blocks.filter((b) => b.kind === "text");
      return { turnCount: s.turns.length, tailText: textBlocks.map((b) => b.text).join("") };
    });
    expect(afterLate).toEqual({ turnCount: 1, tailText: "partial answer" });

    // The run's `done` ends the suppression — the next run streams normally.
    await page.evaluate(() => {
      const s = window.__chatStore;
      s.getState().apply({ type: "done" });
      s.getState().apply({ type: "agent_start" });
      s.getState().apply({ type: "text", delta: "next run" });
      s.getState().apply({ type: "done" });
    });
    await page.waitForTimeout(200);
    const next = await page.evaluate(() => {
      const s = window.__chatStore.getState();
      return { suppressed: s.suppressed, turnCount: s.turns.length };
    });
    expect(next).toEqual({ suppressed: false, turnCount: 2 });
  });

  test("disconnect finalizes the stream and the banner explains it", async ({ page }) => {
    await page.evaluate(() => {
      const s = window.__chatStore;
      s.getState().apply({ type: "agent_start" });
      s.getState().apply({ type: "text", delta: "mid-stream" });
    });
    // Flush the delta first so the finalized turn keeps visible text.
    await page.waitForFunction(() => {
      const s = window.__chatStore.getState();
      const tail = s.turns[s.turns.length - 1];
      return !!tail && tail.blocks.some((b) => b.kind === "text" && b.text === "mid-stream");
    });
    await page.evaluate(() => {
      // Simulate the WS onclose path (the hook calls setStatus).
      window.__chatStore.getState().setStatus("disconnected");
    });

    await expect(page.getByTestId("connection-banner")).toBeVisible();
    // The stranded run finalized: stop is gone even though no `done` arrived.
    await expect(page.getByTestId("composer-stop")).toBeHidden();
    const state = await page.evaluate(() => {
      const s = window.__chatStore.getState();
      const tail = s.turns[s.turns.length - 1];
      return { isStreaming: s.isStreaming, tailStreaming: tail?.streaming };
    });
    expect(state).toEqual({ isStreaming: false, tailStreaming: false });

    // Late events from the orphaned run stay swallowed after reconnect.
    await page.evaluate(() => {
      window.__chatStore.getState().apply({ type: "text", delta: " LATE" });
    });
    await page.waitForTimeout(200);
    const swallowed = await page.evaluate(() => {
      const s = window.__chatStore.getState();
      const tail = s.turns[s.turns.length - 1];
      return s.turns.length === 1 && !tail.blocks.some((b) => b.kind === "text" && b.text.includes("LATE"));
    });
    expect(swallowed).toBe(true);

    // Reconnect clears the banner (the hook sets "connected" on open).
    await page.evaluate(() => window.__chatStore.getState().setStatus("connected"));
    await expect(page.getByTestId("connection-banner")).toBeHidden();
    await expect(page.getByTestId("status-text")).toHaveText("Connected");
  });

  test("an orphan error broadcast does not fabricate an assistant turn", async ({ page }) => {
    // Cold-boot scenario: the server sends "Agent is still initializing" (or
    // a concurrent-prompt rejection) with no run in flight. It must surface
    // as a toast, not materialize an empty assistant turn with an error
    // block — the welcome state survives.
    await page.evaluate(() => {
      window.__chatStore.getState().apply({ type: "error", message: "Agent is still initializing" });
    });

    await expect(page.getByTestId("chat-welcome")).toBeVisible();
    await expect(page.getByText("Agent is still initializing")).toBeVisible({ timeout: 3000 });
    const turnCount = await page.evaluate(() => window.__chatStore.getState().turns.length);
    expect(turnCount).toBe(0);

    // During a live run the error still attaches to the open turn.
    await page.evaluate(() => {
      const s = window.__chatStore;
      s.getState().apply({ type: "agent_start" });
      s.getState().apply({ type: "text", delta: "streaming" });
    });
    await page.waitForTimeout(150);
    await page.evaluate(() => {
      window.__chatStore.getState().apply({ type: "error", message: "boom" });
    });
    const inTurn = await page.evaluate(() => {
      const s = window.__chatStore.getState();
      const tail = s.turns[s.turns.length - 1];
      return { turnCount: s.turns.length, hasErrorBlock: tail.blocks.some((b) => b.kind === "error") };
    });
    expect(inTurn).toEqual({ turnCount: 1, hasErrorBlock: true });
  });

  test("drag-drop attaches through the same chip lifecycle as the paperclip", async ({ page }) => {
    // Dropping a file on the composer used to upload silently to the
    // documents collection — no chip, no @doc: reference, only a 1.6s toast.
    // Now both gestures share ONE path: the chip mounts as uploading and
    // settles on attached (or failed) — the upload is never invisible.
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(["drag-drop attach e2e content"], "note.txt", { type: "text/plain" }));
      const el = document.querySelector('[data-testid="composer-input"]');
      el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    const chip = page.getByTestId("composer-attachment");
    await expect(chip).toHaveCount(1);
    // Small text file: the uploading state may flash by — the invariant is
    // that the chip EXISTS from the moment of drop and ends attached.
    await expect(chip).toHaveAttribute("data-state", "attached", { timeout: 10000 });
    await expect(chip).toContainText("note.txt");
    await expect(page.getByTestId("composer-attach-count")).toBeVisible();
  });
});
