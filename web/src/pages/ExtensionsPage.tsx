// ExtensionsPage.tsx
// Main page for managing MCP servers and skills with a market tab.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { InstalledTab } from "@/components/extensions/InstalledTab";
import { MarketTab } from "@/components/extensions/MarketTab";
import { useExtensionsStore } from "@/hooks/useExtensionsStore";
import { useEffect } from "react";

type Tab = "installed" | "market";

export function ExtensionsPage() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<Tab>("installed");
  const { load, loading, error } = useExtensionsStore();

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="border-b border-border px-6 py-4">
        <h1 className="text-2xl font-semibold text-foreground">{t("extensions.title")}</h1>
        <p className="text-sm text-muted-foreground mt-1">{t("extensions.description")}</p>
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
        {!loading && !error && activeTab === "installed" && <InstalledTab />}
        {!loading && !error && activeTab === "market" && (
          <MarketTab onInstalled={() => setActiveTab("installed")} />
        )}
      </div>
    </div>
  );
}
