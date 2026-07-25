// scripts/sign-postgres.cjs - electron-builder afterPack hook.
// Codesign the bundled Postgres binaries + dylibs on mac so a Hardened-Runtime /
// notarized app bundle remains valid (unsigned children are rejected). No-op on
// non-mac platforms and when CSC_LINK is unset (unsigned builds).
//
// Best-effort ad-hoc signing (`--sign -`) for now - same status as the bundled
// standalone Node (see electron-builder.yml mac TODO). Full Developer-ID signing
// of these children for notarization is a follow-up when certs are provisioned.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

module.exports.default = async function (context) {
  if (context.electronPlatformName !== "darwin") return;
  if (!process.env.CSC_LINK) {
    console.log("[sign-postgres] CSC_LINK unset - skipping (unsigned build)");
    return;
  }
  const resDir = path.join(context.appOutDir, "Contents", "Resources", "postgres");
  if (!fs.existsSync(resDir)) {
    console.log("[sign-postgres] no bundled postgres - skipping");
    return;
  }
  const targets = [];
  for (const b of ["postgres", "initdb", "pg_ctl", "createdb"]) {
    const p = path.join(resDir, "bin", b);
    if (fs.existsSync(p)) targets.push(p);
  }
  const libDir = path.join(resDir, "lib", "postgresql");
  if (fs.existsSync(libDir)) {
    for (const f of fs.readdirSync(libDir)) {
      if (f.endsWith(".dylib")) targets.push(path.join(libDir, f));
    }
  }
  for (const t of targets) {
    execFileSync("codesign", ["--force", "--options", "runtime", "--sign", "-", "--timestamp", t], { stdio: "inherit" });
  }
  console.log(`[sign-postgres] signed ${targets.length} postgres binaries/dylibs (ad-hoc)`);
};
