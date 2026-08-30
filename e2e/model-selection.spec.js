import { test, expect } from "@playwright/test";
import { gotoChat } from "./helpers.js";

// The sidebar model <select> is now a read-only chip that links to /models.
// Active model switching still happens via the /model command (WS set_model →
// dsh restart); the Models page sets the *default* pointer (no restart).

async function getDefaultModelId(page) {
  const r = await page.request.get("/api/llm/default");
  const body = await r.json();
  return body.modelId;
}

async function restoreModel(page, modelId) {
  // Reset BOTH the persisted default pointer (PUT) and the active dsh model
  // (/model → restart). set-default persists the pointer but doesn't restart;
  // /model restarts but doesn't un-persist — so cleanup must do both to leave
  // the shared webServer exactly as found. The shared webServer is reused
  // across projects, so this must leave a working model.
  await page.request.put("/api/llm/default", { data: { modelId } });
  await page.goto("/chat/");
  await page.getByTestId("composer-input").fill(`/model ${modelId}`);
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("model-chip")).toContainText(/.+/, { timeout: 20000 });
}

async function ensureModelsLoaded(page) {
  // The chip is disabled-looking while no models are loaded; once it shows a
  // non-"loading" label the model list has arrived.
  await expect(page.getByTestId("model-chip")).toBeVisible({ timeout: 10000 });
  await expect
    .poll(async () => (await page.getByTestId("model-chip").textContent()) || "", { timeout: 5000 })
    .not.toContain("loading");
}

test.describe("model selection", () => {
  let originalModel;

  test.beforeEach(async ({ page }) => {
    await gotoChat(page);
    await ensureModelsLoaded(page);
    originalModel = await getDefaultModelId(page);
  });

  test.afterEach(async ({ page }) => {
    if (!originalModel) return;
    // Restore if EITHER the persisted default pointer OR the active model
    // diverged from the snapshot taken in beforeEach (set-default persists but
    // doesn't restart; /model restarts but doesn't persist — so each half must
    // be undone).
    const current = await getDefaultModelId(page).catch(() => null);
    const active = await page.request
      .get("/api/llm/default")
      .then((r) => r.json())
      .then((b) => b.activeModelId)
      .catch(() => null);
    if ((current && current !== originalModel) || (active && active !== originalModel)) {
      await restoreModel(page, originalModel);
    }
  });

  test("model chip loads models and reflects active model", async ({ page }) => {
    const chip = page.getByTestId("model-chip");
    await expect(chip).toBeVisible();
    await expect(async () => {
      const text = (await chip.textContent()) || "";
      expect(text.trim().length).toBeGreaterThan(0);
    }).toPass({ timeout: 3000 });
  });

  test("model chip navigates to /models", async ({ page }) => {
    await page.getByTestId("model-chip").click();
    await expect(page).toHaveURL(/\/models$/);
    await expect(page.getByTestId("models-page")).toBeVisible();
  });

  test("set default model via the Models page", async ({ page }) => {
    // Discover available models via the WS list (same as the frozen set).
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

    const other = models.find((m) => m.id && m.id !== originalModel);
    if (!other) {
      test.skip(true, "Only one model available, cannot test switching");
      return;
    }

    await page.goto("/models");
    await expect(page.getByTestId("models-page")).toBeVisible();

    // Click "Set as default" on a non-current model; its row gets the check.
    const row = page
      .locator('[data-testid="llm-model-list"] li')
      .filter({ hasText: other.id });
    await row.getByTestId("llm-set-default").click();
    await expect(row.getByTestId("llm-default-check")).toBeVisible({ timeout: 5000 });

    // The default pointer persisted (the active dsh model only changes on a
    // dsh restart, which set-default deliberately does not trigger — so we
    // assert the persisted pointer, not the live chip).
    const saved = await page.request.get("/api/llm/default");
    const savedBody = await saved.json();
    expect(savedBody.modelId).toBe(other.id);
  });

  test("switch model via /model command", async ({ page }) => {
    // Pick deterministically from the frozen Volces ids, one that differs from
    // the CURRENTLY ACTIVE model (not just the persisted default — the two can
    // diverge because set-default persists without restarting). The active id
    // comes from /api/llm/default's activeModelId.
    const def = await page.request.get("/api/llm/default");
    const defBody = await def.json();
    const activeId = defBody.activeModelId;
    const FROZEN = ["deepseek-v4-pro", "deepseek-v4-flash", "glm-5.2"];
    const targetId = FROZEN.find((id) => id !== activeId);
    if (!targetId) {
      test.skip(true, "no alternate frozen model available");
      return;
    }

    await page.getByTestId("composer-input").fill(`/model ${targetId}`);
    await page.getByTestId("composer-send").click();

    const turn = page.getByTestId("turn-assistant").filter({ hasText: `/model` }).last();
    await expect(turn).toBeVisible({ timeout: 20000 });
    await expect(async () => {
      const content = (await turn.textContent()) || "";
      expect(content).toMatch(/Model switched to|Current model:/);
    }).toPass({ timeout: 20000 });

    // The chip reflects the active model; poll because the dsh restart takes a
    // few seconds and current_model is re-sent on the next WS connection.
    const NAMES = {
      "deepseek-v4-pro": "DeepSeek V4 Pro",
      "deepseek-v4-flash": "DeepSeek V4 Flash",
      "glm-5.2": "GLM 5.2",
    };
    await expect
      .poll(async () => (await page.getByTestId("model-chip").textContent()) || "", {
        timeout: 20000,
      })
      .toContain(NAMES[targetId] || targetId);
  });

  test("invalid model id shows error", async ({ page }) => {
    await page.getByTestId("composer-input").fill("/model nonexistent-model-id-12345");
    await page.getByTestId("composer-send").click();

    // The failure lands in the turn as an error block (icon + server detail).
    await expect(page.getByTestId("turn-error-block")).toContainText("Unknown model", {
      timeout: 10000,
    });
  });

  test("list_models returns the frozen Volces-gateway model ids", async ({ page }) => {
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
