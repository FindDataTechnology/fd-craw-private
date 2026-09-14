// Preview drawer (openspec: file-preview-drawer).
//
// Loaded lazily on first open — App mounts it through React.lazy behind the
// store's "is anything open" flag — and rendered as a fixed right-hand overlay,
// so opening it never unmounts the chat or its socket.
//
// Anything that renders authored markup (an HTML file, the docx renderer's
// output, an external preview service) goes inside a sandboxed <iframe> with no
// allow-same-origin: an opaque origin that cannot reach this app, its storage,
// or its WebSocket credentials.
//
// Every type that has no renderer — and every renderer that fails — ends at the
// same download action. There is deliberately no "error" state: a file the
// drawer cannot show is still a file the user can have.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, X } from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { usePreviewStore, type PreviewTarget } from "@/hooks/usePreviewStore";
import { baseName, kindOf } from "@/lib/file-preview";

const DOCX_STYLE =
  "body{font-family:system-ui,sans-serif;line-height:1.6;color:#111;background:#fff;margin:0;padding:24px}" +
  "img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px}";

export default function PreviewDrawer() {
  const { t } = useTranslation();
  const target = usePreviewStore((s) => s.target);
  const close = usePreviewStore((s) => s.close);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [close]);

  if (!target) return null;

  return (
    <aside
      data-testid="preview-drawer"
      aria-label={t("preview.title")}
      className="fixed inset-y-0 right-0 z-40 flex w-full max-w-2xl animate-in flex-col border-l border-border bg-background shadow-xl slide-in-from-right"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-2">
        <span data-testid="preview-name" className="min-w-0 flex-1 truncate text-sm font-medium">
          {target.name}
        </span>
        <a
          href={target.url}
          download={target.name}
          data-testid="preview-download"
          aria-label={t("preview.download")}
          title={t("preview.download")}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Download className="h-4 w-4" aria-hidden="true" />
        </a>
        <button
          type="button"
          onClick={close}
          data-testid="preview-close"
          aria-label={t("preview.close")}
          title={t("preview.close")}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        <Renderer target={target} />
      </div>
    </aside>
  );
}

function Renderer({ target }: { target: PreviewTarget }) {
  switch (kindOf(target.name)) {
    case "image":
      return (
        <img
          src={target.url}
          alt={target.name}
          data-testid="preview-image"
          className="mx-auto max-w-full p-4"
        />
      );
    case "pdf":
      return (
        <iframe
          src={target.url}
          title={target.name}
          data-testid="preview-pdf"
          className="h-full w-full"
        />
      );
    case "text":
      return <TextPreview target={target} markdown={false} />;
    case "markdown":
      return <TextPreview target={target} markdown />;
    case "csv":
      return <CsvPreview target={target} />;
    case "html":
      return <HtmlPreview target={target} />;
    case "docx":
      return <DocxPreview target={target} />;
    default:
      return <DownloadOnly target={target} />;
  }
}

// Shared fetch for the text-shaped renderers. A failed fetch is not an error
// state — it falls back to the download action like any unrenderable type.
function useText(target: PreviewTarget): { text: string | null; failed: boolean } {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setText(null);
    setFailed(false);
    fetch(target.url)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.text();
      })
      .then((v) => live && setText(v))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [target.url]);
  return { text, failed };
}

function TextPreview({ target, markdown }: { target: PreviewTarget; markdown: boolean }) {
  const { text, failed } = useText(target);
  if (failed) return <DownloadOnly target={target} />;
  if (text === null) return <Loading />;
  if (markdown)
    return (
      <div className="p-4" data-testid="preview-markdown">
        <Markdown text={text} />
      </div>
    );
  return (
    <pre
      data-testid="preview-text"
      className="whitespace-pre-wrap break-words p-4 font-mono text-xs"
    >
      {text}
    </pre>
  );
}

// Minimal RFC4180-ish parser: quoted fields, escaped quotes, CRLF. Handles the
// quoted-comma case a naive split(",") gets wrong.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (c !== "\r") cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function CsvPreview({ target }: { target: PreviewTarget }) {
  const { text, failed } = useText(target);
  if (failed) return <DownloadOnly target={target} />;
  if (text === null) return <Loading />;
  const rows = parseCsv(text);
  const [head, ...body] = rows;
  return (
    <div className="overflow-auto p-4" data-testid="preview-csv">
      <table className="min-w-full border-collapse text-xs">
        {head && (
          <thead>
            <tr>
              {head.map((c, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a CSV row is positional and never reorders
                <th key={i} className="border border-border bg-muted px-2 py-1 text-left font-semibold">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {body.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a CSV row is positional and never reorders
            <tr key={i}>
              {r.map((c, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a CSV cell is positional and never reorders
                <td key={j} className="border border-border px-2 py-1">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HtmlPreview({ target }: { target: PreviewTarget }) {
  const { text, failed } = useText(target);
  if (failed) return <DownloadOnly target={target} />;
  if (text === null) return <Loading />;
  return <Sandbox html={text} title={target.name} testId="preview-html" />;
}

function DocxPreview({ target }: { target: PreviewTarget }) {
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setHtml(null);
    setFailed(false);
    (async () => {
      // mammoth's browser build turns the .docx into an HTML string, which then
      // renders in the same sandbox as an HTML file rather than in this DOM.
      const [mammoth, buffer] = await Promise.all([
        import("mammoth"),
        fetch(target.url).then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          return r.arrayBuffer();
        }),
      ]);
      const { value } = await mammoth.convertToHtml({ arrayBuffer: buffer });
      if (live) setHtml(value);
    })().catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [target.url]);
  if (failed) return <DownloadOnly target={target} />;
  if (html === null) return <Loading />;
  return (
    <Sandbox
      html={`<!doctype html><meta charset="utf-8"><style>${DOCX_STYLE}</style>${html}`}
      title={target.name}
      testId="preview-docx"
    />
  );
}

// The single sandbox policy for active content. allow-scripts WITHOUT
// allow-same-origin is the load-bearing combination: scripts may run, but in an
// opaque origin that has no access to this app's origin, storage, or socket.
function Sandbox({ html, title, testId }: { html: string; title: string; testId: string }) {
  return (
    <iframe
      srcDoc={html}
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      data-testid={testId}
      className="h-full w-full"
    />
  );
}

function Loading() {
  const { t } = useTranslation();
  return <div className="p-4 text-sm text-muted-foreground">{t("preview.loading")}</div>;
}

// The universal terminal state: no renderer (or a renderer that failed). Offers
// the file, never an apology.
function DownloadOnly({ target }: { target: PreviewTarget }) {
  const { t } = useTranslation();
  const [external, setExternal] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    // A catalog external-service tagged for file preview can render long-tail
    // formats (legacy Office, media, archives) by fetching the file itself.
    // Absent or unreachable, the drawer simply stays on the download action.
    fetch("/api/catalog")
      .then((r) => (r.ok ? r.json() : null))
      .then((cat) => {
        const svc = cat?.apps?.find(
          (a: { kind?: string; tags?: string[] }) =>
            a.kind === "external-service" && a.tags?.includes("file-preview"),
        );
        if (!live || !svc) return;
        const absolute = new URL(target.url, window.location.origin).href;
        setExternal(`/external/${svc.id}?url=${encodeURIComponent(absolute)}`);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [target.url]);

  if (external) {
    return (
      <iframe
        src={external}
        title={target.name}
        data-testid="preview-external"
        className="h-full w-full"
      />
    );
  }

  return (
    <div className="flex flex-col items-center gap-3 p-8 text-center">
      <p className="text-sm text-muted-foreground">{t("preview.noRenderer")}</p>
      <a
        href={target.url}
        download={target.name}
        data-testid="preview-fallback-download"
        className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
      >
        <Download className="h-4 w-4" aria-hidden="true" />
        {t("preview.downloadName", { name: baseName(target.name) })}
      </a>
    </div>
  );
}
