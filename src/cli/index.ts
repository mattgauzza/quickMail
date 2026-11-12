import { spawn } from 'node:child_process'
import fs from 'node:fs'
import readline from 'node:readline'
import { Command } from 'commander'
import * as api from '../core/api'

const program = new Command()
program
  .name('quickmail')
  .description(
    'quickMail: read, search and send mail across all your mailboxes.\n' +
      'Every command accepts --json for machine-readable output. Message ids come from `list` / `search`.'
  )
  .option('--json', 'print JSON instead of text')
  .showHelpAfterError()

const json = () => !!program.opts().json
// Accepts ids as separate arguments, or space/comma separated inside one argument.
// Ids come as arguments, comma-separated, or with "-" from standard input (for lists too long for a command line).
const ids = (xs: string[]) => xs.flatMap(x => (x === '-' ? fs.readFileSync(0, 'utf8') : x).split(/[\s,]+/)).filter(Boolean).map(x => {
  const n = Number(x)
  if (!Number.isInteger(n)) throw new Error(`"${x}" is not a message id`)
  return n
})

/** Print JSON when asked, otherwise the human rendering. */
function out(data: unknown, human: () => string) {
  console.log(json() ? JSON.stringify(data, null, 2) : human())
}

const when = (ms: number) => {
  const d = new Date(ms)
  const today = new Date().toDateString() === d.toDateString()
  return today
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })
}
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n))
const who = (p: { name: string; address: string }) => p.name || p.address
const addrList = (xs: { name: string; address: string }[]) => xs.map(p => (p.name ? `${p.name} <${p.address}>` : p.address)).join(', ')
const size = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

function since(s?: string) {
  if (!s) return undefined
  const rel = s.match(/^(\d+)([hdw])$/)
  if (rel) return Date.now() - Number(rel[1]) * { h: 3600e3, d: 86400e3, w: 604800e3 }[rel[2] as 'h' | 'd' | 'w']
  const t = Date.parse(s)
  if (Number.isNaN(t)) throw new Error(`Cannot read "${s}" as a date. Use 2026-11-01, or 12h / 3d / 2w.`)
  return t
}

function ask(question: string, hidden = false): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  if (hidden) (rl as any)._writeToOutput = (s: string) => { if (s.includes(question)) process.stdout.write(s) }
  return new Promise(res => rl.question(question, a => { rl.close(); if (hidden) process.stdout.write('\n'); res(a) }))
}

const readStdin = async () => {
  let s = ''
  for await (const chunk of process.stdin) s += chunk
  return s
}

// ---------- accounts ----------

const acct = program.command('accounts').description('list and set up mail accounts')
acct.command('list', { isDefault: true }).description('show accounts and their state').action(() => {
  const rows = api.listAccounts()
  out(rows, () =>
    rows.length
      ? rows.map(a => `${String(a.id).padStart(2)}  ${cut(a.email, 30)} ${cut(a.signedIn ? a.status : 'needs sign-in', 16)} ${a.imap}`).join('\n')
      : 'No accounts yet. Run: quickmail accounts import-thunderbird'
  )
})
acct
  .command('import-thunderbird')
  .description('copy account settings and contacts from Thunderbird')
  .option('--passwords', "also copy Thunderbird's saved passwords / Microsoft sign-in into the Windows credential store")
  .action(o => {
    const added = api.importAccounts()
    const contacts = api.importContacts()
    const creds = o.passwords ? api.importPasswords() : []
    out({ added, contacts, credentials: creds }, () =>
      [
        `Accounts added: ${added.join(', ') || 'none (already present)'}`,
        `Contacts imported: ${contacts}`,
        o.passwords ? `Credentials imported: ${creds.join(', ') || 'none'}` : 'Passwords not imported (add --passwords, or run: quickmail accounts login <email>)'
      ].join('\n')
    )
  })
acct
  .command('add <email>')
  .description('add a mailbox by hand, then sign in with: quickmail accounts login <email>')
  .option('--imap <host[:port]>', 'incoming mail server (port 993 unless given)')
  .option('--smtp <host[:port]>', 'outgoing mail server (port 465 unless given; use :587 for STARTTLS)')
  .option('--google', 'Gmail account: sign in with Google (servers are filled in)')
  .option('--name <name>', 'your name as shown to recipients')
  .option('--microsoft', 'sign in with Microsoft (Microsoft 365 / Outlook) instead of a password')
  .action((email, o) => {
    const imap = o.imap ?? (o.google ? 'imap.gmail.com' : o.microsoft ? 'outlook.office365.com' : '')
    const smtp = o.smtp ?? (o.google ? 'smtp.gmail.com' : o.microsoft ? 'smtp.office365.com:587' : '')
    if (!imap || !smtp) throw new Error('Give --imap and --smtp (or use --google / --microsoft)')
    const id = api.addMailbox({ email, name: o.name, imap, smtp, oauth: !!(o.microsoft || o.google) })
    out({ id, email }, () => `Added ${email}. Next: quickmail accounts login ${email}`)
  })
acct
  .command('login <account>')
  .description('save the password (or do Microsoft sign-in) for an account')
  .option('--password <password>', 'password; omit to be prompted')
  .action(async (ref, o) => {
    const a = api.account(ref)
    if (a.auth === 'oauth2' && api.isGoogle(a)) {
      await api.googleSignIn(a, url => {
        console.log(`Opening your browser for the Google sign-in. If it does not open, use this link:\n\n${url}\n`)
        const [cmd, args] =
          process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
          : process.platform === 'darwin' ? ['open', [url]]
          : ['xdg-open', [url]]
        spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref()
      })
    } else if (a.auth === 'oauth2') {
      const { url, verifier } = api.authUrl(a.email)
      console.log(`Open this link, sign in, then copy the address of the page you land on (it starts with https://localhost and will not load):\n\n${url}\n`)
      await api.exchangeCode(a, (await ask('Paste the address here: ')).trim(), verifier)
    } else api.setPassword(a.id, o.password ?? (await ask(`Password for ${a.email}: `, true)))
    const [res] = await api.sync(a.id, false)
    if (res.error) throw new Error(res.error)
    out({ account: a.email, signedIn: true }, () => `${a.email} is signed in. Run: quickmail sync`)
  })
acct
  .command('google-client <client-id> <client-secret>')
  .description('save your Google "Desktop app" OAuth client (from Google Cloud Console) so Gmail accounts can sign in')
  .action((id, secret) => {
    api.setGoogleClient(id, secret)
    out({ saved: true }, () => 'Google client saved. Add a Gmail account with: quickmail accounts add <you@gmail.com> --google')
  })
acct.command('remove <account>').description('remove an account and its local mail (nothing is deleted on the server)').action(ref => {
  const a = api.account(ref)
  api.removeAccount(a.id)
  out({ removed: a.email }, () => `Removed ${a.email}`)
})

// ---------- reading ----------

program
  .command('sync')
  .description('fetch new mail from the servers')
  .option('-a, --account <account>', 'only this account')
  .option('--no-bodies', 'only message lists, skip downloading bodies')
  .action(async o => {
    if (!json()) api.events.on('sync', (p: any) => process.stderr.write(`\r${cut(`${p.account} · ${p.folder} ${p.done}/${p.total}`, 78)}`))
    const res = await api.sync(o.account, o.bodies)
    if (!json()) process.stderr.write(`\r${' '.repeat(78)}\r`)
    out(res, () => res.map(r => `${cut(r.account, 30)} ${r.error ? `FAILED: ${r.error}` : `${r.new} new`}`).join('\n'))
    if (res.some(r => r.error)) process.exitCode = 1
  })

program.command('reindex').description('rebuild previews and the search index from mail already downloaded').action(async () => {
  const n = await api.reindex()
  out({ reindexed: n }, () => `Re-indexed ${n} messages`)
})

program.command('folders').description('list folders with unread counts').option('-a, --account <account>').action(o => {
  const rows = api.listFolders(o.account)
  out(rows, () => rows.map(f => `${cut(f.account, 26)} ${cut(f.name, 22)} ${cut(f.role, 8)} ${String(f.unread).padStart(5)} unread / ${f.total}`).join('\n'))
})

const viewOpts = (c: Command) =>
  c
    .option('-a, --account <account>', 'account id or email (default: all)')
    .option('-f, --folder <folder>', 'inbox, sent, drafts, archive, spam, trash, or a folder name')
    .option('-u, --unread', 'only unread')
    .option('-s, --starred', 'only starred')
    .option('--since <when>', 'date (2026-11-01) or age (12h, 3d, 2w)')
    .option('-n, --limit <n>', 'how many', '25')
    .option('--offset <n>', 'skip this many', '0')
    .option('--threads', 'group into conversations')
    .option('--oldest', 'oldest first instead of newest first (single messages only)')

function show(q: string | undefined, o: any, folder?: string) {
  const view: api.View = { account: o.account, folder: o.folder ?? folder, unread: o.unread, starred: o.starred, since: since(o.since), query: q, oldest: o.oldest }
  const rows = (o.threads ? api.listThreads : api.listMessages)(view, Number(o.limit), Number(o.offset)) as any[]
  out(rows, () =>
    rows.length
      ? rows.map(m =>
          `${String(m.id).padStart(6)} ${m.unread ? '●' : ' '}${m.starred ? '★' : ' '} ${cut(when(m.date), 9)} ${cut(who(m.from), 22)} ${cut(m.subject + (m.count > 1 ? ` (${m.count})` : ''), 50)} ${m.attachments ? '📎' : ''}`
        ).join('\n')
      : 'No mail matches.'
  )
}

viewOpts(program.command('senders').description('who the mail is from, biggest senders first (default: inbox of every account)'))
  .option('--scan <n>', 'only look at this many messages (the newest, or with --oldest the oldest)', '0')
  .action(o => {
    const view: api.View = { account: o.account, folder: o.folder ?? 'inbox', unread: o.unread, starred: o.starred, since: since(o.since), oldest: o.oldest }
    const rows = api.listSenders(view, Number(o.limit), Number(o.scan))
    out(rows, () => rows.map(s => `${String(s.count).padStart(5)}  ${cut(s.address, 38)} ${cut(s.name, 24)} ${cut(s.subject, 40)}`).join('\n') || 'No mail matches.')
  })

viewOpts(program.command('list').description('list mail, newest first (default: inbox of every account)')).action(o => show(undefined, o, 'inbox'))
viewOpts(
  program.command('search <query...>').description('full-text search. Operators: from: to: subject: in: is:unread is:starred has:attachment')
).action((q: string[], o) => show(q.join(' '), o))

program
  .command('read <id>')
  .description('show one message')
  .option('--html', 'print the HTML body instead of text')
  .option('--mark-read', 'also mark it read')
  .action(async (id, o) => {
    const m = await api.getMessage(Number(id))
    if (o.markRead) await api.setFlags([m.id], { seen: true })
    out(m, () =>
      [
        `From:    ${addrList([m.from])}`, `To:      ${addrList(m.to)}`, ...(m.cc.length ? [`Cc:      ${addrList(m.cc)}`] : []),
        `Date:    ${new Date(m.date).toLocaleString()}`, `Subject: ${m.subject}`, `Account: ${m.account} / ${m.folder}`,
        ...(m.attachments.length ? [`Files:   ${m.attachments.map(a => `[${a.index}] ${a.filename} (${size(a.size)})`).join(', ')}`] : []),
        '', o.html ? m.html : m.text
      ].join('\n')
    )
  })

program.command('thread <id>').description('show the whole conversation a message belongs to').action(async id => {
  const msgs = await Promise.all(api.getThread(Number(id)).map(m => api.getMessage(m.id)))
  out(msgs, () => msgs.map(m => `── #${m.id} · ${who(m.from)} · ${new Date(m.date).toLocaleString()} ──\n${m.text.trim()}`).join('\n\n'))
})

// ---------- writing ----------

program
  .command('send')
  .description('send an email. Body comes from --body, --body-file, or stdin')
  .requiredOption('--from <account>', 'account id or email to send from')
  .option('--to <addresses...>', 'recipients (optional with --reply-to)')
  .option('--cc <addresses...>')
  .option('--bcc <addresses...>')
  .option('--subject <subject>')
  .option('--body <text>')
  .option('--body-file <path>')
  .option('--html', 'treat the body as HTML')
  .option('--attach <paths...>', 'files to attach')
  .option('--reply-to <id>', 'reply to this message (keeps the thread, fills in recipient and subject)')
  .option('--reply-all', 'with --reply-to: include everyone on the original')
  .option('--forward <id>', 'forward this message (quotes it and carries its attachments)')
  .action(async o => {
    const from = api.account(o.from)
    let body: string = o.body ?? (o.bodyFile ? fs.readFileSync(o.bodyFile, 'utf8') : process.stdin.isTTY ? '' : await readStdin())
    let to: string[] = o.to || []
    let cc: string[] = o.cc || []
    let subject: string = o.subject || ''
    const refId = o.replyTo ?? o.forward
    if (refId) {
      const orig = await api.getMessage(Number(refId))
      const me = from.email.toLowerCase()
      if (o.replyTo && !to.length) {
        to = [orig.from.address === me ? orig.to.map(p => p.address) : [orig.from.address]].flat()
        if (o.replyAll) cc = [...cc, ...[...orig.to, ...orig.cc].map(p => p.address).filter(x => x !== me && !to.includes(x))]
      }
      const prefix = o.replyTo ? 'Re: ' : 'Fwd: '
      subject ||= new RegExp(`^${prefix.trim()}`, 'i').test(orig.subject) ? orig.subject : prefix + orig.subject
      if (!o.html) {
        const head = o.replyTo
          ? `On ${new Date(orig.date).toLocaleString()}, ${addrList([orig.from])} wrote:`
          : `---------- Forwarded message ----------\nFrom: ${addrList([orig.from])}\nDate: ${new Date(orig.date).toLocaleString()}\nSubject: ${orig.subject}\nTo: ${addrList(orig.to)}\n`
        body += `\n\n${head}\n${o.replyTo ? orig.text.trim().replace(/^/gm, '> ') : orig.text.trim()}`
      }
    }
    if (!to.length) throw new Error('No recipients. Use --to (or --reply-to <id>).')
    if (!subject && !body) throw new Error('Refusing to send an empty message. Give --subject and a body.')
    const res = await api.send({
      from: from.id, to, cc, bcc: o.bcc, subject, [o.html ? 'html' : 'text']: body,
      attachments: (o.attach || []).map((p: string) => {
        if (!fs.existsSync(p)) throw new Error(`Attachment not found: ${p}`)
        return { path: p }
      }),
      replyTo: o.replyTo ? Number(o.replyTo) : undefined, forward: o.forward ? Number(o.forward) : undefined
    })
    out(res, () => `Sent from ${res.from} to ${res.to.join(', ')}`)
  })

program
  .command('mark <ids...>')
  .description('change read / starred state')
  .option('--read').option('--unread').option('--star').option('--unstar')
  .action(async (xs, o) => {
    const f = { seen: o.read ? true : o.unread ? false : undefined, flagged: o.star ? true : o.unstar ? false : undefined }
    if (f.seen === undefined && f.flagged === undefined) throw new Error('Say what to change: --read, --unread, --star or --unstar')
    const list = ids(xs)
    await api.setFlags(list, f)
    out({ ok: true, ids: list }, () => `Updated ${list.length} message(s)`)
  })

program.command('move <ids...>').description('move messages to a folder ("-" reads ids from standard input)').requiredOption('--to <folder>', 'inbox, archive, spam, trash, or a folder name').option('--create', 'make the folder (Gmail: the label) if it does not exist').action(async (xs, o) => {
  const list = ids(xs)
  await api.moveMessages(list, o.to, !!o.create)
  out({ ok: true, ids: list, to: o.to }, () => `Moved ${list.length} message(s) to ${o.to}`)
})
program.command('archive <ids...>').description('move messages out of the inbox into Archive').action(async xs => {
  const list = ids(xs)
  await api.moveMessages(list, 'archive')
  out({ ok: true, ids: list }, () => `Archived ${list.length} message(s)`)
})
program.command('trash <ids...>').description('move messages to Trash').option('--permanent', 'delete for good instead').action(async (xs, o) => {
  const list = ids(xs)
  await api.deleteMessages(list, !!o.permanent)
  out({ ok: true, ids: list }, () => `${o.permanent ? 'Deleted' : 'Trashed'} ${list.length} message(s)`)
})

// ---------- attachments, contacts, sms ----------

program.command('attachments <id>').description('list the files attached to a message').action(async id => {
  await api.getMessage(Number(id))
  const rows = api.listAttachments(Number(id))
  out(rows, () => (rows.length ? rows.map(a => `[${a.index}] ${cut(a.filename, 44)} ${cut(a.mime, 28)} ${size(a.size)}`).join('\n') : 'No attachments.'))
})
program
  .command('download <id>')
  .description('save attachments to disk')
  .option('-i, --index <n>', 'which attachment (see `attachments`); default: all')
  .option('-o, --out <dir>', 'folder to save into', '.')
  .action(async (id, o) => {
    await api.getMessage(Number(id))
    const want = o.index !== undefined ? [Number(o.index)] : api.listAttachments(Number(id)).map(a => a.index)
    if (!want.length) throw new Error(`Message ${id} has no attachments`)
    fs.mkdirSync(o.out, { recursive: true })
    const files: string[] = []
    for (const i of want) files.push(await api.saveAttachment(Number(id), i, o.out))
    out(files, () => files.join('\n'))
  })

const contacts = program.command('contacts').description('search and edit the address book')
contacts.command('search [query]', { isDefault: true }).description('find people by name or address').option('-n, --limit <n>', 'how many', '20').action((q, o) => {
  const rows = api.searchContacts(q || '', Number(o.limit))
  out(rows, () => (rows.length ? rows.map(c => `${cut(c.name || '-', 28)} ${c.email}`).join('\n') : 'No contacts match.'))
})
contacts.command('add <email> [name...]').description('add or rename a contact').action((email, name: string[]) => {
  api.addContact(email, name.join(' '))
  out({ ok: true, email }, () => `Saved ${email}`)
})
contacts.command('remove <email>').description('delete a contact').action(email => {
  if (!api.removeContact(email)) throw new Error(`No contact ${email}`)
  out({ ok: true, email }, () => `Removed ${email}`)
})

program
  .command('sms')
  .description('(experimental) read text messages from an Android phone connected over adb')
  .option('-n, --limit <n>', 'how many', '30')
  .option('--from <number>', 'only this phone number')
  .action(async o => {
    const rows = await api.listSms(Number(o.limit), o.from)
    out(rows, () => rows.map(m => `${cut(when(m.date), 9)} ${m.direction === 'in' ? '←' : '→'} ${cut(m.address, 16)} ${m.body.replace(/\s+/g, ' ')}`).join('\n') || 'No messages.')
  })

program
  // Explicit: the installed app runs this file with its own Node runtime, which commander would otherwise misread.
  .parseAsync(process.argv, { from: 'node' })
  .catch(e => {
    if (json()) console.log(JSON.stringify({ error: e.message }))
    else console.error(`Error: ${e.message}`)
    process.exitCode = 1
  })
  .finally(() => api.closeAll())
