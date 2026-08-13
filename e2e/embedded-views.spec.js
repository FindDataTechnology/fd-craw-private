import { test, expect } from "@playwright/test";

// Embedded service views: OpenConnector + LiteLLM shown as iframes.
// Stubs /api/config to force enabled/disabled states.

async function stubConfig(page, config) {
  await page.route("**/api/config", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(config) });
  });
}

async function stubLitellmCredentials(page) {
  await page.route("**/api/litellm/credentials", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ masterKey: "test-master-key-123" }) });
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

  test("LiteLLM renders iframe when enabled", async ({ page }) => {
    await stubConfig(page, {
      openconnectorEnabled: false,
      litellmEnabled: true,
      litellmManagementUrl: "http://litellm.example:4000/ui",
    });
    await page.goto("/litellm");
    await expect(page.getByTestId("litellm-iframe")).toBeVisible({ timeout: 10000 });
    // The proxy auto-logs the iframe in (openspec litellm-web spec: "The UI
    // SHALL NOT render a master-key bar"), so no credential bar may appear.
    await expect(page.getByTestId("litellm-master-key-bar")).toHaveCount(0);
  });

  test("clicking LiteLLM button in sidebar navigates to LiteLLM web UI", async ({ page }) => {
    // Stub config to enable LiteLLM
    await stubConfig(page, {
      openconnectorEnabled: false,
      litellmEnabled: true,
      litellmManagementUrl: "http://litellm.example:4000/ui",
    });
    await stubLitellmCredentials(page);

    // Start on chat page
    await page.goto("/chat");
    await expect(page.getByTestId("sidebar")).toBeVisible({ timeout: 15000 });

    // Verify LiteLLM button exists and click it
    const litellmButton = page.getByTestId("nav-litellm");
    await expect(litellmButton).toBeVisible();
    await litellmButton.click();

    // Verify we're on the LiteLLM page with the embedded web UI
    await expect(page).toHaveURL(/.*\/litellm/);
    await expect(page.getByTestId("litellm-page")).toBeVisible();

    // Verify the iframe is present (the actual LiteLLM web UI)
    await expect(page.getByTestId("litellm-iframe")).toBeVisible();

    // Verify the iframe is loading LiteLLM UI at the correct path
    const iframe = page.getByTestId("litellm-iframe");
    await expect(iframe).toHaveAttribute("src", "/ui");
  });

  test("LiteLLM shows placeholder when disabled", async ({ page }) => {
    await stubConfig(page, { openconnectorEnabled: false, litellmEnabled: false });
    await page.goto("/litellm");
    await expect(page.getByTestId("litellm-disabled")).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("litellm-iframe")).toHaveCount(0);
  });

  test("LiteLLM button is hidden in sidebar when disabled", async ({ page }) => {
    await stubConfig(page, { openconnectorEnabled: false, litellmEnabled: false });
    await page.goto("/chat");
    await expect(page.getByTestId("sidebar")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("nav-litellm")).toHaveCount(0);
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
