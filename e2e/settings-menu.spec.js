import { test, expect } from "@playwright/test";
import { gotoChat } from "./helpers.js";

// SettingsMenu (gear icon in sidebar footer) — popover opens, items navigate,
// popover closes on item selection / outside click / Escape.

test.describe("settings menu", () => {
  test("opens on click and navigates to System Status", async ({ page }) => {
    await gotoChat(page);
    // Popover starts closed.
    await expect(page.getByTestId("settings-menu")).toBeHidden();
    await page.getByTestId("settings-menu-btn").click();
    // Now visible.
    const menu = page.getByTestId("settings-menu");
    await expect(menu).toBeVisible();
    // Status item navigates to /dashboard and shows the system-status page.
    await page.getByTestId("settings-menu-status").click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByTestId("system-status-page")).toBeVisible({ timeout: 15000 });
    // Popover closes after navigation.
    await expect(page.getByTestId("settings-menu")).toBeHidden();
  });

  test("navigates to LLM Models", async ({ page }) => {
    await gotoChat(page);
    await page.getByTestId("settings-menu-btn").click();
    await page.getByTestId("settings-menu-models").click();
    await expect(page).toHaveURL(/\/models$/);
    await expect(page.getByTestId("models-page")).toBeVisible({ timeout: 15000 });
  });

  test("closes on outside click", async ({ page }) => {
    await gotoChat(page);
    await page.getByTestId("settings-menu-btn").click();
    const menu = page.getByTestId("settings-menu");
    await expect(menu).toBeVisible();
    // Click outside (the chat input area).
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await expect(menu).toBeHidden();
  });

  test("closes on Escape", async ({ page }) => {
    await gotoChat(page);
    await page.getByTestId("settings-menu-btn").click();
    const menu = page.getByTestId("settings-menu");
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
  });
});
