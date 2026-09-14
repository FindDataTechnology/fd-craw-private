// Read-only file serving for the preview drawer (openspec: file-preview-drawer).
//
// This is the first route that hands arbitrary file bytes to the browser, so
// the safety properties ARE the feature: read-only, an allowlist of two roots,
// and a realpath + prefix check that rejects traversal, absolute paths and
// symlinks that escape their root. Content the browser could execute in this
// origin is never served inline — anything off the safe-type allowlist forces a
// download disposition with an opaque type.

import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { storeDir } from "../../paths.js";

// Uploaded files get their own root, apart from the agent workspace: the agent
// can write the workspace, and a user's upload must not live somewhere the
// agent can overwrite or delete.
export const UPLOADS_DIR = storeDir("uploads");

// Types safe to serve inline. SVG is on the list but pinned down by the CSP
// header below — as an image subresource it is already inert, and the header
// makes it inert for the direct-navigation case too (stored XSS otherwise).
const INLINE_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".bmp", "image/bmp"],
  [".ico", "image/x-icon"],
  [".svg", "image/svg+xml"],
  [".pdf", "application/pdf"],
  [".txt", "text/plain; charset=utf-8"],
  [".log", "text/plain; charset=utf-8"],
]);

// Write a buffer into the uploads root under a collision-free name and return
// the { root, path } reference the serving route resolves. This is the write
// path into the uploads root; it has no HTTP surface yet — the composer still
// indexes attachments for RAG (a non-goal of this change).
export async function saveUploadFile(buffer, filename) {
  await mkdir(UPLOADS_DIR, { recursive: true });
  const safe = path.basename(String(filename || "upload")).replace(/[^\w.-]+/g, "_");
  const name = `${randomUUID()}-${safe}`;
  await writeFile(path.join(UPLOADS_DIR, name), buffer);
  return { root: "uploads", path: name };
}

function rootsFor(ctx) {
  return {
    workspace: ctx.dshBridge?.getCwd?.() || process.cwd(),
    uploads: UPLOADS_DIR,
  };
}

export function registerFileRoutes(ctx) {
  const { app } = ctx;

  app.get("/api/files", async (req, res) => {
    const rel = typeof req.query.path === "string" ? req.query.path : "";
    const rootName = typeof req.query.root === "string" ? req.query.root : "workspace";
    const root = rootsFor(ctx)[rootName];
    // An unknown root, an empty path, a NUL, or an absolute path is a malformed
    // request, not a file — refuse before touching the filesystem.
    if (!root || !rel || rel.includes("\0") || path.isAbsolute(rel)) {
      return res.status(403).end();
    }

    // Lexical containment first, so a `..` attempt is a 403 even when the
    // escaped path does not exist (realpath of a missing file throws ENOENT,
    // which would otherwise be indistinguishable from an honest 404).
    const lexicalRoot = path.resolve(root);
    const lexical = path.resolve(lexicalRoot, rel);
    if (lexical !== lexicalRoot && !lexical.startsWith(lexicalRoot + path.sep)) {
      return res.status(403).end();
    }

    let realRoot;
    let real;
    try {
      realRoot = await realpath(lexicalRoot);
      real = await realpath(lexical);
    } catch {
      return res.status(404).end();
    }
    // Second check, on the resolved path: catches an in-root symlink whose
    // target lies outside the root.
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      return res.status(403).end();
    }

    const info = await stat(real).catch(() => null);
    if (!info?.isFile()) return res.status(404).end();

    const ext = path.extname(real).toLowerCase();
    const inlineType = INLINE_TYPES.get(ext);
    const filename = encodeURIComponent(path.basename(real));
    res.setHeader(
      "Content-Disposition",
      `${inlineType ? "inline" : "attachment"}; filename*=UTF-8''${filename}`,
    );
    if (inlineType) {
      res.type(inlineType);
      if (ext === ".svg") res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    } else {
      res.type("application/octet-stream");
    }
    // sendFile adds Range/ETag/HEAD and keeps the Content-Type already set.
    res.sendFile(real, { dotfiles: "deny" });
  });
}
