import { test, expect } from "@playwright/test";

// Embedded service views: OpenConnector + LiteLLM shown as iframes.
// Stubs /api/config to force enabled/disabled states.

async function stubConfig(page, config) {
  await page.route("**/api/config", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(config) });
  });
}

test.describe("embedded service views", () => {
  test("OpenConnector renders iframe when enabled", async ({ page }) => {
    await stubConfig(page, { openconnectorEnabled: true, litellmEnabled: false });
    await page.goto("/openconnector");
    await expect(page.getByTestId("openconnector-iframe")).toBeVisible({ timeout: 10000 });
  });

  test("OpenConnector shows placeholder when disabled", async ({ page }) => {
    await stubConfig(page, { openconnectorEnabled: false, litellmEnabled: false });
    await page.goto("/openconnector");
    await expect(page.getByTestId("openconnector-disabled")).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("openconnector-iframe")).toHaveCount(0);
  });

  test("LiteLLM renders open-in-new-tab link when enabled", async ({ page }) => {
    await stubConfig(page, {
      openconnectorEnabled: false,
      litellmEnabled: true,
      litellmManagementUrl: "http://litellm.example:4000/ui",
    });
    await page.goto("/litellm");
    const link = page.getByTestId("litellm-open-link");
    await expect(link).toBeVisible({ timeout: 10000 });
    await expect(link).toHaveAttribute("href", "http://litellm.example:4000/ui");
    await expect(link).toHaveAttribute("target", "_blank");
    // The LiteLLM dashboard is opened in a new tab, not embedded in an iframe.
    await expect(page.getByTestId("litellm-iframe")).toHaveCount(0);
  });

  test("LiteLLM shows placeholder when disabled", async ({ page }) => {
    await stubConfig(page, { openconnectorEnabled: false, litellmEnabled: false });
    await page.goto("/litellm");
    await expect(page.getByTestId("litellm-disabled")).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("litellm-open-link")).toHaveCount(0);
  });

  test("real /api/config exposes openconnectorEnabled (not stubbed)", async ({ page }) => {
    // Hit the real server config (no route stub). The OpenConnector page gates
    // its iframe on this field; before the fix it was absent from the response.
    const res = await page.request.get("/api/config");
    expect(res.ok()).toBe(true);
    const cfg = await res.json();
    expect(typeof cfg.openconnectorEnabled).toBe("boolean");
    expect(typeof cfg.litellmEnabled).toBe("boolean");
  });
});
