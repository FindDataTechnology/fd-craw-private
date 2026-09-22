import { test, expect } from "@playwright/test";
import { gotoChat } from "./helpers.js";

// Session navigation while a turn is live. The server admits the prompt
// synchronously (isStreaming flips before the first await), then the navigation
// message arrives on a second async WS-task tick — deterministic without waiting
// on model output. Resolve only on the session_loaded AFTER a done: the socket's
// connect-time session_loaded can otherwise race past `sent`.
function navigationProbe(page, navigation, currentId) {
  return page.evaluate(
    ({ navigation, currentId }) =>
      new Promise((resolve) => {
        const ws = new WebSocket(window.location.origin.replace(/^http/, "ws") + "/");
        const errors = [];
        let sent = false;
        let sawDone = false;
        let loaded = null;
        const timer = setTimeout(() => {
          ws.close();
          resolve({ errors, loaded, timedOut: true });
        }, 30000);
        ws.onmessage = (ev) => {
          const msg = JSON.parse(ev.data);
          if (!sent) return;
          if (msg.type === "error") errors.push(msg.message);
          if (msg.type === "done") sawDone = true;
          if (
            msg.type === "session_loaded" &&
            sawDone &&
            (navigation.type === "new_session" ? msg.id !== currentId : msg.id === navigation.id)
          ) {
            loaded = msg.id;
            clearTimeout(timer);
            ws.close();
            resolve({ errors, loaded, timedOut: false });
          }
        };
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: "prompt", text: "session navigation guard probe" }));
          ws.send(JSON.stringify(navigation));
          sent = true;
        };
      }),
    { navigation, currentId },
  );
}

async function currentSessionId(page) {
  await expect
    .poll(() => page.evaluate(() => window.__chatStore?.getState().currentSessionId), {
      timeout: 5000,
    })
    .toBeTruthy();
  return page.evaluate(() => window.__chatStore.getState().currentSessionId);
}

async function deleteSessionIfPresent(page, id) {
  if (!id) return;
  const del = await page.request.delete(`/api/chat-history/sessions/${encodeURIComponent(id)}`);
  // 409 = still current; the caller must move away first. Anything else is real.
  expect([200, 202, 404, 409]).toContain(del.status());
}

test.describe("session navigation while streaming", () => {
  test.beforeEach(async ({ page }) => {
    await gotoChat(page);
  });

  test("new chat stops the live turn instead of rejecting navigation", async ({ page }) => {
    // Isolate the probe in a fresh session so cleanup cannot delete a session
    // an earlier spec left populated.
    await page.getByTestId("new-chat-btn").click();
    const probeId = await currentSessionId(page);

    const outcome = await navigationProbe(page, { type: "new_session" }, probeId);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.loaded).toBeTruthy();
    expect(outcome.loaded).not.toBe(probeId);
    expect(outcome.errors.some((m) => /while the agent is responding/i.test(m))).toBe(false);
    await expect.poll(() => currentSessionId(page)).not.toBe(probeId);

    // Leave both probe sessions non-current, then remove them from the sidebar.
    await page.getByTestId("new-chat-btn").click();
    await currentSessionId(page);
    await deleteSessionIfPresent(page, outcome.loaded);
    await deleteSessionIfPresent(page, probeId);
  });

  test("switching to another chat stops the live turn instead of rejecting it", async ({ page }) => {
    const targetId = await currentSessionId(page);
    await page.getByTestId("new-chat-btn").click();
    const probeId = await currentSessionId(page);

    const outcome = await navigationProbe(page, { type: "switch_session", id: targetId }, probeId);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.loaded).toBe(targetId);
    expect(outcome.errors.some((m) => /while the agent is responding/i.test(m))).toBe(false);
    await expect.poll(() => currentSessionId(page)).toBe(targetId);

    await page.getByTestId("new-chat-btn").click();
    await currentSessionId(page);
    await deleteSessionIfPresent(page, probeId);
  });
});
