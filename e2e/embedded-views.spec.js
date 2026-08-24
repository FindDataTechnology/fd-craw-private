import { test, expect } from "@playwright/test";

// Embedded service views: OpenConnector shown as iframe.
// Stubs /api/config to force enabled/disabled states.

async function stubConfig(page, config) {
  await page.route("**/api/config", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(config) });
  });
}

test.describe("embedded service views", () => {
  test("OpenConnector renders iframe when enabled", async ({ page }) => {
    await stubConfig(page, { openconnectorEnabled: true });
    await page.goto("/openconnector");
    await expect(page.getByTestId("openconnector-iframe")).toBeVisible({ timeout: 10000 });
  });

  test("OpenConnector shows placeholder when disabled", async ({ page }) => {
    await stubConfig(page, { openconnectorEnabled: false });
    await page.goto("/openconnector");
    await expect(page.getByTestId("openconnector-disabled")).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("openconnector-iframe")).toHaveCount(0);
  });

  test("real /api/config exposes openconnectorEnabled (not stubbed)", async ({ page }) => {
    // Hit the real server config (no route stub). The OpenConnector page gates
    // its iframe on this field; before the fix it was absent from the response.
    const res = await page.request.get("/api/config");
    expect(res.ok()).toBe(true);
    const cfg = await res.json();
    expect(typeof cfg.openconnectorEnabled).toBe("boolean");
    // LiteLLM was removed from the platform; the config field no longer exists.
    expect(cfg.litellmEnabled).toBeUndefined();
  });
});
