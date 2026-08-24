// ProviderCard — one LLM provider on the Models page: name, type, truncated
// base URL, hasKey indicator, last-test status, discovered models, and the
// Edit / Test / Delete actions. Reserved providers (the env Volces route)
// cannot be edited or deleted.

import { useTranslation } from "react-i18next";
import { Pencil, Trash2, Lock, Unlock, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TestConnectionButton } from "./TestConnectionButton";
import { ModelList } from "./ModelList";
import type { LlmProvider } from "@/lib/llm-api";

interface Props {
  provider: LlmProvider;
  onEdit: (p: LlmProvider) => void;
  onDelete: (p: LlmProvider) => void;
  onModelsChanged: () => void;
}

function relativeTime(iso?: string) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "";
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function ProviderCard({ provider, onEdit, onDelete, onModelsChanged }: Props) {
  const { t } = useTranslation();
  const reserved = Boolean(provider.reserved);

  return (
    <section
      className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5"
      data-testid="llm-provider-card"
      data-provider-id={provider.id}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-base font-semibold text-foreground">{provider.name}</h3>
            {reserved && (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                {t("modelsPage.builtIn")}
              </span>
            )}
            <span
              className="inline-flex items-center gap-1 text-xs text-muted-foreground"
              title={provider.hasKey ? t("modelsPage.keyPresent") : t("modelsPage.keyMissing")}
            >
              {provider.hasKey ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
            </span>
          </div>
          <p className="mt-1 flex items-center gap-1 truncate text-xs text-muted-foreground">
            <Globe className="h-3 w-3 shrink-0" />
            <span className="truncate" title={provider.baseUrl}>{provider.baseUrl}</span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!reserved && (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                aria-label={t("modelsPage.editProvider")}
                onClick={() => onEdit(provider)}
                data-testid="llm-edit-btn"
              >
                <Pencil className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-destructive hover:text-destructive"
                aria-label={t("modelsPage.deleteProvider")}
                onClick={() => onDelete(provider)}
                data-testid="llm-delete-btn"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </>
          )}
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        {!reserved && <TestConnectionButton providerId={provider.id} lastTest={provider.lastTest} />}
        {provider.lastTest?.at && (
          <span className="text-xs text-muted-foreground">
            {relativeTime(provider.lastTest.at)}
          </span>
        )}
      </div>

      <ModelList providerId={provider.id} models={provider.models} onChanged={onModelsChanged} />
    </section>
  );
}
