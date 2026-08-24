// ── McpMarketView ───────────────────────────────────────────────────────
//
// Render-only component for MCP servers market tab. Extracted from
// MarketTab so /extensions/mcp and /extensions can each render this
// independently without showing skills.

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useExtensionsStore } from "@/hooks/useExtensionsStore";
import { McpMarketCard } from "./McpMarketCard";
import { McpServerForm } from "./McpServerForm";
import type { MarketMcpServer } from "@/lib/extensions-api";

interface McpMarketViewProps {
  onInstalled?: () => void;
}

export function McpMarketView({ onInstalled }: McpMarketViewProps = {}) {
  const { t } = useTranslation();
  const { marketCatalog, refreshMarketCatalog } = useExtensionsStore();
  const [mcpFormOpen, setMcpFormOpen] = useState(false);
  const [selectedMcp, setSelectedMcp] = useState<MarketMcpServer | null>(null);

  useEffect(() => {
    refreshMarketCatalog();
  }, [refreshMarketCatalog]);

  const handleInstallMcp = (server: MarketMcpServer) => {
    setSelectedMcp(server);
    setMcpFormOpen(true);
  };

  const mcpServers = marketCatalog?.mcpServers || [];

  return (
    <>
      <section data-testid="mcp-market-section">
        <h2 className="text-lg font-semibold text-foreground mb-4">{t("extensions.market.mcpTitle")}</h2>
        {mcpServers.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("extensions.market.empty")}</p>
        ) : (
          <div className="grid gap-3">
            {mcpServers.map((server) => (
              <McpMarketCard key={server.name} server={server} onInstall={handleInstallMcp} />
            ))}
          </div>
        )}
      </section>

      <McpServerForm
        open={mcpFormOpen}
        onOpenChange={setMcpFormOpen}
        setupServer={selectedMcp || null}
        onInstalled={onInstalled}
      />
    </>
  );
}