// MarketTab.tsx
// Tab showing the market catalog of available MCP servers and skills.

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useExtensionsStore } from "@/hooks/useExtensionsStore";
import { McpMarketCard } from "./McpMarketCard";
import { SkillMarketCard } from "./SkillMarketCard";
import { McpServerForm } from "./McpServerForm";
import { SkillForm } from "./SkillForm";
import type { MarketMcpServer, MarketSkill } from "@/lib/extensions-api";

export function MarketTab() {
  const { t } = useTranslation();
  const { marketCatalog, refreshMarketCatalog } = useExtensionsStore();

  const [mcpFormOpen, setMcpFormOpen] = useState(false);
  const [selectedMcp, setSelectedMcp] = useState<MarketMcpServer | null>(null);
  const [skillFormOpen, setSkillFormOpen] = useState(false);
  const [selectedSkill, setSelectedSkill] = useState<MarketSkill | null>(null);

  useEffect(() => {
    refreshMarketCatalog();
  }, [refreshMarketCatalog]);

  const handleInstallMcp = (server: MarketMcpServer) => {
    setSelectedMcp(server);
    setMcpFormOpen(true);
  };

  const handleInstallSkill = (skill: MarketSkill) => {
    setSelectedSkill(skill);
    setSkillFormOpen(true);
  };

  const mcpServers = marketCatalog?.mcpServers || [];
  const skills = marketCatalog?.skills || [];

  return (
    <div className="p-6 space-y-8">
      {/* MCP Servers Section */}
      <section>
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

      {/* Skills Section */}
      <section>
        <h2 className="text-lg font-semibold text-foreground mb-4">{t("extensions.market.skillsTitle")}</h2>
        {skills.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("extensions.market.empty")}</p>
        ) : (
          <div className="grid gap-3">
            {skills.map((skill) => (
              <SkillMarketCard key={skill.name} skill={skill} onInstall={handleInstallSkill} />
            ))}
          </div>
        )}
      </section>

      {/* Install forms - pre-filled from catalog */}
      <McpServerForm
        open={mcpFormOpen}
        onOpenChange={setMcpFormOpen}
        initialConfig={selectedMcp?.configTemplate || null}
      />
      <SkillForm
        open={skillFormOpen}
        onOpenChange={setSkillFormOpen}
        initialSkill={selectedSkill ? {
          name: selectedSkill.name,
          description: selectedSkill.description,
          content: selectedSkill.skillTemplate.content,
        } : null}
      />
    </div>
  );
}
