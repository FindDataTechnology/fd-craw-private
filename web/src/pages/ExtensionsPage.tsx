// ExtensionsPage.tsx — Dedicated page for managing MCP servers OR skills.
// Accepts a `type` prop to determine whether to show MCP or Skills management.
// Used by: /extensions/mcp (MCP), /extensions/skills (Skills).

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { McpInstalledView } from "@/components/extensions/McpInstalledView";
import { McpMarketView } from "@/components/extensions/McpMarketView";
import { SkillsInstalledView } from "@/components/extensions/SkillsInstalledView";
import { SkillsMarketView } from "@/components/extensions/SkillsMarketView";
import { useExtensionsStore } from "@/hooks/useExtensionsStore";
import { useEffect } from "react";

export interface ExtensionsPageProps {
  type: "mcp" | "skills";
}

type Tab = "installed" | "market";

export function ExtensionsPage({ type }: ExtensionsPageProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<Tab>("installed");
  const { load, loading, error } = useExtensionsStore();

  useEffect(() => {
    load();
  }, [load]);

  const title = type === "mcp" ? t("extensions.mcp.title") : t("extensions.skills.title");
  const description = type === "mcp" ? t("extensions.mcp.description") : t("extensions.skills.description");

  return (
    <div className="flex flex-col h-full bg-background" data-testid="extensions-page" data-extensions-type={type}>
      {/* Header */}
      <div className="border-b border-border px-6 py-4">
        <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
        <p className="text-sm text-muted-foreground mt-1">{description}</p>
      </div>

      {/* Tabs */}
      <div className="border-b border-border px-6">
        <nav className="flex gap-4">
          <button
            onClick={() => setActiveTab("installed")}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "installed"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t("extensions.tabs.installed")}
          </button>
          <button
            onClick={() => setActiveTab("market")}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "market"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t("extensions.tabs.market")}
          </button>
        </nav>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {loading && (
          <div className="flex items-center justify-center h-full">
            <div className="text-muted-foreground">{t("common.loading")}</div>
          </div>
        )}
        {error && (
          <div className="p-6">
            <div className="bg-destructive/10 text-destructive px-4 py-3 rounded-md">{error}</div>
          </div>
        )}
        {!loading && !error && activeTab === "installed" && (
          type === "mcp" ? <McpInstalledView /> : <SkillsInstalledView />
        )}
        {!loading && !error && activeTab === "market" && (
          type === "mcp" ? (
            <McpMarketView onInstalled={() => setActiveTab("installed")} />
          ) : (
            <SkillsMarketView onInstalled={() => setActiveTab("installed")} />
          )
        )}
      </div>
    </div>
  );
}
