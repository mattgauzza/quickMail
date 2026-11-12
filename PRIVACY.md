# quickMail Privacy Policy

Last updated: 2026-11-12

quickMail is a desktop mail app. It is free and open source (MIT license), and it is made and run by the people listed in the project repository. It does not have its own servers.

## What quickMail stores

- **Your mail:** messages, attachments and contacts are stored on your computer, in a folder named `.quickmail` in your user folder (or the folder set by the `QUICKMAIL_HOME` variable).
- **Passwords and sign-in tokens:** stored in your operating system's credential store (Windows Credential Manager, macOS Keychain, or the Linux desktop keyring), never in the mail folder.
- **Settings and sorting rules:** stored on your computer.

## What quickMail connects to

quickMail only connects to services you choose:

- **Your mail providers** (IMAP and SMTP servers you set up), to read, send and sync your mail.
- **Google** and **Microsoft**, only when you sign in to a Gmail or Microsoft 365 / Outlook mailbox, to get permission to access that mailbox.
- **GitHub**, to check whether a new version of quickMail is available (installed copies on Windows and Linux AppImage), and to download it.
- **Your web browser**, only when you click the support link, which opens the project's GitHub Sponsors page.

## What quickMail does not do

- It does not send your mail, contacts, passwords or usage information to the project or to anyone else.
- It has no analytics, tracking, advertising or crash reporting.
- It does not read your mail for any purpose other than showing it to you, sorting it with the rules you create, and running the commands you give it.

## Your choices

- Removing a mailbox in quickMail deletes its local copy only. Nothing is deleted on the mail server.
- To remove quickMail and its stored data, uninstall the app and delete the `.quickmail` folder.

## Google user data

quickMail's use of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements. quickMail requests access to Gmail only so that it can show, send and manage the mail in the mailbox you sign in with. That data stays on your computer. It is not transferred to the project, and it is not used for advertising or sold.

## Contact

Questions about this policy: open an issue at https://github.com/mattgauzza/quickMail/issues

## Changes

If this policy changes, the new version will be committed to this file in the project repository, and the date above will be updated.
