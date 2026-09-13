// McpServerCard.tsx
// Card component for displaying an installed MCP server.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { McpServer } from "@/lib/extensions-api";
import { useExtensionsStore } from "@/hooks/useExtensionsStore";
import { useChatStore } from "@/hooks/useChatStore";
import { setPersonalMcp } from "@/lib/bindings-api";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Pencil, Trash2, Zap } from "lucide-react";

interface McpServerCardProps {
  server: McpServer;
  onEdit: (server: McpServer) => void;
}

export function McpServerCard({ server, onEdit }: McpServerCardProps) {
  const { t } = useTranslation();
  const { toggleMcpServer, removeMcpServer } = useExtensionsStore();
  // Non-null only for a socket with an identity — anonymous viewers get no
  // personal controls, so the global card is unchanged for them.
  const mcpBindings = useChatStore((s) => s.userBindings?.mcp);
  const [personalError, setPersonalError] = useState<string | null>(null);
  const binding = mcpBindings?.find((b) => b.name === server.name);

  const handleToggle = async () => {
    try {
      await toggleMcpServer(server.name, !server.enabled);
    } catch (err) {
      console.error("Failed to toggle MCP server:", err);
    }
  };

  const handlePersonalToggle = async () => {
    if (!binding) return;
    setPersonalError(null);
    try {
      await setPersonalMcp(server.name, binding.personalEnabled === false);
    } catch (err) {
      setPersonalError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDelete = async () => {
    if (!confirm(t("extensions.mcp.confirmDelete", { name: server.name }))) return;
    try {
      await removeMcpServer(server.name);
    } catch (err) {
      console.error("Failed to delete MCP server:", err);
    }
  };

  const typeLabel = server.config.command ? "Stdio" : "HTTP";
  const isAuto = server.source === "startup";

  return (
    <div data-testid="mcp-card" data-source={server.source} data-name={server.name} className="border border-border rounded-lg p-4 bg-card">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-medium text-foreground truncate">{server.name}</h3>
            <span data-testid="mcp-type-badge" className="text-xs px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground">
              {typeLabel}
            </span>
            {isAuto && (
              <span data-testid="mcp-auto-badge" className="text-xs px-2 py-0.5 rounded-full bg-warning/15 text-warning flex items-center gap-1">
                <Zap className="h-3 w-3" />
                {t("extensions.status.auto")}
              </span>
            )}
            {!server.enabled && (
              <span data-testid="mcp-disabled-badge" className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                {t("extensions.status.disabled")}
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {server.config.command ? (
              <code className="text-xs">{server.config.command} {server.config.args?.join(" ")}</code>
            ) : (
              <code className="text-xs">{server.config.url}</code>
            )}
          </p>
          {/* Personal overlay: only whether this globally-configured server is
              available to me. Config, URL and credentials stay global. */}
          {binding?.globalEnabled && (
            <div className="mt-2 flex items-center gap-2">
              <Switch
                data-testid="mcp-personal-toggle"
                checked={binding.personalEnabled !== false}
                disabled={binding.locked}
                onCheckedChange={handlePersonalToggle}
              />
              <span className="text-xs text-muted-foreground">{t("bindings.personalMcp")}</span>
              {binding.locked && (
                <span className="text-xs text-muted-foreground" data-testid="mcp-personal-locked">
                  · {t("bindings.lockedMcp")}
                </span>
              )}
            </div>
          )}
          {personalError && (
            <p className="mt-1 text-xs text-destructive" data-testid="mcp-personal-error">
              {personalError}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Switch data-testid="mcp-toggle" checked={server.enabled} onCheckedChange={handleToggle} />
          <Button data-testid="mcp-edit-btn" variant="ghost" size="icon" onClick={() => onEdit(server)}>
            <Pencil className="h-4 w-4" />
          </Button>
          {/* Always rendered so the toggle/edit/delete columns line up across
              rows; auto-sourced servers only hide it visually. */}
          <Button
            data-testid="mcp-delete-btn"
            variant="ghost"
            size="icon"
            className={isAuto ? "invisible" : undefined}
            onClick={handleDelete}
          >
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      </div>
    </div>
  );
}
