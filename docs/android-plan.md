# Qmail on Android: plan

Status: proposal, nothing built yet (2026-11-23).

## The short answer

- **An APK can't be built from the Electron app as it is.** Electron has no Android target, and
  the mail core (`src/core`) needs Node: `net`/`tls` sockets for imapflow and nodemailer,
  `node:sqlite` for the store, `@napi-rs/keyring` for passwords, and `node:http` for the Google
  sign-in redirect.
- **No server is needed.** Like the desktop app, the phone talks straight to each IMAP/SMTP
  server. Only account settings and secrets move from desktop to phone, once, through an
  encrypted file or QR code. Each device keeps its own local cache and syncs it from the mail
  servers.
- **Recommended route:** Capacitor around the existing React renderer, with `src/core` running
  inside nodejs-mobile (option 1 below). It reuses most of the code. It needs a storage and
  secrets layer that can be swapped, and a phone layout.

## What the code already gives us

- The renderer reaches the core through one RPC call, `window.qm.call(method, ...args)`
  (`src/renderer/src/lib.tsx`), plus a few `qm.invoke` channels and `qm.on('changed' | 'sync' |
  'update')` events (`src/preload`). An Android build only has to provide another `window.qm`.
- `src/core/api.ts` is the whole API surface. It already runs outside Electron, since the CLI uses it.
- imapflow, nodemailer and mailparser are pure JS. The only native or Node-version-sensitive
  parts are:
  - `db.ts`: `node:sqlite` (Node 22.5+).
  - `secrets.ts`: `@napi-rs/keyring` (Windows/macOS/Linux builds only).
  - `oauth.ts`: Google sign-in with a loopback `http` listener, which is the desktop-only flow.
  - `sms.ts` (adb) and `thunderbird.ts` (desktop import): these don't apply on a phone and can be dropped there.
- Electron-only renderer channels need phone equivalents or must be hidden: `pickFiles`,
  `fileInfo`, `openAttachment`, `saveAttachment`, `openThread` (popout), `installUpdate`,
  `updateState`, `version`.

## The three routes

| | 1. Capacitor + nodejs-mobile | 2. Capacitor + socket plugin, ported core | 3. Native Kotlin |
|---|---|---|---|
| UI | Reuse React renderer, add a phone layout | Same | Rewrite (Jetpack Compose) |
| Mail core | Reuse `src/core` as-is (Node runs on the phone) | Port imapflow/nodemailer onto a JS socket shim | Rewrite on Jakarta Mail / Android libs |
| Native pieces | SQLite build for Android, Keystore plugin | Same, plus a TCP/TLS plugin with STARTTLS | None special |
| APK size | +~30-50 MB for the Node runtime | Small | Small |
| Background sync / IDLE | Hard (Node runs in the app process) | Hard | Best (WorkManager, foreground service) |
| Risk | nodejs-mobile Node version, native module builds | High: imapflow relies on Node streams, `tls.connect` and socket upgrade; any shim gap breaks sync | Low tech risk, high effort |
| Two codebases to maintain? | No | Partly (forked core) | Yes |
| Rough effort to a usable app* | **3-4 weeks** | 5-8 weeks | 10-14 weeks |

\* Usable means it reads, searches, sends and archives across several accounts, with account
import from the desktop. Push notifications and polish come after that. These are rough
estimates for one developer with agent help.

### 1. Capacitor + nodejs-mobile (recommended)

- `src/core` is bundled with esbuild (as `scripts/build-cli.mjs` already does) and runs in
  nodejs-mobile. The WebView's `window.qm` sends messages over the nodejs-mobile channel to a
  small host on the Node side, which mirrors `src/main/host.ts`.
- **Check first:** which Node version nodejs-mobile ships. Last I knew it tracked Node 18, which
  has no `node:sqlite`. If that is still true, `db.ts` needs a driver it can swap to: either
  better-sqlite3 cross-compiled with nodejs-mobile's native-module build, or a Capacitor SQLite
  plugin reached over the bridge. Both expose the same small query surface `db.ts` uses today.
- Secrets: `secrets.ts` gets a backend interface. Desktop keeps the keyring. Android uses the
  Keystore through a Capacitor secure-storage plugin, called over the bridge.
- Background: version 1 syncs on app open and on pull-to-refresh, plus a WorkManager job every
  15 minutes or so for new-mail notifications. Always-on IMAP IDLE would need a foreground
  service with a permanent notification; that decision can wait. Gmail push needs Google
  Pub/Sub, which means a server, so it is out of scope.
- UI: the renderer is a three-pane desktop layout. Add a narrow-screen layout (list → thread →
  compose as stacked screens, bottom action bar, swipe to archive). Desktop keeps the current
  layout.

### 2. Capacitor + TCP/TLS plugin

This keeps the app small but means shimming `net`/`tls` well enough for imapflow and nodemailer
(streams, backpressure, STARTTLS on port 587/143, timeouts) and keeping a forked core in step.
It costs most of the effort of a rewrite without the background-sync benefits of native code.
Not recommended.

### 3. Native Kotlin

This is the best Android citizen (battery use, background IDLE, notifications, share sheet), but
the core (~2,100 lines) and the whole UI would be rewritten and maintained twice. It is worth
revisiting if Android becomes the main device. The transfer format below is designed so a Kotlin
app can read it too.

## Moving accounts to the phone (no server)

### What moves

From each `accounts` row: email, name, username, IMAP/SMTP host, port and secure flag, auth, and
colour. Optionally the `rules` and `contacts` tables. Per-account secrets:

| Account type | What moves | Notes |
|---|---|---|
| Password / app password | The password | Works as-is. |
| Microsoft 365 (OAuth) | The refresh token | It was issued to the Thunderbird public client (no secret), so the phone can refresh it with the same client ID. If the refresh ever fails, the phone signs in again. |
| Gmail (OAuth) | **Nothing.** The phone signs in itself. | The desktop token belongs to the "Desktop app" client and its secret. The phone uses its own **Android OAuth client** in the same Google Cloud project (package name + signing-certificate SHA-1, no secret). The test users and consent screen carry over. Sign-in uses Google's on-device authorization API or AppAuth; the spike should check which one gives silent token renewal for the `https://mail.google.com/` scope without a server. |

Never exported: the Google desktop client secret, the mail cache, SMS data.

### Format

The format is one JSON document, encrypted, so the phone (in Node or Kotlin) can read it with
standard crypto:

```text
{ "qmail": "accounts", "v": 1,
  "kdf": "pbkdf2-sha256", "iter": 600000, "salt": <b64>,
  "cipher": "aes-256-gcm", "iv": <b64>, "data": <b64 ciphertext+tag> }

plaintext = { "created": <ms>, "accounts": [...], "secrets": { "<email>": { "password" | "refresh" } },
              "rules": [...]?, "contacts": [...]? }
```

PBKDF2 + AES-GCM is used instead of scrypt because WebCrypto, Node and Android all have it built in.

### Desktop: Settings → "Export to phone"

1. Pick the accounts and choose whether to include rules and contacts. The screen says that
   Gmail accounts will ask to sign in on the phone.
2. Qmail generates a passphrase (for example five words) and shows it next to:
   - a **QR code**, if the encrypted bundle fits in one (about 2.5 KB; usually it will without contacts), or
   - **Save file…** (`qmail-accounts.qmx`) to move by USB, cloud drive or a mail to yourself. The
     file is useless without the passphrase.
3. The passphrase is never inside the QR or the file, so a photo of the screen alone gives
   nothing away.
4. The CLI gets the same command: `qmail accounts export --out file.qmx`. The core functions are
   named `exportBundle` / `importBundle`, to stay distinct from the Thunderbird `importAccounts`.

### Phone: "Import from desktop"

Scan the QR code or open the `.qmx` file, then type the passphrase. The phone decrypts the bundle,
writes the secrets to the Keystore, adds the accounts, and starts the first sync. Each Gmail
account then shows "Sign in with Google". The same format later works in the other direction
(phone → desktop).

## Smallest first step (a spike, about 2-3 days)

This is a throwaway Capacitor Android app in `mobile/` that proves the risky parts and nothing else:

1. Capacitor shell with one screen: email, IMAP host and app password fields, and a "Load inbox" button.
2. nodejs-mobile runs a bundled script that uses **imapflow** to open INBOX over TLS and returns
   the newest 30 subjects and senders. Nothing is stored and there is no keyring.
3. The script logs `process.versions.node` and whether `node:sqlite` loads. That answer decides
   the storage route in option 1.
4. Build a debug APK (`npx cap build android` / Gradle), install it on a phone with adb, and load
   a real inbox (a Gmail app password is enough for the spike).

**Done when:** the APK lists a real inbox on a physical phone, and we know the Node version, the
APK size and whether `node:sqlite` is available.

## After the spike, in order

1. Swappable storage and secrets backends in `src/core` (desktop behaviour unchanged).
2. Bridge host on the Node side that mirrors `src/main/host.ts`, and an Android `window.qm`.
3. Export/import bundle: core, desktop Settings, CLI, then the phone import screen.
4. Phone layout in the renderer.
5. Android Google OAuth client and on-device Gmail sign-in.
6. Background new-mail check and notifications.
7. Release signing, then sideloaded APK first, Play Store later. Play review of the restricted
   Gmail scope ties into the same Google verification the desktop app already needs.
