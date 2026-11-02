// Add the macOS updater archive to a release's latest.json.
// Usage: node scripts/add-macos-updater.mjs <latest.json> <Mymux.app.tar.gz.sig> <archive-url> <tag>
//
// The Windows/Linux release job (tauri-action) writes latest.json without any
// darwin entry, so an installed Mac app never sees a newer version. The
// universal archive serves both Apple Silicon and Intel, so every darwin key
// points at the same url/signature. Other platforms are left untouched.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

const [manifestPath, sigPath, url, tag] = process.argv.slice(2);
assert.ok(manifestPath && sigPath && url && tag, "usage: add-macos-updater.mjs <latest.json> <sig> <url> <tag>");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
// A manifest for another version would make Mac apps install this build under
// the wrong version number (or skip it), so refuse instead of patching it.
assert.equal(manifest.version, tag.replace(/^v/, ""), `latest.json is for ${manifest.version}, not ${tag}`);
const signature = readFileSync(sigPath, "utf8").trim();
assert.ok(signature, "empty updater signature");

manifest.platforms ??= {};
// The updater looks up `<os>-<arch>-<installer>` first, then `<os>-<arch>`.
for (const key of ["darwin-aarch64", "darwin-aarch64-app", "darwin-x86_64", "darwin-x86_64-app"]) {
  manifest.platforms[key] = { signature, url };
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`latest.json ${manifest.version}: ${Object.keys(manifest.platforms).join(", ")}`);
