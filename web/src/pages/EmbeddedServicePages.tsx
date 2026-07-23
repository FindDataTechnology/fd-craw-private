// Embedded service views: OpenConnector + LiteLLM shown as same-origin iframes.
// Both are third-party projects with their own native UIs - we embed, not
// reimplement. Tokens are injected server-side by the /oc-web (and /litellm-web)
// proxies; no secrets reach this renderer.
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface Config {
  openconnectorEnabled?: boolean;
  litellmEnabled?: boolean;
  litellmManagementUrl?: string | null;
}

function useConfig() {
  const [config, setConfig] = useState<Config | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/config")
      .then((r) => r.json())
      .then((c) => { if (!cancelled) setConfig(c); })
      .catch(() => { if (!cancelled) setConfig({}); });
    return () => { cancelled = true; };
  }, []);
  return config;
}

function EmbeddedFrame({ src, testId }: { src: string; testId: string }) {
  const [blocked, setBlocked] = useState(false);
  // If the iframe hasn't loaded successfully after a few seconds, offer a
  // fallback "open in new tab" link (handles X-Frame-Options / CSP blocks).
  // Track load state in a ref so the timeout only fires the overlay when onLoad
  // has NOT yet fired - otherwise a fast-loading iframe would be covered by the
  // overlay at 5s (the unconditional timer used to re-block after onLoad).
  const loadedRef = useRef(false);
  useEffect(() => {
    loadedRef.current = false;
    setBlocked(false);
    const t = setTimeout(() => {
      if (!loadedRef.current) setBlocked(true);
    }, 5000);
    return () => clearTimeout(t);
  }, [src]);
  return (
    <div className="relative flex-1">
      <iframe
        src={src}
        data-testid={testId}
        className="h-full w-full border-0"
        title="embedded-service"
        onLoad={() => {
          loadedRef.current = true;
          setBlocked(false);
        }}
      />
      {blocked && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80" data-testid="iframe-blocked">
          <div className="text-center">
            <p className="text-sm text-muted-foreground">The embedded UI could not be loaded in a frame.</p>
            <a href={src} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted">
              Open in new tab
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

export function OpenConnectorPage() {
  const config = useConfig();
  if (!config) return <div className="p-6 text-muted-foreground">Loading…</div>;
  if (!config.openconnectorEnabled) {
    return <Placeholder title="OpenConnector" testId="openconnector-disabled" message="OpenConnector is not configured." />;
  }
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="openconnector-page">
      <EmbeddedFrame src="/oc-web" testId="openconnector-iframe" />
    </main>
  );
}

function useLitellmCredentials(enabled?: boolean) {
  const [creds, setCreds] = useState<{ masterKey: string | null }>({ masterKey: null });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetch("/api/litellm/credentials")
      .then((r) => r.json())
      .then((c) => { if (!cancelled) setCreds(c); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [enabled]);
  return creds;
}

export function LiteLLMPage() {
  const config = useConfig();
  const creds = useLitellmCredentials(config?.litellmEnabled);
  const [copied, setCopied] = useState(false);
  if (!config) return <div className="p-6 text-muted-foreground">Loading…</div>;
  if (!config.litellmEnabled || !config.litellmManagementUrl) {
    return <Placeholder title="LiteLLM" testId="litellm-disabled" message="LiteLLM is not configured." />;
  }
  // The LiteLLM management dashboard is a Next.js SPA with an interactive login
  // flow that the server-side token-injecting proxy cannot satisfy, so the view
  // links to the management UI (litellmManagementUrl) which the user opens in a
  // new tab. For the LOCAL bundled proxy the master key is auto-generated, so we
  // surface it here for the user to copy into the dashboard's sign-in. For a
  // remote proxy the user has their own credentials (no key is exposed).
  const copyKey = async () => {
    try {
      await navigator.clipboard.writeText(creds.masterKey || "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  };
  return (
    <main
      className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3 p-6"
      data-testid="litellm-page"
    >
      <h1 className="text-2xl font-semibold">LiteLLM</h1>
      <p className="max-w-md text-center text-sm text-muted-foreground">
        Open the LiteLLM management dashboard in a new tab and sign in.
      </p>
      {creds.masterKey ? (
        <div className="w-full max-w-md rounded-md border border-border p-3 text-sm" data-testid="litellm-master-key">
          <p className="mb-1 text-muted-foreground">Local proxy master key — paste this into the dashboard sign-in:</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded bg-muted px-2 py-1 text-xs">{creds.masterKey}</code>
            <button
              onClick={copyKey}
              className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
              data-testid="litellm-copy-key"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      ) : (
        <p className="max-w-md text-center text-xs text-muted-foreground">
          Sign in with your LiteLLM credentials.
        </p>
      )}
      <a
        href={config.litellmManagementUrl}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="litellm-open-link"
        className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted"
      >
        Open LiteLLM dashboard ↗
      </a>
    </main>
  );
}

function Placeholder({ title, message, testId }: { title: string; message: string; testId: string }) {
  return (
    <main className={cn("flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center p-6")}>
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="mt-2 text-muted-foreground" data-testid={testId}>{message}</p>
    </main>
  );
}
