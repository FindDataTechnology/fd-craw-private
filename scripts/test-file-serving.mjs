// Tests for the preview drawer's file-serving route (openspec:
// file-preview-drawer, tasks 7.1-7.3). The route is the only place the app
// hands arbitrary bytes to the browser, so these assert the safety properties
// rather than the happy path alone: traversal is rejected without reading
// anything outside the root, and content that could execute in this origin is
// forced to a download.

import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// UPLOADS_DIR is read from PLATFORM_DATA_DIR at import time by paths.js, so set
// it before importing the route (a dev machine's ./uploads must not be touched).
const DATA_DIR = await mkdtemp(path.join(tmpdir(), "file-preview-data-"));
process.env.PLATFORM_DATA_DIR = DATA_DIR;
const { registerFileRoutes, UPLOADS_DIR, saveUploadFile } = await import(
  "../server/routes/files.js"
);

function request(app, path_, headers = {}) {
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.unref();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const req = httpRequest({ host: "127.0.0.1", port, path: path_, headers }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      });
      req.on("error", reject);
      req.end();
    });
    server.on("error", reject);
  });
}

async function appWith(workspace) {
  const express = (await import("express")).default;
  const app = express();
  registerFileRoutes({ app, dshBridge: { getCwd: () => workspace } });
  return app;
}

const file = (root, rel) => `/api/files?root=${root}&path=${encodeURIComponent(rel)}`;

test("serves a file inside the workspace", async () => {
  const ws = await mkdtemp(path.join(tmpdir(), "ws-"));
  await writeFile(path.join(ws, "hello.txt"), "hi there");
  const app = await appWith(ws);

  const res = await request(app, file("workspace", "hello.txt"));
  assert.equal(res.status, 200);
  assert.equal(res.body.toString(), "hi there");
  assert.equal(res.headers["content-type"], "text/plain; charset=utf-8");
  assert.match(res.headers["content-disposition"], /^inline;/);
});

test("rejects traversal, absolute paths, and escaping symlinks without reading outside the root", async () => {
  const ws = await mkdtemp(path.join(tmpdir(), "ws-"));
  const outside = await mkdtemp(path.join(tmpdir(), "outside-"));
  await writeFile(path.join(outside, "secret.txt"), "TOP SECRET");
  await writeFile(path.join(ws, "ok.txt"), "fine");
  // A symlink that lives inside the root but points out of it.
  await symlink(path.join(outside, "secret.txt"), path.join(ws, "escape.txt"));
  const app = await appWith(ws);

  const traversal = await request(app, file("workspace", "../" + path.basename(outside) + "/secret.txt"));
  assert.equal(traversal.status, 403);
  assert.ok(!traversal.body.toString().includes("TOP SECRET"));

  // Deep traversal against a path that does not exist must also be 403, not 404.
  const deep = await request(app, file("workspace", "../../../../etc/passwd"));
  assert.equal(deep.status, 403);

  const absolute = await request(app, file("workspace", path.join(outside, "secret.txt")));
  assert.equal(absolute.status, 403);
  assert.ok(!absolute.body.toString().includes("TOP SECRET"));

  const escapingLink = await request(app, file("workspace", "escape.txt"));
  assert.equal(escapingLink.status, 403);
  assert.ok(!escapingLink.body.toString().includes("TOP SECRET"));

  // The in-root file still serves, so the rejections are the check working.
  assert.equal((await request(app, file("workspace", "ok.txt"))).status, 200);
});

test("a missing file inside the root is 404", async () => {
  const ws = await mkdtemp(path.join(tmpdir(), "ws-"));
  const app = await appWith(ws);
  assert.equal((await request(app, file("workspace", "nope.txt"))).status, 404);
});

test("HTML and unknown types are forced to download, not served inline", async () => {
  const ws = await mkdtemp(path.join(tmpdir(), "ws-"));
  await writeFile(path.join(ws, "evil.html"), "<script>alert(document.cookie)</script>");
  await writeFile(path.join(ws, "thing.bin"), "opaque");
  const app = await appWith(ws);

  for (const name of ["evil.html", "thing.bin"]) {
    const res = await request(app, file("workspace", name));
    assert.equal(res.status, 200, name);
    assert.match(res.headers["content-disposition"], /^attachment;/, name);
    assert.equal(res.headers["content-type"], "application/octet-stream", name);
  }
});

test("uploads root serves files written by saveUploadFile", async () => {
  const stored = await saveUploadFile(Buffer.from("uploaded bytes"), "my report.csv");
  const app = await appWith(await mkdtemp(path.join(tmpdir(), "ws-")));

  const res = await request(app, file(stored.root, stored.path));
  assert.equal(res.status, 200);
  assert.equal(res.body.toString(), "uploaded bytes");
  // CSV is not an inline type: the client fetches it for the table renderer,
  // which a download disposition does not block.
  assert.match(res.headers["content-disposition"], /^attachment;/);
  assert.ok(UPLOADS_DIR.startsWith(DATA_DIR));
});

test("an unknown root is rejected", async () => {
  const ws = await mkdtemp(path.join(tmpdir(), "ws-"));
  const app = await appWith(ws);
  await mkdir(path.join(ws, "sub"));
  assert.equal((await request(app, file("etc", "passwd"))).status, 403);
});
