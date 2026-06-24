# Releasing Mymux

Mymux ships as a desktop app with **auto-update**: an installed app checks
GitHub Releases on startup and reveals an **⬆ 업데이트** button when a newer,
correctly-signed version exists.

- **Windows / Linux** installers are built automatically by GitHub Actions
  (`.github/workflows/release.yml`) when you push a version tag.
- **macOS** is built and uploaded manually from a Mac (see below).

## 0. Keep versions in sync

Every release **must** use the same version in all of these:

| File | Field |
| --- | --- |
| `crates/mycli-desktop/tauri.conf.json` | `"version"` |
| `crates/mycli-desktop/Cargo.toml` | `version` |
| git tag | `vX.Y.Z` |

The auto-updater compares the running app's version against `latest.json`, so a
mismatch breaks update detection.

## 1. One-time setup — signing secrets (required)

Auto-update artifacts are signed with a minisign key. The **public** key is
already committed in `tauri.conf.json` (`plugins.updater.pubkey`). The
**private** key must be stored as GitHub repository secrets so the workflow can
sign builds.

Set these two secrets (Repo → Settings → Secrets and variables → Actions), or
via the CLI after `gh auth login`:

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY < mymux_updater.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --body ""
```

- `TAURI_SIGNING_PRIVATE_KEY` — the full contents of the private key file.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the key password (empty for this key).

> ⚠️ Keep the private key safe and backed up. If it is lost, you can no longer
> sign updates and installed apps will stop accepting new versions.

## 2. Release Windows / Linux (automatic)

```bash
# After bumping the version in the two files above and committing:
git tag v0.2.0
git push origin v0.2.0
```

The workflow builds `.msi` / `.exe` (Windows) and `.deb` / `.AppImage` (Linux),
signs the updater artifacts, generates `latest.json`, and publishes a **draft**
GitHub Release. Review it, then click **Publish**.

## 3. Release macOS (manual, on a Mac)

Build with the **same** signing key so the update verifies:

```bash
# Apple Silicon + Intel universal build
rustup target add aarch64-apple-darwin x86_64-apple-darwin

export TAURI_SIGNING_PRIVATE_KEY="$(cat mymux_updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""

cargo install tauri-cli --version "^2"   # first time only
cargo tauri build --target universal-apple-darwin
```

Output lands in
`target/universal-apple-darwin/release/bundle/`:

- `dmg/Mymux_0.2.0_universal.dmg` — the installer to upload.
- `macos/Mymux.app.tar.gz` — the updater archive.
- `macos/Mymux.app.tar.gz.sig` — its signature.

Then:

1. Upload the `.dmg`, `.app.tar.gz`, and `.app.tar.gz.sig` to the **same**
   GitHub Release created in step 2.
2. Add the macOS entries to that release's `latest.json` so Mac users get the
   update. Add a `darwin-aarch64` and `darwin-x86_64` block under `platforms`,
   each pointing at the uploaded `.app.tar.gz` URL with the `.sig` contents as
   `signature`. Example:

   ```json
   "darwin-aarch64": {
     "signature": "<contents of Mymux.app.tar.gz.sig>",
     "url": "https://github.com/ChoiGyber/MyCli/releases/download/v0.2.0/Mymux.app.tar.gz"
   },
   "darwin-x86_64": {
     "signature": "<same .sig contents>",
     "url": "https://github.com/ChoiGyber/MyCli/releases/download/v0.2.0/Mymux.app.tar.gz"
   }
   ```

> Tip: if you'd rather have CI build macOS too (no manual signing/`latest.json`
> editing), add a `- platform: macos-latest` entry back to the matrix in
> `release.yml` with `args: "--target universal-apple-darwin"`.
