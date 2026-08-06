// SkillMarketCard.tsx
// Card component for displaying a market skill.

import { useTranslation } from "react-i18next";
import type { MarketSkill } from "@/lib/extensions-api";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";

interface SkillMarketCardProps {
  skill: MarketSkill;
  onInstall: (skill: MarketSkill) => void;
}

export function SkillMarketCard({ skill, onInstall }: SkillMarketCardProps) {
  const { t } = useTranslation();

  return (
    <div data-testid="skill-market-card" data-market-name={skill.name} className="border border-border rounded-lg p-4 bg-card">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-medium text-foreground truncate">{skill.displayName}</h3>
            <span className="text-xs px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground">
              {skill.category}
            </span>
          </div>
          <p className="text-sm text-muted-foreground line-clamp-2">{skill.description}</p>
        </div>
        <Button size="sm" onClick={() => onInstall(skill)}>
          <Download className="h-4 w-4 mr-1" />
          {t("extensions.market.install")}
        </Button>
      </div>
    </div>
  );
}
