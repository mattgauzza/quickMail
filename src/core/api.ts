import fs from 'node:fs'
import path from 'node:path'
import { type Account, type Folder, HOME, account, accounts, all, changed, get, placeholders, run } from './db'
import { ROLE_ORDER, ensureBody, fetchBodies, parseRaw, syncAccount } from './imap'
import { hasCredentials, passwordKey, setSecret } from './secrets'
import { type Answer, type Invite, buildReply, parseInvite } from './invite'
import { send } from './send'

export { account, accounts, events, HOME } from './db'
export { closeAll, deleteMessages, moveMessages, reindex, setFlags } from './imap'
export { send, type Draft } from './send'
export { importAccounts, importContacts, importPasswords } from './thunderbird'
export { authUrl, exchangeCode, googleSignIn, hasGoogleClient, isGoogle, setGoogleClient } from './oauth'
export { listSms } from './sms'

export interface View {
  /** Account id, email (or unique part of it); omit for all accounts. */
  account?: number | string | null
  /** Folder role (inbox, sent, drafts, archive, junk, trash), name or path. Omit to look everywhere except Trash and Spam. */
  folder?: string
  starred?: boolean
  unread?: boolean
  /** Search text. Supports from: to: subject: in: is:unread is:starred has:attachment */
  query?: string
  /** Only mail on or after this time (ms since epoch). */
  since?: number
  /** Conversations only: keep those with ('unread') or without ('read') any unread message. */
  state?: 'unread' | 'read'
}

const having = (v: View) => (v.state === 'unread' ? 'HAVING SUM(1-m.seen)>0' : v.state === 'read' ? 'HAVING SUM(1-m.seen)=0' : '')

const phrase = (s: string) => `"${s.replace(/"/g, '')}"*`

function where(v: View) {
  const w: string[] = []
  const p: any[] = []
  if (v.account != null && v.account !== '' && v.account !== 'all') {
    w.push('m.account_id=?')
    p.push(account(v.account).id)
  }
  let folder = v.folder
  const match: string[] = []
  const text = (v.query || '').replace(/\b(from|to|subject|in|is|has|newer_than|older_than):("[^"]+"|\S+)/gi, (_, key: string, raw: string) => {
    const val = raw.replace(/"/g, '')
    switch (key.toLowerCase()) {
      case 'from':
        if (val.toLowerCase() === 'me') {
          const mine = accounts().map(a => a.email.toLowerCase())
          w.push(`lower(m.from_addr) IN (${placeholders(mine.length)})`)
          p.push(...mine)
        } else match.push(`sender:${phrase(val)}`)
        break
      case 'newer_than':
      case 'older_than': {
        const age = /^(\d+)([dwmy])$/i.exec(val)
        if (age) {
          const days = { d: 1, w: 7, m: 30, y: 365 }[age[2].toLowerCase() as 'd' | 'w' | 'm' | 'y']
          w.push(key.toLowerCase() === 'newer_than' ? 'm.date>=?' : 'm.date<?')
          p.push(Date.now() - Number(age[1]) * days * 86400000)
        }
        break
      }
      case 'to': match.push(`recipients:${phrase(val)}`); break
      case 'subject': match.push(`subject:${phrase(val)}`); break
      case 'in': folder = val; break
      case 'has': if (/^attach/i.test(val)) w.push('m.has_attachments=1'); break
      case 'is':
        if (/^unread$/i.test(val)) w.push('m.seen=0')
        else if (/^read$/i.test(val)) w.push('m.seen=1')
        else if (/^starred$/i.test(val)) w.push('m.flagged=1')
    }
    return ' '
  })
  for (const term of text.match(/"[^"]+"|\S+/g) || []) match.push(phrase(term))
  if (match.length) {
    w.push('m.id IN (SELECT rowid FROM fts WHERE fts MATCH ?)')
    p.push(match.join(' '))
  }
  if (folder && folder !== 'all') {
    const f = folder.toLowerCase() === 'spam' ? 'junk' : folder.toLowerCase()
    w.push('m.folder_id IN (SELECT id FROM folders WHERE role=? OR lower(name)=? OR path=?)')
    p.push(f, f, folder)
  } else w.push("m.folder_id IN (SELECT id FROM folders WHERE role NOT IN ('trash','junk'))")
  if (v.starred) w.push('m.flagged=1')
  if (v.unread) w.push('m.seen=0')
  if (v.since) { w.push('m.date>=?'); p.push(v.since) }
  return { sql: w.join(' AND '), params: p }
}

const person = (name: string, address: string) => ({ name, address })
const emailOf = () => new Map(accounts().map(a => [a.id, a.email]))

// One value per real message. Gmail lists the same message under Inbox, All Mail and every label,
// and a sent message can sit in two "Sent" folders; lists and counts treat those copies as one.
const ONE = `CASE WHEN m.message_id = '' THEN 'id:' || m.id ELSE m.message_id END`

/** Conversations matching a view, newest first. `id` is the newest message; `ids` are all messages of the conversation in this view. */
export function listThreads(v: View = {}, limit = 50, offset = 0) {
  const { sql, params } = where(v)
  const rows = all<any>(
    // "newest" doubles as the pick of which copy represents the conversation: SQLite fills the plain columns from
    // the row holding the MAX, and the +1 makes a copy in a real folder win over its duplicate in Gmail's All Mail.
    `SELECT m.account_id, m.thread_id, m.id, MAX(m.date * 2 + (f.role <> 'archive')) / 2 AS date, COUNT(DISTINCT ${ONE}) AS count, SUM(1-m.seen) AS unread,
            SUM(m.flagged) AS starred, SUM(m.has_attachments) AS attachments, GROUP_CONCAT(m.id) AS ids,
            m.subject, m.snippet, m.from_name, m.from_addr, m.to_json, f.name AS folder, f.role
     FROM messages m JOIN folders f ON f.id=m.folder_id
     WHERE ${sql} GROUP BY m.account_id, m.thread_id ${having(v)} ORDER BY date DESC LIMIT ? OFFSET ?`,
    ...params, limit, offset
  )
  const emails = emailOf()
  return rows.map(r => {
    const ids: number[] = String(r.ids).split(',').map(Number)
    const who = all<{ from_name: string; from_addr: string }>(
      `SELECT from_name, from_addr FROM messages WHERE id IN (${placeholders(ids.length)}) ORDER BY date`, ...ids
    )
    const files = r.attachments > 0
      ? (all<any>(
          `SELECT message_id AS id, idx AS "index", filename FROM attachments
           WHERE inline=0 AND message_id IN (${placeholders(ids.length)}) ORDER BY message_id DESC, idx`, ...ids
        ) as { id: number; index: number; filename: string }[])
      : []
    return {
      files,
      id: r.id as number, ids, account: emails.get(r.account_id)!, accountId: r.account_id as number,
      threadId: r.thread_id as string, date: r.date as number, count: r.count as number,
      unread: r.unread as number, starred: r.starred > 0, attachments: r.attachments > 0,
      subject: r.subject as string, snippet: r.snippet as string, from: person(r.from_name, r.from_addr),
      participants: [...new Set(who.map(x => x.from_name || x.from_addr))],
      to: JSON.parse(r.to_json) as { name: string; address: string }[], folder: r.folder as string, role: r.role as string
    }
  })
}

/** How many conversations match a view. */
export function countThreads(v: View = {}) {
  const { sql, params } = where(v)
  return get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM (SELECT 1 FROM messages m WHERE ${sql} GROUP BY m.account_id, m.thread_id ${having(v)})`, ...params
  )!.n
}

/** Individual messages matching a view, newest first (no conversation grouping). */
export function listMessages(v: View = {}, limit = 50, offset = 0) {
  const { sql, params } = where(v)
  const emails = emailOf()
  return all<any>(
    `SELECT m.id, m.account_id, m.thread_id, m.date, m.seen, m.flagged, m.has_attachments, m.subject, m.snippet,
            m.from_name, m.from_addr, m.to_json, f.name AS folder, MIN((f.role = 'archive') * 1000000000000 + m.id) AS pick
     FROM messages m JOIN folders f ON f.id=m.folder_id WHERE ${sql}
     GROUP BY m.account_id, ${ONE} ORDER BY m.date DESC LIMIT ? OFFSET ?`,
    ...params, limit, offset
  ).map(r => ({
    id: r.id as number, account: emails.get(r.account_id)!, threadId: r.thread_id as string, date: r.date as number,
    unread: !r.seen, starred: !!r.flagged, attachments: !!r.has_attachments, subject: r.subject as string,
    snippet: r.snippet as string, from: person(r.from_name, r.from_addr),
    to: JSON.parse(r.to_json) as { name: string; address: string }[], folder: r.folder as string
  }))
}

const metaOf = (r: any, emails = emailOf()) => ({
  id: r.id as number, account: emails.get(r.account_id)!, accountId: r.account_id as number, threadId: r.thread_id as string,
  messageId: r.message_id as string, date: r.date as number, unread: !r.seen, starred: !!r.flagged, answered: !!r.answered,
  subject: r.subject as string, snippet: r.snippet as string, from: person(r.from_name, r.from_addr),
  to: JSON.parse(r.to_json) as { name: string; address: string }[],
  cc: JSON.parse(r.cc_json) as { name: string; address: string }[],
  folder: r.folder as string, role: r.role as string, hasAttachments: !!r.has_attachments
})

const MSG = `SELECT m.*, f.name AS folder, f.role FROM messages m JOIN folders f ON f.id=m.folder_id`

/** Every message of the conversation a message belongs to, oldest first, across folders (Trash/Spam only if asked). */
export function getThread(messageId: number, includeHidden = false) {
  const m = get<any>('SELECT account_id, thread_id FROM messages WHERE id=?', messageId)
  if (!m) throw new Error(`No message with id ${messageId}`)
  const seen = new Set<string>()
  const emails = emailOf()
  return all<any>(`${MSG} WHERE m.account_id=? AND m.thread_id=? ORDER BY m.date`, m.account_id, m.thread_id)
    .filter(r => r.id === messageId || includeHidden || !['trash', 'junk'].includes(r.role))
    .filter(r => !seen.has(r.message_id) && seen.add(r.message_id))
    .map(r => metaOf(r, emails))
}

/** One message with its body. Downloads it first if needed. With inlineImages, embedded pictures are resolved into the HTML. */
export async function getMessage(id: number, inlineImages = false) {
  await ensureBody(id)
  const r = get<any>(`${MSG} WHERE m.id=?`, id)
  if (!r) throw new Error(`No message with id ${id}`)
  let html: string = r.body_html
  if (inlineImages && html.includes('cid:')) {
    for (const x of (await parseRaw(id)).attachments)
      if (x.cid) html = html.replaceAll(`cid:${x.cid}`, `data:${x.contentType};base64,${x.content.toString('base64')}`)
  }
  return { ...metaOf(r), text: r.body_text as string, html, attachments: listAttachments(id), invite: await inviteOf(id) }
}

/** The calendar invitation a message carries, if any. */
async function inviteOf(id: number): Promise<Invite | null> {
  const hit = get<{ idx: number }>(
    `SELECT idx FROM attachments WHERE message_id=? AND (mime LIKE 'text/calendar%' OR lower(filename) LIKE '%.ics') ORDER BY idx`, id
  )
  if (!hit) return null
  const part = (await parseRaw(id)).attachments[hit.idx]
  return part ? parseInvite(part.content.toString('utf8')) : null
}

/** Answer an invitation: mails the organizer a calendar reply from the mailbox that received it. */
export async function respondInvite(id: number, answer: Answer) {
  const inv = await inviteOf(id)
  if (!inv) throw new Error(`Message ${id} has no calendar invitation`)
  if (!inv.organizer?.email) throw new Error('This invitation does not say who to reply to')
  const m = get<{ account_id: number }>('SELECT account_id FROM messages WHERE id=?', id)!
  const a = account(m.account_id)
  // Reply as the address that was invited when it is one of ours (aliases), else as the mailbox itself.
  const mine = new Set(accounts().map(x => x.email.toLowerCase()))
  const me = inv.attendees.find(x => x.email === a.email.toLowerCase()) ?? inv.attendees.find(x => mine.has(x.email))
  const word = { ACCEPTED: 'Accepted', DECLINED: 'Declined', TENTATIVE: 'Tentative' }[answer]
  await send({
    from: a.id, to: inv.organizer.email, subject: `${word}: ${inv.summary}`,
    text: `${a.name || a.email} has ${answer === 'TENTATIVE' ? 'tentatively accepted' : word.toLowerCase()} this invitation.`,
    ical: { method: 'REPLY', content: buildReply(inv, { name: me?.name || a.name, email: me?.email || a.email }, answer) }
  })
  return { answer, to: inv.organizer.email }
}

export function listAttachments(id: number) {
  return all<{ idx: number; filename: string; mime: string; size: number }>(
    'SELECT idx AS "index", filename, mime, size FROM attachments WHERE message_id=? AND inline=0 ORDER BY idx', id
  ) as unknown as { index: number; filename: string; mime: string; size: number }[]
}

/** Write an attachment to disk. `dest` may be a directory (keeps the original file name) or a full file path. */
export async function saveAttachment(id: number, index: number, dest: string) {
  const att = (await parseRaw(id)).attachments[index]
  if (!att) throw new Error(`Message ${id} has no attachment #${index}`)
  const name = (att.filename || `attachment-${index + 1}`).replace(/[\\/:*?"<>|]/g, '_')
  const isDir = fs.existsSync(dest) && fs.statSync(dest).isDirectory()
  const file = path.resolve(isDir ? path.join(dest, name) : dest)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, att.content)
  return file
}

export function listFolders(ref?: number | string | null) {
  const emails = emailOf()
  const rows = all<Folder & { unread: number; total: number }>(
    `SELECT f.*, (SELECT COUNT(*) FROM messages WHERE folder_id=f.id AND seen=0) AS unread,
            (SELECT COUNT(*) FROM messages WHERE folder_id=f.id) AS total FROM folders f`
  )
  const only = ref != null && ref !== '' && ref !== 'all' ? account(ref).id : null
  return rows
    .filter(f => only === null || f.account_id === only)
    .sort((x, y) => x.account_id - y.account_id || ROLE_ORDER.indexOf(x.role) - ROLE_ORDER.indexOf(y.role) || x.name.localeCompare(y.name))
    .map(f => ({ id: f.id, account: emails.get(f.account_id)!, accountId: f.account_id, name: f.name, path: f.path, role: f.role, unread: f.unread, total: f.total }))
}

export function listAccounts() {
  return accounts().map(a => ({
    id: a.id, email: a.email, name: a.name, auth: a.auth, color: a.color, status: a.status, lastSync: a.last_sync,
    provider: a.auth !== 'oauth2' ? '' : /gmail|googlemail/i.test(a.imap_host) ? 'Google' : 'Microsoft',
    imap: `${a.imap_host}:${a.imap_port}`, smtp: `${a.smtp_host}:${a.smtp_port}`, signedIn: DEMO || hasCredentials(a)
  }))
}

export function addAccount(a: Omit<Account, 'id' | 'status' | 'last_sync' | 'color'> & { color?: string }) {
  run(
    `INSERT INTO accounts(email, name, username, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, auth, color)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    a.email, a.name, a.username || a.email, a.imap_host, a.imap_port, a.imap_secure, a.smtp_host, a.smtp_port, a.smtp_secure,
    a.auth, a.color || COLORS[accounts().length % COLORS.length]
  )
  changed()
}

/** Demo mode (QUICKMAIL_DEMO=1, see scripts/seed-demo.mjs): made-up mailboxes that count as signed in and are never synced. */
export const DEMO = !!process.env.QUICKMAIL_DEMO

const COLORS = ['#1a73e8', '#188038', '#9334e6', '#e37400', '#d93025', '#12b5cb']

/** Add a mailbox from "host[:port]" server addresses. Ports default to 993 (IMAP) and 465 (SMTP); 587 means STARTTLS. */
export function addMailbox(o: { email: string; name?: string; imap: string; smtp: string; oauth?: boolean }) {
  const email = o.email.trim().toLowerCase()
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('That does not look like an email address')
  if (accounts().some(a => a.email.toLowerCase() === email)) throw new Error(`${email} is already set up`)
  const split = (s: string, port: number) => {
    const [host, p] = s.trim().split(':')
    if (!host) throw new Error('Both mail servers are needed')
    return { host, port: Number(p) || port }
  }
  const imap = split(o.imap, 993)
  const smtp = split(o.smtp, 465)
  addAccount({
    email, name: o.name?.trim() || '', username: email, imap_host: imap.host, imap_port: imap.port, imap_secure: imap.port === 993 ? 1 : 0,
    smtp_host: smtp.host, smtp_port: smtp.port, smtp_secure: smtp.port === 465 ? 1 : 0, auth: o.oauth ? 'oauth2' : 'password'
  })
  return account(email).id
}

export function removeAccount(ref: number | string) {
  const a = account(ref)
  run('DELETE FROM fts WHERE rowid IN (SELECT id FROM messages WHERE account_id=?)', a.id)
  run('DELETE FROM accounts WHERE id=?', a.id) // folders, messages, attachments cascade
  fs.rmSync(path.join(HOME, 'raw', String(a.id)), { recursive: true, force: true })
  changed()
}

export function setPassword(ref: number | string, password: string) {
  setSecret(passwordKey(account(ref)), password)
}

let syncing: Promise<any> | null = null

/** Sync every account (or one). Message lists first, then bodies unless bodies=false. Concurrent calls share one run. */
export function sync(ref?: number | string | null, bodies = true) {
  if (syncing) return syncing as Promise<{ account: string; new: number; error?: string }[]>
  const list = ref != null && ref !== '' && ref !== 'all' ? [account(ref)] : accounts()
  syncing = Promise.all(
    list.map(async a => {
      const res = await syncAccount(a)
      if (!res.error && bodies) await fetchBodies(a).catch(e => (res.error = `bodies: ${e.message}`))
      return res
    })
  ).finally(() => (syncing = null))
  return syncing as Promise<{ account: string; new: number; error?: string }[]>
}

let filling: Promise<void> | null = null

/** Download any missing message bodies in the background (one run at a time). */
export function backfill() {
  return (filling ??= Promise.all(accounts().filter(a => a.status === 'ok').map(a => fetchBodies(a).catch(() => 0)))
    .then(() => {})
    .finally(() => (filling = null)))
}

export function searchContacts(q = '', limit = 8) {
  const like = `%${q.toLowerCase()}%`
  return all<{ email: string; name: string; uses: number }>(
    `SELECT email, name, uses FROM contacts WHERE email LIKE ? OR lower(name) LIKE ?
     ORDER BY uses DESC, (source='thunderbird') DESC, last_used DESC LIMIT ?`, like, like, limit
  )
}

export function addContact(email: string, name = '') {
  run(
    `INSERT INTO contacts(email, name, source) VALUES(?,?,'manual')
     ON CONFLICT(email) DO UPDATE SET name=excluded.name`, email.toLowerCase(), name
  )
}

export function removeContact(email: string) {
  return run('DELETE FROM contacts WHERE email=?', email.toLowerCase()).changes > 0
}
