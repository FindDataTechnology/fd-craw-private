// Extensions page e2e tests.
// Tests the MCP server and skill management UI.

import { test, expect } from "@playwright/test";
import { E2E_PORT, baseURL, gotoExtensions } from "./helpers.js";

test.describe("Extensions Page", () => {
  test("page loads and shows tabs", async ({ page }) => {
    await gotoExtensions(page);

    // Check for the main heading
    await expect(page.getByRole("heading", { name: /extensions/i })).toBeVisible();

    // Check for tab buttons (they're buttons, not ARIA tabs)
    await expect(page.getByRole("button", { name: /installed/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /market/i })).toBeVisible();

    // Check for sections
    await expect(page.getByRole("heading", { name: /mcp servers/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Skills", exact: true })).toBeVisible();
  });

  test("can switch between tabs", async ({ page }) => {
    await gotoExtensions(page);

    // Start on Installed tab
    const installedTab = page.getByRole("button", { name: /installed/i });
    const marketTab = page.getByRole("button", { name: /market/i });

    // Check installed tab is active (has primary border)
    await expect(installedTab).toHaveClass(/border-primary/);

    // Click Market tab
    await marketTab.click();
    await expect(marketTab).toHaveClass(/border-primary/);

    // Check for market content
    await expect(page.getByText(/mcp servers/i).nth(1)).toBeVisible();

    // Click back to Installed
    await installedTab.click();
    await expect(installedTab).toHaveClass(/border-primary/);
  });

  test("add MCP server button opens form", async ({ page }) => {
    await gotoExtensions(page);

    // Click add button
    const addButton = page.getByRole("button", { name: /add mcp server/i });
    await addButton.click();

    // Check for form dialog (our custom dialog)
    await expect(page.getByText(/add mcp server/i).nth(1)).toBeVisible();

    // Check for form fields
    await expect(page.getByLabel(/name/i)).toBeVisible();
    await expect(page.getByLabel(/command/i)).toBeVisible();

    // Close dialog
    await page.getByRole("button", { name: /cancel/i }).click();
    await expect(page.getByText(/add mcp server/i).nth(1)).not.toBeVisible();
  });

  test("add custom skill button opens form", async ({ page }) => {
    await gotoExtensions(page);

    // Click add button
    const addButton = page.getByRole("button", { name: /add custom skill/i });
    await addButton.click();

    // Check for form dialog
    await expect(page.getByText(/add custom skill/i).nth(1)).toBeVisible();

    // Check for form fields
    await expect(page.getByLabel(/name/i)).toBeVisible();
    await expect(page.getByLabel(/description/i)).toBeVisible();
    await expect(page.getByLabel(/content/i)).toBeVisible();

    // Close dialog
    await page.getByRole("button", { name: /cancel/i }).click();
    await expect(page.getByText(/add custom skill/i).nth(1)).not.toBeVisible();
  });

  test("market tab shows catalog items", async ({ page }) => {
    await gotoExtensions(page);

    // Switch to Market tab
    await page.getByRole("button", { name: /market/i }).click();

    // Check for market items (from market-catalog.json)
    // Should show at least one MCP server
    const mcpSection = page.locator("section").filter({ hasText: /mcp servers/i });
    await expect(mcpSection).toBeVisible();

    // Check for install buttons
    const installButtons = page.getByRole("button", { name: /install/i });
    await expect(installButtons.first()).toBeVisible();
  });

  test("API endpoints are accessible", async ({ request }) => {
    // Test MCP servers endpoint
    const mcpResponse = await request.get(`${baseURL}/api/extensions/mcp`);
    expect(mcpResponse.ok()).toBeTruthy();
    const mcpData = await mcpResponse.json();
    expect(Array.isArray(mcpData.servers)).toBeTruthy();

    // Test skills endpoint
    const skillsResponse = await request.get(`${baseURL}/api/extensions/skills`);
    expect(skillsResponse.ok()).toBeTruthy();
    const skillsData = await skillsResponse.json();
    expect(Array.isArray(skillsData.skills)).toBeTruthy();

    // Test market catalog endpoint
    const marketResponse = await request.get(`${baseURL}/api/extensions/market`);
    expect(marketResponse.ok()).toBeTruthy();
    const marketData = await marketResponse.json();
    expect(Array.isArray(marketData.mcpServers)).toBeTruthy();
    expect(Array.isArray(marketData.skills)).toBeTruthy();
  });

  test("can add and remove MCP server via API", async ({ request }) => {
    const serverName = "test-memory-server";

    // Add a server
    const addResponse = await request.post(`${baseURL}/api/extensions/mcp`, {
      data: {
        name: serverName,
        config: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-memory"],
        },
        enabled: true,
      },
    });
    expect(addResponse.ok()).toBeTruthy();
    const added = await addResponse.json();
    expect(added.name).toBe(serverName);
    expect(added.enabled).toBe(true);

    // Verify it's in the list
    const listResponse = await request.get(`${baseURL}/api/extensions/mcp`);
    const list = await listResponse.json();
    const found = list.servers.find((s) => s.name === serverName);
    expect(found).toBeTruthy();

    // Remove it
    const removeResponse = await request.delete(`${baseURL}/api/extensions/mcp/${serverName}`);
    expect(removeResponse.ok()).toBeTruthy();

    // Verify it's gone
    const listAfter = await request.get(`${baseURL}/api/extensions/mcp`);
    const listAfterJson = await listAfter.json();
    const foundAfter = listAfterJson.servers.find((s) => s.name === serverName);
    expect(foundAfter).toBeFalsy();
  });

  test("can add and remove custom skill via API", async ({ request }) => {
    const skillName = "test-custom-skill";

    // Add a skill
    const addResponse = await request.post(`${baseURL}/api/extensions/skills`, {
      data: {
        name: skillName,
        description: "A test skill",
        content: "You are a test assistant.",
        enabled: true,
      },
    });
    expect(addResponse.ok()).toBeTruthy();
    const added = await addResponse.json();
    expect(added.name).toBe(skillName);

    // Verify it's in the list
    const listResponse = await request.get(`${baseURL}/api/extensions/skills`);
    const list = await listResponse.json();
    const found = list.skills.find((s) => s.name === skillName);
    expect(found).toBeTruthy();
    expect(found.source).toBe("database");

    // Remove it
    const removeResponse = await request.delete(`${baseURL}/api/extensions/skills/${skillName}`);
    expect(removeResponse.ok()).toBeTruthy();

    // Verify it's gone
    const listAfter = await request.get(`${baseURL}/api/extensions/skills`);
    const listAfterJson = await listAfter.json();
    const foundAfter = listAfterJson.skills.find((s) => s.name === skillName);
    expect(foundAfter).toBeFalsy();
  });

  test("can toggle MCP server enabled state via API", async ({ request }) => {
    const serverName = "test-toggle-server";

    // Add a server
    await request.post(`${baseURL}/api/extensions/mcp`, {
      data: {
        name: serverName,
        config: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] },
        enabled: true,
      },
    });

    // Disable it
    const disableResponse = await request.patch(`${baseURL}/api/extensions/mcp/${serverName}/enable`, {
      data: { enabled: false },
    });
    expect(disableResponse.ok()).toBeTruthy();
    const disabled = await disableResponse.json();
    expect(disabled.enabled).toBe(false);

    // Re-enable it
    const enableResponse = await request.patch(`${baseURL}/api/extensions/mcp/${serverName}/enable`, {
      data: { enabled: true },
    });
    expect(enableResponse.ok()).toBeTruthy();
    const enabled = await enableResponse.json();
    expect(enabled.enabled).toBe(true);

    // Clean up
    await request.delete(`${baseURL}/api/extensions/mcp/${serverName}`);
  });
});
