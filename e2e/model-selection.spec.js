import { test, expect } from "@playwright/test";
import { gotoChat } from "./helpers.js";

async function ensureModelsLoaded(page) {
  const modelSelect = page.getByTestId("model-select");
  await expect(modelSelect).toBeEnabled({ timeout: 10000 });
  // The selector is disabled while there are no models; once enabled, it has options.
  await expect
    .poll(async () => modelSelect.locator("option").count(), { timeout: 5000 })
    .toBeGreaterThan(0);
}

test.describe("model selection", () => {
  test.beforeEach(async ({ page }) => {
    await gotoChat(page);
  });

  test("model selector loads models and reflects active model", async ({ page }) => {
    const modelSelect = page.getByTestId("model-select");
    await ensureModelsLoaded(page);
    const optionTexts = await modelSelect.locator("option").allInnerTexts();
    expect(optionTexts).not.toContain("No models");

    // current_model may arrive before/after models; once both processed, value is set.
    await expect(async () => {
      const selectedValue = await modelSelect.inputValue();
      expect(selectedValue).toBeTruthy();
    }).toPass({ timeout: 3000 });
  });

  test("switch model via UI selector", async ({ page }) => {
    const modelSelect = page.getByTestId("model-select");
    await ensureModelsLoaded(page);

    const optionValues = await modelSelect
      .locator("option")
      .evaluateAll((els) => els.map((e) => e.value));
    const currentValue = await modelSelect.inputValue();
    const otherModel = optionValues.find((v) => v && v !== currentValue);

    if (!otherModel) {
      test.skip(true, "Only one model available, cannot test switching");
      return;
    }

    await modelSelect.selectOption(otherModel);
    await expect(modelSelect).toHaveValue(otherModel, { timeout: 5000 });
  });

  test("switch model via /model command", async ({ page }) => {
    const modelSelect = page.getByTestId("model-select");
    await ensureModelsLoaded(page);

    const optionValues = await modelSelect
      .locator("option")
      .evaluateAll((els) => els.map((e) => e.value));
    const currentValue = await modelSelect.inputValue();
    const otherModel = optionValues.find((v) => v && v !== currentValue);

    if (!otherModel) {
      test.skip(true, "Only one model available, cannot test switching");
      return;
    }

    // Send /model <id>. React composer forwards it as a "prompt" with the slash text;
    // server recognises the command and broadcasts command_use.
    await page.getByTestId("composer-input").fill(`/model ${otherModel}`);
    await page.getByTestId("composer-send").click();

    // The command_use event lands inside the current assistant turn as text
    // starting with "⚙️ /model ...". Selector: turn-assistant containing "/model".
    const turn = page.getByTestId("turn-assistant").filter({ hasText: `/model` }).last();
    await expect(turn).toBeVisible({ timeout: 10000 });
    await expect(async () => {
      const content = (await turn.textContent()) || "";
      expect(content).toMatch(/Model switched to|Current model:/);
    }).toPass({ timeout: 5000 });

    await expect(modelSelect).toHaveValue(otherModel, { timeout: 5000 });
  });

  test("invalid model id shows error", async ({ page }) => {
    const modelSelect = page.getByTestId("model-select");
    await ensureModelsLoaded(page);
    const originalModel = await modelSelect.inputValue();

    await page.getByTestId("composer-input").fill("/model nonexistent-model-id-12345");
    await page.getByTestId("composer-send").click();

    // Errors from the server land as an "error" block inside the assistant turn.
    // The turn's text contains "⚠️" from the error block chip.
    await expect(page.getByTestId("turn-assistant").last()).toContainText("⚠️", {
      timeout: 10000,
    });

    await expect(modelSelect).toHaveValue(originalModel, { timeout: 3000 });
  });

  test("list_models returns no Volces-provider models (LiteLLM-only)", async ({ page }) => {
    // When LiteLLM is configured only the LiteLLM extension is registered, so
    // no model is surfaced under the native "volces" provider - whether the
    // proxy is up (models arrive via /v1/models with provider "litellm") or
    // down (fallback to the extension's upstream-named models). Asserting at
    // the protocol level is robust to the proxy being unreachable.
    const models = await page.evaluate(async () => {
      return await new Promise((resolve, reject) => {
        const wsUrl = window.location.origin.replace(/^http/, "ws") + "/";
        const ws = new WebSocket(wsUrl);
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error("list_models timeout"));
        }, 10000);
        ws.onopen = () => ws.send(JSON.stringify({ type: "list_models" }));
        ws.onmessage = (ev) => {
          const msg = JSON.parse(ev.data);
          if (msg.type === "models") {
            clearTimeout(timer);
            ws.close();
            resolve(msg.models || []);
          }
        };
        ws.onerror = () => {
          clearTimeout(timer);
          reject(new Error("websocket error"));
        };
      });
    });

    const volcesModels = models.filter((m) => m.provider === "volces");
    expect(
      volcesModels,
      `expected no Volces-provider models, got ${JSON.stringify(volcesModels)}`
    ).toEqual([]);
  });
});
