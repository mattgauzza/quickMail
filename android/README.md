# Qmail for Android

A native Kotlin and Jetpack Compose app. It talks to IMAP directly, with no server, the same way the desktop app does.
Why native and not a wrapper around the desktop code: see `../docs/android-plan.md`, option 3.

## What works (0.1.0)

- Several mailboxes, with **All inboxes** (every account's inbox together, a coloured dot per account) and each
  mailbox's own folders in the drawer. Add them by:
  - **Import from computer**: in the desktop app open Settings → Phone → Show QR code, scan it, and type the
    five-word passphrase shown beside it. Password, Google and Microsoft mailboxes arrive ready to use
    (Google and Microsoft ones bring their sign-in). The format is in `../src/core/transfer.ts` and `Transfer.kt`.
  - **Sign in with Google** for Gmail (see below), or
  - email, password or app password, and IMAP server. Common providers fill in automatically.
    The login is tested before it is saved.
- The password is encrypted with a key held in the Android Keystore. Settings are kept in app-private prefs.
- Folder drawer (the menu button, or swipe from the left edge): Inbox, Starred, Sent, Drafts, Archive, Spam and Trash first,
  then your own folders with subfolders indented, each with its unread count. Back from another folder returns to the Inbox.
- Message list: the newest 60 messages of the folder on screen. Pull down to refresh; it also refreshes when the app comes to the front.
  The last list is cached so the app opens straight onto mail.
- Reader: shows plain text, or flattened HTML when there is no plain text. Opening an email marks it read.
  Its top bar has Archive, Delete, Mark unread and a menu with the rest.
- Acting on mail: swipe right to archive, swipe left to delete (to Trash), or long-press for a sheet with Archive,
  Mark read/unread, Move to... and Delete. Moves can be undone from the bar at the bottom. In Trash, Delete removes
  for good after asking. Archive goes to the Archive folder, or All mail on Gmail.
- Background check: WorkManager every 15 minutes while online. It posts one notification per batch of
  new mail ("2 new emails" with one line per message) and never repeats mail you already saw in the list.

Not yet: a local message store and search,
sending, starring, and importing accounts from the desktop app.

## Gmail sign-in

There are two ways, and neither needs the Google account added to the phone when the first is available.

**Through the computer's Google client (`GoogleWeb.kt`).** An import from the desktop brings Qmail's "Desktop app"
OAuth client (ID and secret) and each Gmail mailbox's refresh token, all stored encrypted with the Keystore. Access
tokens come from `oauth2.googleapis.com/token`. Once the client is on the phone, **Sign in** and **Continue with Google**
open Google's page in the browser and catch the redirect on a one-off listener at `http://127.0.0.1:<port>`, exactly
as the desktop app does, then keep the new refresh token. The page that ends sign-in links back with
`qmail://signed-in`. A revoked sign-in (`invalid_grant`) shows **Sign in** again.

**Through Play services (no import yet).** This uses Google Play services' Authorization API with the `https://mail.google.com/` and `email` scopes, and IMAP
logs in with XOAUTH2. The app holds no client secret and no refresh token. Play services hands out a fresh access
token whenever one is needed, including for the background check. If Google ever wants the user back (access revoked,
password changed), the inbox shows "Sign in again" and the background check posts a notification saying so.

Google only issues tokens to builds it knows. Each signing key needs an **Android** OAuth client in the
`quickmail-gauzza` Cloud project (the one the desktop app uses), under Google Auth Platform → Clients → Create client → Android:

| Build | Package name | SHA-1 | Client |
|---|---|---|---|
| Debug (this PC's `~/.android/debug.keystore`) | `com.gauzza.qmail` | `F7:C7:07:65:54:91:9B:2E:F3:FF:FF:41:7C:04:16:61:F4:54:F4:71` | Created 2026-11-23 as "Qmail Android (debug)" |
| Release | `com.gauzza.qmail` | add when a release key exists | not yet |

While the consent screen is in Testing, only the listed test users can sign in, the same as on desktop.
Without the client, sign-in fails with "Google doesn't recognise this build of Qmail yet".

## Microsoft mailboxes

They come only from the computer (`Microsoft.kt`). The code carries the mailbox's refresh token and the public client
ID it was issued to (no secret). The phone gets access tokens from `login.microsoftonline.com/common/oauth2/v2.0/token`,
saves the new refresh token Microsoft returns each time, and logs in to `outlook.office365.com` with XOAUTH2.
There is no Microsoft sign-in on the phone: the desktop flow ends by pasting a `https://localhost` link, which doesn't
suit a phone. When Microsoft ends the sign-in (`invalid_grant`, `interaction_required`), the mailbox and a notification
say to send it from the computer again. A Microsoft refresh token is about 1,500 characters, so the QR code gets dense
(about version 33 with seven mailboxes); the desktop draws it larger to keep it scannable.

## Build

Needs JDK 17+ and the Android SDK (platform 35). `local.properties` points at the SDK.

```powershell
.\gradlew assembleDebug
```

The APK is written to `app/build/outputs/apk/debug/app-debug.apk`. Install it with `adb install -r <apk>`.

## Testing without a real account

Run GreenMail, a local test mail server, in Docker. Inside the emulator the host machine is `10.0.2.2`:

```powershell
docker run -d --name qmail-greenmail -p 3025:3025 -p 3143:3143 -e GREENMAIL_OPTS="-Dgreenmail.setup.test.smtp -Dgreenmail.setup.test.imap -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=tester:qmail-test@qmail.test" greenmail/standalone:2.1.3
```

To sign in: address `tester@qmail.test`, password `qmail-test`. Under Server settings: host `10.0.2.2`,
port `3143`, security None, username `tester`. To deliver test mail, send it by SMTP to `127.0.0.1:3025`.
To run the background check right away, use the menu item "Run background check now".

To try Import from computer without a camera, debug builds take a code from the launch intent:
`adb shell am start -n com.gauzza.qmail/.MainActivity --es qmx "QMX1:..."`.
