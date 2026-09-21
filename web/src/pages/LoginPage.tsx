import { LogIn, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router-dom";
import { useAuthStore, withReturnTo } from "@/hooks/useAuth";
import { useBranding } from "@/hooks/useAppConfig";

export function LoginPage() {
  const { t } = useTranslation();
  const { brand } = useBranding();
  const auth = useAuthStore();
  const [searchParams] = useSearchParams();
  const authError = searchParams.get("auth_error");
  const loginUrl = withReturnTo(auth.loginUrl, window.location.href);

  return (
    <main className="flex h-dvh items-center justify-center bg-background p-6" data-testid="login-page">
      <section className="w-full max-w-md rounded-lg border border-border bg-card p-8 shadow-lg">
        <div className="mb-6 flex items-center gap-3 text-primary-deep">
          <ShieldCheck className="h-8 w-8" aria-hidden="true" />
          <h1 className="text-xl font-semibold text-foreground">{t("login.title")}</h1>
        </div>
        <p className="text-sm leading-6 text-muted-foreground">
          {auth.mode === "none" ? t("settings.account.optionalSsoHint") : t("login.description", { brand })}
        </p>
        {authError && (
          <p className="mt-4 rounded-md border border-destructive bg-destructive/10 p-3 text-xs text-destructive" role="alert">
            {t(authError === "state" ? "login.stateError" : "login.callbackError")}
          </p>
        )}
        {auth.error && (
          <p className="mt-4 rounded-md border border-destructive bg-destructive/10 p-3 text-xs text-destructive" role="alert">
            {t("login.loadFailed", { error: auth.error })}
          </p>
        )}
        <a
          href={loginUrl}
          data-testid="sso-login"
          className="mt-6 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary-deep px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-deep/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <LogIn className="h-4 w-4" aria-hidden="true" />
          {t("login.action")}
        </a>
        {auth.mode === "none" && (
          <Link
            to="/chat"
            data-testid="login-continue-anonymous"
            className="mt-3 block text-center text-xs text-muted-foreground hover:text-foreground"
          >
            {t("bindings.continueAnonymous")}
          </Link>
        )}
      </section>
    </main>
  );
}
