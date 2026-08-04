// McpServerForm.tsx
// Modal form for adding/editing MCP server configurations.

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { McpServer } from "@/lib/extensions-api";
import { useExtensionsStore } from "@/hooks/useExtensionsStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

interface McpServerFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  server?: McpServer | null;
  initialConfig?: McpServer["config"] | null;
}

export function McpServerForm({ open, onOpenChange, server, initialConfig }: McpServerFormProps) {
  const { t } = useTranslation();
  const { addMcpServer, updateMcpServer } = useExtensionsStore();

  const isEdit = !!server;
  const [name, setName] = useState("");
  const [type, setType] = useState<"stdio" | "http">("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (server) {
      setName(server.name);
      setType(server.config.command ? "stdio" : "http");
      setCommand(server.config.command || "");
      setArgs(server.config.args?.join(" ") || "");
      setEnv(JSON.stringify(server.config.env || {}, null, 2));
      setUrl(server.config.url || "");
      setHeaders(JSON.stringify(server.config.headers || {}, null, 2));
      setEnabled(server.enabled);
    } else if (initialConfig) {
      setName("");
      setType(initialConfig.command ? "stdio" : "http");
      setCommand(initialConfig.command || "");
      setArgs(initialConfig.args?.join(" ") || "");
      setEnv(JSON.stringify(initialConfig.env || {}, null, 2));
      setUrl(initialConfig.url || "");
      setHeaders(JSON.stringify(initialConfig.headers || {}, null, 2));
      setEnabled(true);
    } else {
      setName("");
      setType("stdio");
      setCommand("");
      setArgs("");
      setEnv("{}");
      setUrl("");
      setHeaders("{}");
      setEnabled(true);
    }
    setError("");
  }, [server, initialConfig, open]);

  const handleSubmit = async () => {
    setError("");
    if (!name.trim()) {
      setError(t("extensions.mcp.errors.nameRequired"));
      return;
    }

    let config: McpServer["config"];
    if (type === "stdio") {
      if (!command.trim()) {
        setError(t("extensions.mcp.errors.commandRequired"));
        return;
      }
      let envObj = {};
      try {
        envObj = env.trim() ? JSON.parse(env) : {};
      } catch {
        setError(t("extensions.mcp.errors.envInvalid"));
        return;
      }
      config = {
        command: command.trim(),
        args: args.trim().split(/\s+/).filter(Boolean),
        env: envObj,
      };
    } else {
      if (!url.trim()) {
        setError(t("extensions.mcp.errors.urlRequired"));
        return;
      }
      let headersObj = {};
      try {
        headersObj = headers.trim() ? JSON.parse(headers) : {};
      } catch {
        setError(t("extensions.mcp.errors.headersInvalid"));
        return;
      }
      config = {
        url: url.trim(),
        headers: headersObj,
      };
    }

    setLoading(true);
    try {
      if (isEdit) {
        await updateMcpServer(server!.name, config, enabled);
      } else {
        await addMcpServer(name.trim(), config, enabled);
      }
      onOpenChange(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t("extensions.mcp.editTitle") : t("extensions.mcp.addTitle")}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {error && (
            <div className="bg-destructive/10 text-destructive px-3 py-2 rounded-md text-sm">
              {error}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="name">{t("extensions.mcp.fields.name")}</Label>
            <Input
              id="name"
              value={name}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
              disabled={isEdit}
              placeholder="my-mcp-server"
            />
          </div>

          <div className="space-y-2">
            <Label>{t("extensions.mcp.fields.type")}</Label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={type === "stdio"}
                  onChange={() => setType("stdio")}
                  disabled={isEdit}
                />
                <span className="text-sm">stdio</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={type === "http"}
                  onChange={() => setType("http")}
                  disabled={isEdit}
                />
                <span className="text-sm">http</span>
              </label>
            </div>
          </div>

          {type === "stdio" ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="command">{t("extensions.mcp.fields.command")}</Label>
                <Input
                  id="command"
                  value={command}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCommand(e.target.value)}
                  placeholder="npx"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="args">{t("extensions.mcp.fields.args")}</Label>
                <Input
                  id="args"
                  value={args}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setArgs(e.target.value)}
                  placeholder="-y @modelcontextprotocol/server-memory"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="env">{t("extensions.mcp.fields.env")}</Label>
                <Textarea
                  id="env"
                  value={env}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setEnv(e.target.value)}
                  rows={4}
                  className="font-mono text-xs"
                  placeholder='{"API_KEY": "value"}'
                />
              </div>
            </>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="url">{t("extensions.mcp.fields.url")}</Label>
                <Input
                  id="url"
                  value={url}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setUrl(e.target.value)}
                  placeholder="https://example.com/mcp"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="headers">{t("extensions.mcp.fields.headers")}</Label>
                <Textarea
                  id="headers"
                  value={headers}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setHeaders(e.target.value)}
                  rows={4}
                  className="font-mono text-xs"
                  placeholder='{"Authorization": "Bearer token"}'
                />
              </div>
            </>
          )}

          <div className="flex items-center gap-2">
            <Switch id="enabled" checked={enabled} onCheckedChange={setEnabled} />
            <Label htmlFor="enabled">{t("extensions.fields.enabled")}</Label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={loading}>
            {loading ? t("common.saving") : isEdit ? t("common.save") : t("common.add")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
