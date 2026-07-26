import { test, expect } from "@playwright/test";
import { gotoChat } from "./helpers.js";

// i18n: the sidebar locale switcher re-renders the shell in the chosen locale,
// and the choice survives a reload. These don't need an LLM call, so they run
// in the fast suite (no @smoke tag).

test.describe("i18n locale switching", () => {
  test("switching locale re-renders visible strings", async ({ page }) => {
    await gotoChat(page); // pinned to en when unset
    await expect(page.getByTestId("locale-select")).toBeVisible();
    await expect(page.getByTestId("status-text")).toHaveText("Connected");

    // en -> zh-CN
    await page.getByTestId("locale-select").selectOption("zh-CN");
    await expect(page.getByTestId("status-text")).toHaveText("已连接");

    // zh-CN -> en (round trip)
    await page.getByTestId("locale-select").selectOption("en");
    await expect(page.getByTestId("status-text")).toHaveText("Connected");
  });

  test("locale choice persists across reload", async ({ page }) => {
    await gotoChat(page);
    await page.getByTestId("locale-select").selectOption("ja");
    await expect(page.getByTestId("status-text")).toHaveText("接続済み");

    await page.reload();
    // After reload the stored locale (ja) is re-applied; the en-pin helper
    // only sets when nothing is stored, so it must NOT clobber "ja".
    await expect(page.getByTestId("status-text")).toHaveText("接続済み");
  });
});
