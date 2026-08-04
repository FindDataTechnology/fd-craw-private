// McpServerCard.tsx
// Card component for displaying an installed MCP server.

import { useTranslation } from "react-i18next";
import type { McpServer } from "@/lib/extensions-api";
import { useExtensionsStore } from "@/hooks/useExtensionsStore";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Pencil, Trash2 } from "lucide-react";

interface McpServerCardProps {
  server: McpServer;
  onEdit: (server: McpServer) => void;
}

export function McpServerCard({ server, onEdit }: McpServerCardProps) {
  const { t } = useTranslation();
  const { toggleMcpServer, removeMcpServer } = useExtensionsStore();

  const handleToggle = async () => {
    try {
      await toggleMcpServer(server.name, !server.enabled);
    } catch (err) {
      console.error("Failed to toggle MCP server:", err);
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

  const typeLabel = server.config.command ? "stdio" : "http";

  return (
    <div className="border border-border rounded-lg p-4 bg-card">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-medium text-foreground truncate">{server.name}</h3>
            <span className="text-xs px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground">
              {typeLabel}
            </span>
            {!server.enabled && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
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
        </div>
        <div className="flex items-center gap-2">
          <Switch checked={server.enabled} onCheckedChange={handleToggle} />
          <Button variant="ghost" size="icon" onClick={() => onEdit(server)}>
            <Pencil className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={handleDelete}>
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      </div>
    </div>
  );
}
