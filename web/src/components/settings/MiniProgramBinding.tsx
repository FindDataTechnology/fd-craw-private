// WeChat mini-program binding block (account settings). Mints a single-use
// 6-digit bind code from THIS authenticated web session; the user types it
// once on the mini-program login page, pairing their WeChat openid with the
// account (see the miniprogram-auth spec). Only gateway deployments expose
// the endpoint — anywhere else the block degrades to a muted hint.

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, Smartphone } from "lucide-react";
import { useTranslation } from "react-i18next";

type BindState = "idle" | "loading" | "ready" | "unavailable" | "error";

export function MiniProgramBinding() {
  const { t } = useTranslation();
  const [state, setState] = useState<BindState>("idle");
  const [code, setCode] = useState("");
  const alive = useRef(true);
  useEffect(() => {
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    setState("loading");
    try {
      const r = await fetch("/api/mp/bindcode", {
        headers: { accept: "application/json" },
        credentials: "same-origin",
      });
      const contentType = r.headers.get("content-type") ?? "";
      if (r.status === 404 || r.status === 401 || !contentType.includes("application/json")) {
        // Not a gateway deployment (or not signed in) — no binding path here.
        if (alive.current) setState("unavailable");
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as { code?: string };
      if (!body.code) throw new Error("no code");
      if (alive.current) {
        setCode(body.code);
        setState("ready");
      }
    } catch {
      if (alive.current) setState("error");
    }
  }, []);

  return (
    <div className="rounded-md border border-border bg-background p-3" data-testid="mp-binding">
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Smartphone className="h-4 w-4" aria-hidden="true" />
        {t("settings.account.mp.title")}
      </div>
      {state === "unavailable" ? (
        <p className="mt-2 text-xs leading-5 text-muted-foreground">{t("settings.account.mp.unavailable")}</p>
      ) : state === "ready" ? (
        <>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">{t("settings.account.mp.hint")}</p>
          <div className="mt-2 flex items-center gap-3">
            <span
              className="select-all font-mono text-2xl font-bold tracking-[0.3em] text-foreground"
              data-testid="mp-binding-code"
            >
              {code}
            </span>
            <button
              type="button"
              onClick={refresh}
              className="inline-flex items-center gap-1 rounded-md border border-input px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
              data-testid="mp-binding-refresh"
            >
              <RefreshCw className="h-3 w-3" aria-hidden="true" />
              {t("settings.account.mp.refresh")}
            </button>
          </div>
        </>
      ) : (
        <div className="mt-2 flex flex-col items-start gap-2">
          <p className="text-xs leading-5 text-muted-foreground">{t("settings.account.mp.hint")}</p>
          {(state === "error" || state === "idle") && (
            <button
              type="button"
              onClick={refresh}
              className="inline-flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-xs font-medium text-foreground hover:bg-accent"
              data-testid="mp-binding-get"
            >
              <Smartphone className="h-4 w-4" aria-hidden="true" />
              {state === "error" ? t("settings.account.mp.retry") : t("settings.account.mp.getCode")}
            </button>
          )}
          {state === "loading" && <p className="text-xs text-muted-foreground">{t("settings.account.mp.loading")}</p>}
        </div>
      )}
    </div>
  );
}
