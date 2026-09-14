// Helpers shared by the preview drawer and its entry points: deciding which
// renderer a file gets, building the route URL the server resolves against an
// allowlisted root, and turning a tool argument or link into such a reference.

export type PreviewKind =
  | "image"
  | "pdf"
  | "text"
  | "markdown"
  | "csv"
  | "html"
  | "docx"
  | "none";

const EXT_KIND: Record<string, PreviewKind> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  svg: "image",
  ico: "image",
  pdf: "pdf",
  txt: "text",
  log: "text",
  md: "markdown",
  markdown: "markdown",
  csv: "csv",
  html: "html",
  htm: "html",
  docx: "docx",
};

export type Root = "workspace" | "uploads";
export interface FileRef {
  root: Root;
  rel: string;
}

export function extOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name.trim());
  return m?.[1]?.toLowerCase() ?? "";
}

export function kindOf(name: string): PreviewKind {
  return EXT_KIND[extOf(name)] ?? "none";
}

export function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

export function fileUrl(root: Root, rel: string): string {
  return `/api/files?root=${root}&path=${encodeURIComponent(rel)}`;
}

// A path from a tool argument or a link → a route reference, or null when it is
// not addressable: a URL, or an absolute path outside the agent workspace (the
// only absolute root the server knows is the workspace).
export function resolveRef(input: string, workspace: string | null): FileRef | null {
  const raw = input.trim().replace(/^["'`]|["'`]$/g, "");
  if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.includes("\0")) return null;
  if (raw.startsWith("/")) {
    if (!workspace) return null;
    const ws = workspace.replace(/\/+$/, "");
    if (raw === ws || !raw.startsWith(`${ws}/`)) return null;
    return { root: "workspace", rel: raw.slice(ws.length + 1) };
  }
  const rel = raw.replace(/^\.\//, "");
  if (!rel || rel.startsWith("../") || rel === "..") return null;
  return { root: "workspace", rel };
}

// The href of an anchor in assistant text → a reference, when the anchor is a
// file the route can serve. Our own route links are taken verbatim; a relative
// path with a known preview extension is treated as a workspace file so a model
// that writes `[report](report.pdf)` still opens the drawer.
export function linkRef(href: string | undefined, workspace: string | null): FileRef | null {
  if (!href) return null;
  if (href.startsWith("/api/files?")) {
    const q = new URLSearchParams(href.slice(href.indexOf("?") + 1));
    const root = q.get("root");
    const rel = q.get("path");
    if ((root === "workspace" || root === "uploads") && rel) return { root, rel };
    return null;
  }
  if (kindOf(href) === "none") return null;
  return resolveRef(href, workspace);
}

// Tool-call arguments and results both name files; the first plausible path is
// what the preview action offers.
const PATH_KEYS = ["path", "file_path", "filepath", "file", "filename", "output", "target"];
const PATH_RE =
  /(?:^|[\s"'`[(=:])((?:\.{1,2}\/|~?\/)?[\w./-]*[\w-]\.(?:png|jpe?g|gif|webp|bmp|svg|ico|pdf|txt|log|md|markdown|csv|html?|docx|xlsx?|doc|pptx?|json|ya?ml|xml|zip))/i;

export function findFilePath(args: unknown, result: unknown): string | null {
  if (args && typeof args === "object") {
    for (const k of PATH_KEYS) {
      const v = (args as Record<string, unknown>)[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  for (const src of [result, args]) {
    if (typeof src !== "string") continue;
    const m = PATH_RE.exec(src);
    if (m?.[1]) return m[1];
  }
  return null;
}
