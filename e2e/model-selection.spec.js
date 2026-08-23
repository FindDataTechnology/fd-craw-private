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
    // ponytail: dsh switches models by restarting the child (shutdown ≤5s + spawn
    // + initialize), so the selector only reflects the new value after the
    // model_changed broadcast lands post-restart — well past the old 5s ceiling.
    await expect(modelSelect).toHaveValue(otherModel, { timeout: 20000 });
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
    // ponytail: dsh restarts the child on a model switch (shutdown ≤5s + spawn +
    // initialize, which can retry ~17× on adapter-racing), so the command_use
    // block lands well past the old 10s ceiling — same class as the UI test.
    const turn = page.getByTestId("turn-assistant").filter({ hasText: `/model` }).last();
    await expect(turn).toBeVisible({ timeout: 20000 });
    await expect(async () => {
      const content = (await turn.textContent()) || "";
      expect(content).toMatch(/Model switched to|Current model:/);
    }).toPass({ timeout: 20000 });

    await expect(modelSelect).toHaveValue(otherModel, { timeout: 20000 });
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

  test("list_models returns the frozen Volces-gateway model ids", async ({ page }) => {
    // dsh-profile.js deliberately scopes the Volces route to the same 3 ids the
    // pi path's provider factory exposed, to keep the model selector frozen
    // (deepseek-v4-pro, deepseek-v4-flash, glm-5.2). Under dsh these surface with
    // provider "volces" (the route name) — unlike the pi path, where a configured
    // LiteLLM meant LiteLLM-only and no volces-provider model appeared — so assert
    // the frozen id set is present rather than provider absence. Robust to
    // LiteLLM being on (extra litellm ids don't break the subset check).
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

    const volcesIds = models.filter((m) => m.provider === "volces").map((m) => m.id);
    const frozenIds = ["deepseek-v4-pro", "deepseek-v4-flash", "glm-5.2"];
    expect(
      frozenIds.every((id) => volcesIds.includes(id)),
      `expected frozen Volces ids ${frozenIds.join(", ")}; got ${JSON.stringify(volcesIds)}`
    ).toBe(true);
  });
});
