# Mymux Companion

Cross-platform mobile companion app for attaching to existing Mymux terminal sessions.

## Current state

- Expo Router app scaffold for Android and iOS.
- Session and tab UI with draggable tab ordering, session-to-tab movement, and per-session agent-list folding. Tab order and active tab are saved on-device.
- The session screen starts empty and clearly indicates connection state; it does not show fabricated sessions. Camera-based pairing QR scanning and strict LAN payload validation are implemented, along with SecureStore helpers for approved device credentials.
- The mobile transport client now implements the Noise XX handshake pinned to the QR server key, encrypted JSON RPC, session listing, bounded PTY output polling, terminal input, resize, and explicit session close operations. The session screen lets the user choose among saved desktops, persists that choice, preserves per-session output offsets across reconnects, and renders PTY data in a locally bundled xterm.js WebView with input and resize bridges. A native multiline input remains available for command entry. ANSI interaction is implemented in code but still needs Android/iOS device checks for IME, clipboard, key handling, resize, and app backgrounding.
- The desktop LAN gateway, pairing QR, Noise XX responder, pending-device approval UI, persistent server identity/device approvals, and revocation controls are implemented. The gateway starts only when the desktop user enables it and forwards only the existing mobile PTY RPC allowlist. No live mobile device acceptance has been performed.
- The transport uses `ws://` on validated private LAN addresses; Android permits cleartext networking for that WebSocket carrier, while application RPC data is encrypted by Noise after the handshake. Do not add arbitrary internet hosts to the paired-desktop record.

## Development

```sh
npm install
npx expo start
```

Native package identifiers are fixed to `com.mycli.mymuxcompanion` for Android and iOS. EAS profiles are in `eas.json`: `development` and `preview` produce internal Android APKs, while `production` produces the Android app bundle used for store submission. For example, after linking this app to an Expo account:

```sh
npx eas-cli@latest build --platform android --profile preview
npx eas-cli@latest build --platform ios --profile preview
```

An iOS internal build still requires Apple signing credentials. These profiles prepare the build; they do not constitute a completed signed build or device acceptance.

The xterm.js WebView bundle is committed as a local app asset. After changing the xterm or fit-addon versions, regenerate it with `npm run build:terminal`.

Expo SDK 58 requires its matching native toolchain for local Android/iOS builds. The Noise module targets iOS 18+ and Android API 33+; use a development build for native modules. Android currently enables cleartext networking globally to carry `ws://` on a private LAN; Noise encrypts RPC payloads, and the desktop identity is pinned during pairing. Narrow this manifest permission to the specific transport if the networking stack supports it.

## Product direction

See [`../docs/superpowers/specs/2026-11-09-mobile-companion-design.md`](../docs/superpowers/specs/2026-11-09-mobile-companion-design.md) for the LAN-first pairing and session-reattachment design.
