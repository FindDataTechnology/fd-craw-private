// ModelList — lists a provider's discovered model ids with a "Set as default"
// action. The active model (from the chat store) is highlighted. Setting the
// default calls PUT /api/llm/default; the server broadcasts model_changed so
// the sidebar chip updates.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { setDefault } from "@/lib/llm-api";
import { useChatStore } from "@/hooks/useChatStore";
import { wsSend } from "@/hooks/useWebSocket";

interface Props {
  providerId: string;
  models: string[];
  // A Set-as-default in flight disables the row; only one at a time.
  onChanged: () => void;
}

export function ModelList({ providerId, models, onChanged }: Props) {
  const { t } = useTranslation();
  const currentModel = useChatStore((s) => s.currentModel);
  const currentEffort = useChatStore((s) => s.currentEffort);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const modelInfo = useChatStore((s) => s.models);
  const [busy, setBusy] = useState<string | null>(null);

  const choose = async (modelId: string) => {
    setBusy(modelId);
    try {
      await setDefault(modelId, providerId);
      onChanged();
    } catch (e) {
      // surfaced by the page-level toast; keep the row usable
      console.warn("[models] set default failed:", (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!models.length) return null;

  return (
    <ul className="flex flex-col gap-1" data-testid="llm-model-list">
      {models.map((m) => {
        const active = currentModel === m;
        const isBusy = busy === m;
        // The thinking level applies to the running session, so the picker is
        // only meaningful on the active model's row.
        const efforts = active ? modelInfo.find((i) => i.id === m)?.reasoningEfforts ?? [] : [];
        return (
          <li
            key={m}
            className="flex items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-1.5 text-xs"
          >
            <span className="flex items-center gap-2 font-mono text-foreground">
              {active && <Check className="h-3.5 w-3.5 text-green-600" data-testid="llm-default-check" />}
              {m}
            </span>
            <span className="flex items-center gap-2">
              {efforts.length > 0 && (
                <select
                  aria-label={t("modelsPage.thinkingLevel")}
                  data-testid="llm-effort-select"
                  value={currentEffort ?? ""}
                  disabled={isStreaming}
                  onChange={(e) => wsSend({ type: "set_effort", effort: e.target.value || null })}
                  className="rounded-md border border-input bg-background px-1.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <option value="">{t("modelsPage.thinkingDefault")}</option>
                  {efforts.map((lvl) => (
                    <option key={lvl} value={lvl}>
                      {lvl}
                    </option>
                  ))}
                </select>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2"
                disabled={active || isBusy}
                onClick={() => choose(m)}
                data-testid="llm-set-default"
              >
                {isBusy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                {active ? t("modelsPage.default") : t("modelsPage.setDefault")}
              </Button>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
