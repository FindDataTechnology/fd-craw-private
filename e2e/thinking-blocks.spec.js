import { test, expect } from "@playwright/test";
import { gotoChat } from "./helpers.js";

// Tests for thinking block keyboard shortcut (Ctrl+O / Cmd+O).
// The React chat exposes its store on `window.__chatStore` for testing, so we
// drive `thinking` events straight into the reducer instead of a real LLM turn.
// This mirrors the vanilla suite that used document.createElement.

// Push a `thinking` server event into the store; opens a new assistant turn if
// none is open.
async function injectThinking(page, text = "reasoning") {
  await page.evaluate((t) => {
    const store = window.__chatStore.getState();
    store.apply({ type: "agent_start" });
    store.apply({ type: "thinking", delta: t });
    store.apply({ type: "done" });
  }, text);
}

test.describe("thinking blocks", () => {
  test.beforeEach(async ({ page }) => {
    await gotoChat(page);
  });

  test("thinking blocks are expanded by default when created via thinking events", async ({
    page,
  }) => {
    await injectThinking(page, "test reasoning content");
    const block = page.getByTestId("thinking-block");
    await expect(block).toBeVisible();
    await expect(block).toHaveAttribute("data-open", "true");
  });

  // Regression: the delta batching buffer used to be two per-kind string
  // slots flushed in a fixed text-before-thinking order. The reasoning→text
  // boundary routinely lands inside one 50ms window, so the reasoning tail
  // rendered AFTER the answer's opening — one thinking pass showed as two
  // blocks sandwiching the text. The buffer is now an ordered segment list;
  // these two tests pin arrival order in both the common and interleaved
  // shapes. All applies run inside one evaluate, so every delta shares a
  // single flush window and the fold via `done` is deterministic.
  test("reasoning followed by the answer renders one thinking block before the text", async ({
    page,
  }) => {
    await page.evaluate(() => {
      const s = window.__chatStore.getState();
      s.apply({ type: "agent_start" });
      s.apply({ type: "thinking", delta: "let me greet them and offer" });
      s.apply({ type: "thinking", delta: " to help with their project." });
      s.apply({ type: "text", delta: "你好！我是编码助手。" });
      s.apply({ type: "done" });
    });
    const blocks = await page.evaluate(() => {
      const t = window.__chatStore.getState().turns.find((x) => x.role === "assistant");
      return t.blocks.map((b) => ({ kind: b.kind, text: b.text }));
    });
    expect(blocks).toEqual([
      { kind: "thinking", text: "let me greet them and offer to help with their project." },
      { kind: "text", text: "你好！我是编码助手。" },
    ]);
    await expect(page.getByTestId("thinking-block")).toHaveCount(1);
  });

  test("interleaved text/thinking deltas keep their arrival order", async ({ page }) => {
    await page.evaluate(() => {
      const s = window.__chatStore.getState();
      s.apply({ type: "agent_start" });
      s.apply({ type: "thinking", delta: "let me greet them and offer to help with" });
      s.apply({ type: "text", delta: "你好！" });
      s.apply({ type: "thinking", delta: " their project." });
      s.apply({ type: "text", delta: "我是编码助手。" });
      s.apply({ type: "done" });
    });
    const blocks = await page.evaluate(() => {
      const t = window.__chatStore.getState().turns.find((x) => x.role === "assistant");
      return t.blocks.map((b) => ({ kind: b.kind, text: b.text }));
    });
    expect(blocks).toEqual([
      { kind: "thinking", text: "let me greet them and offer to help with" },
      { kind: "text", text: "你好！" },
      { kind: "thinking", text: " their project." },
      { kind: "text", text: "我是编码助手。" },
    ]);
  });

  test("Ctrl+O toggles thinking block expansion state", async ({ page }) => {
    await injectThinking(page, "test reasoning content");
    const block = page.getByTestId("thinking-block");
    await expect(block).toHaveAttribute("data-open", "true");

    // Focus the chat log so the app-level keydown listener fires reliably.
    await page.getByTestId("chat-log").click();

    await page.keyboard.press("Control+O");
    await expect(block).toHaveAttribute("data-open", "false");

    await page.keyboard.press("Control+O");
    await expect(block).toHaveAttribute("data-open", "true");
  });

  test("Ctrl+O toggles multiple thinking blocks at once", async ({ page }) => {
    // Three thinking blocks. Alternate initial open state to prove group toggle.
    await page.evaluate(() => {
      const s = window.__chatStore;
      s.getState().apply({ type: "agent_start" });
      s.getState().apply({ type: "thinking", delta: "one" });
      s.getState().apply({ type: "done" });
      s.getState().apply({ type: "agent_start" });
      s.getState().apply({ type: "thinking", delta: "two" });
      s.getState().apply({ type: "done" });
      s.getState().apply({ type: "agent_start" });
      s.getState().apply({ type: "thinking", delta: "three" });
      s.getState().apply({ type: "done" });
      // Flip the middle one closed by finding & toggling it.
      const asstTurns = s.getState().turns.filter((t) => t.role === "assistant");
      if (asstTurns[1]) s.getState().toggleBlock(asstTurns[1].id, 0);
    });

    const blocks = page.getByTestId("thinking-block");
    await expect(blocks).toHaveCount(3);
    await expect(blocks.nth(0)).toHaveAttribute("data-open", "true");
    await expect(blocks.nth(1)).toHaveAttribute("data-open", "false");
    await expect(blocks.nth(2)).toHaveAttribute("data-open", "true");

    await page.getByTestId("chat-log").click();

    // Any-closed → open all. After first Ctrl+O all should be open.
    await page.keyboard.press("Control+O");
    await expect(blocks.nth(0)).toHaveAttribute("data-open", "true");
    await expect(blocks.nth(1)).toHaveAttribute("data-open", "true");
    await expect(blocks.nth(2)).toHaveAttribute("data-open", "true");

    // Second Ctrl+O: none closed → close all.
    await page.keyboard.press("Control+O");
    await expect(blocks.nth(0)).toHaveAttribute("data-open", "false");
    await expect(blocks.nth(1)).toHaveAttribute("data-open", "false");
    await expect(blocks.nth(2)).toHaveAttribute("data-open", "false");
  });

  test("tool blocks are not affected by Ctrl+O shortcut", async ({ page }) => {
    // Inject both a thinking block (open) and a tool block (open initially).
    await page.evaluate(() => {
      const s = window.__chatStore;
      s.getState().apply({ type: "agent_start" });
      s.getState().apply({ type: "thinking", delta: "reasoning" });
      s.getState().apply({ type: "tool_start", toolCallId: "t1", name: "bash", args: {} });
      s.getState().apply({ type: "tool_end", toolCallId: "t1", name: "bash", result: "ok" });
      s.getState().apply({ type: "done" });
      // Open the tool block (thinking is already open by default; tool is closed).
      const asst = s.getState().turns.find((t) => t.role === "assistant");
      const idxTool = asst.blocks.findIndex((b) => b.kind === "tool");
      s.getState().toggleBlock(asst.id, idxTool);
    });

    const toolBlock = page.getByTestId("tool-block");
    const thinkingBlock = page.getByTestId("thinking-block");

    await expect(toolBlock).toHaveAttribute("data-open", "true");
    await expect(thinkingBlock).toHaveAttribute("data-open", "true");

    await page.getByTestId("chat-log").click();
    await page.keyboard.press("Control+O");

    // Only thinking toggles; tool stays open.
    await expect(toolBlock).toHaveAttribute("data-open", "true");
    await expect(thinkingBlock).toHaveAttribute("data-open", "false");
  });
});
