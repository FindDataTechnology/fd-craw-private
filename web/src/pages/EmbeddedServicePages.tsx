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

export function LiteLLMPage() {
  const config = useConfig();
  if (!config) return <div className="p-6 text-muted-foreground">Loading…</div>;
  if (!config.litellmEnabled || !config.litellmManagementUrl) {
    return <Placeholder title="LiteLLM" testId="litellm-disabled" message="LiteLLM is not configured." />;
  }
  // The LiteLLM management dashboard is a Next.js SPA with its own basePath
  // (/ui) and a UI login flow that the server-side token-injecting proxy cannot
  // satisfy (the dashboard requires an interactive sign-in). Embedding it
  // same-origin is therefore unreliable, so the view links to the management UI
  // (litellmManagementUrl) which the user opens in a new tab and signs into
  // directly. The server-held LITELLM_API_KEY is never exposed to the browser.
  return (
    <main
      className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3 p-6"
      data-testid="litellm-page"
    >
      <h1 className="text-2xl font-semibold">LiteLLM</h1>
      <p className="max-w-md text-center text-sm text-muted-foreground">
        Open the LiteLLM management dashboard in a new tab and sign in with your LiteLLM credentials.
      </p>
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
