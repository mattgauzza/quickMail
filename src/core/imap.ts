import fs from 'node:fs'
import path from 'node:path'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { accessToken } from './oauth'
import { AuthError, getSecret, passwordKey } from './secrets'
import {
  type Account, type Folder, all, changed, dropMessages, events, get, placeholders, rawPath, run, tx
} from './db'

// ---------- connections: one reusable connection per account, commands run one at a time ----------

const pool = new Map<number, { client: ImapFlow | null; chain: Promise<unknown> }>()

async function connect(a: Account): Promise<ImapFlow> {
  let auth: { user: string; pass?: string; accessToken?: string }
  if (a.auth === 'oauth2') auth = { user: a.username, accessToken: await accessToken(a) }
  else {
    const pass = getSecret(passwordKey(a))
    if (!pass) throw new AuthError(a.email, `${a.email} has no saved password`)
    auth = { user: a.username, pass }
  }
  const client = new ImapFlow({
    host: a.imap_host, port: a.imap_port, secure: !!a.imap_secure, auth,
    logger: false, clientInfo: { name: 'quickMail' }
  })
  client.on('error', () => {})
  try {
    await client.connect()
  } catch (e: any) {
    if (e.authenticationFailed) throw new AuthError(a.email, `${a.email}: the server rejected the sign-in`)
    throw new Error(`${a.email}: could not connect to ${a.imap_host} (${e.message})`)
  }
  return client
}

/** Run fn with the account's connection. Never call withImap from inside fn (it would wait on itself). */
export function withImap<T>(a: Account, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  let e = pool.get(a.id)
  if (!e) pool.set(a.id, (e = { client: null, chain: Promise.resolve() }))
  const entry = e
  const job = async () => {
    if (!entry.client?.usable) entry.client = await connect(a)
    return fn(entry.client)
  }
  const p = entry.chain.then(job, job)
  entry.chain = p.catch(() => {})
  return p
}

export async function closeAll() {
  for (const e of pool.values()) {
    await e.chain
    await e.client?.logout().catch(() => {})
  }
  pool.clear()
}

// ---------- folders ----------

const ROLE_BY_FLAG: Record<string, string> = {
  '\\Inbox': 'inbox', '\\Sent': 'sent', '\\Drafts': 'drafts', '\\Trash': 'trash',
  '\\Junk': 'junk', '\\Archive': 'archive', '\\All': 'archive'
}
// Checked in order. Exchange's own folder names come first: Office 365 does not declare roles, and
// accounts that were used with Thunderbird also carry empty look-alikes ("Sent", "Trash").
const ROLE_BY_NAME: [RegExp, string][] = [
  [/^inbox$/i, 'inbox'], [/^sent items$/i, 'sent'], [/^deleted items$/i, 'trash'], [/^junk e-?mail$/i, 'junk'],
  [/^sent( messages| mail)?$/i, 'sent'], [/^drafts?$/i, 'drafts'],
  [/^(trash|deleted messages|bin)$/i, 'trash'], [/^(junk|spam|bulk mail)$/i, 'junk'], [/^archives?$/i, 'archive']
]
/** Exchange exposes calendars, contacts and the like over IMAP; they are not mail. */
const NOT_MAIL = /^(Calendar|Contacts|Tasks|Journal|Notes|Outbox|Conversation History|Sync Issues)(\/|$)/i
export const ROLE_ORDER = ['inbox', 'sent', 'drafts', 'archive', 'junk', 'trash', '']

async function syncFolderList(c: ImapFlow, a: Account): Promise<Folder[]> {
  const exchange = /office365|outlook/i.test(a.imap_host)
  // Gmail's Important and Starred "folders" are only other views of mail that already lives elsewhere.
  const view = (b: { flags: Set<string> }) => b.flags.has('\\Important') || b.flags.has('\\Flagged')
  const boxes = (await c.list()).filter(b => !b.flags.has('\\Noselect') && !view(b) && !(exchange && NOT_MAIL.test(b.path)))
  // What the server declares wins; folder names only fill the roles nobody declared.
  const roles = new Map<string, string>()
  const claim = (b: (typeof boxes)[number], role?: string) => {
    if (role && !roles.has(b.path) && ![...roles.values()].includes(role)) roles.set(b.path, role)
  }
  // imapflow also guesses roles from names (specialUseSource 'name'); those guesses rank last.
  const flagRole = (b: (typeof boxes)[number]) => (b.specialUse ? ROLE_BY_FLAG[b.specialUse] : undefined)
  for (const b of boxes) if ((b as any).specialUseSource !== 'name') claim(b, flagRole(b))
  for (const [re, role] of ROLE_BY_NAME) for (const b of boxes) if (re.test(b.name)) claim(b, role)
  for (const b of boxes) claim(b, flagRole(b))
  tx(() => {
    for (const b of boxes) {
      const role = roles.get(b.path) ?? ''
      run(
        `INSERT INTO folders(account_id, path, name, role) VALUES(?,?,?,?)
         ON CONFLICT(account_id, path) DO UPDATE SET name=excluded.name, role=excluded.role`,
        a.id, b.path, b.name, role
      )
    }
  })
  const keep = new Set(boxes.map(b => b.path))
  for (const f of all<Folder>('SELECT * FROM folders WHERE account_id=?', a.id)) {
    if (keep.has(f.path)) continue
    dropMessages(all<{ id: number }>('SELECT id FROM messages WHERE folder_id=?', f.id).map(r => r.id))
    run('DELETE FROM folders WHERE id=?', f.id)
  }
  return all<Folder>('SELECT * FROM folders WHERE account_id=?', a.id).sort(
    (x, y) => ROLE_ORDER.indexOf(x.role) - ROLE_ORDER.indexOf(y.role) || x.path.localeCompare(y.path)
  )
}

export function folderByRole(accountId: number, role: string) {
  return get<Folder>('SELECT * FROM folders WHERE account_id=? AND role=?', accountId, role)
}

/** Resolve a folder by role ("inbox", "trash"...), exact path, or display name. */
export function findFolder(accountId: number, ref: string): Folder | undefined {
  const r = ref.toLowerCase() === 'spam' ? 'junk' : ref.toLowerCase()
  return (
    folderByRole(accountId, r) ||
    get<Folder>('SELECT * FROM folders WHERE account_id=? AND (path=? OR lower(name)=?)', accountId, ref, r)
  )
}

// ---------- message sync ----------

const addr = (x: any) => ({ name: String(x?.name || ''), address: String(x?.address || '').toLowerCase() })
const cleanId = (s: string) => s.trim().replace(/\s+/g, '')

function hasAttachment(node: any): boolean {
  if (!node) return false
  if (node.childNodes?.length) return node.childNodes.some(hasAttachment)
  const named = node.dispositionParameters?.filename || node.parameters?.name
  return node.disposition === 'attachment' || (!!named && node.disposition !== 'inline')
}

function insertMessage(a: Account, f: Folder, m: any) {
  const env = m.envelope || {}
  const from = addr(env.from?.[0])
  const to = (env.to || []).map(addr)
  const cc = (env.cc || []).map(addr)
  // Only the References header was requested, so every <...> in it is a message id.
  const refs: string[] = ((m.headers ? m.headers.toString() : '').match(/<[^>]+>/g) || []).map(cleanId)
  const messageId = env.messageId ? cleanId(env.messageId) : `<qm-${f.id}-${m.uid}@local>`
  const inReplyTo = env.inReplyTo ? cleanId(env.inReplyTo) : ''
  const date = +(env.date || m.internalDate || Date.now())

  // Thread = the conversation an already-known parent belongs to, else the root of the reference chain.
  const parents = [inReplyTo, ...refs.slice().reverse()].filter(Boolean)
  let threadId = ''
  for (const p of parents) {
    threadId = get<{ thread_id: string }>(
      'SELECT thread_id FROM messages WHERE account_id=? AND message_id=? LIMIT 1', a.id, p
    )?.thread_id ?? ''
    if (threadId) break
  }
  threadId ||= refs[0] || inReplyTo || messageId
  // Replies that arrived before this message adopted it as their root; pull them along.
  if (threadId !== messageId)
    run('UPDATE messages SET thread_id=? WHERE account_id=? AND thread_id=?', threadId, a.id, messageId)

  const flags: Set<string> = m.flags || new Set()
  const res = run(
    `INSERT OR IGNORE INTO messages(account_id, folder_id, uid, message_id, thread_id, refs, subject, from_name, from_addr,
       to_json, cc_json, date, size, seen, flagged, answered, has_attachments)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    a.id, f.id, m.uid, messageId, threadId, refs.join(' '), env.subject || '', from.name, from.address,
    JSON.stringify(to), JSON.stringify(cc), date, m.size || 0,
    +flags.has('\\Seen'), +flags.has('\\Flagged'), +flags.has('\\Answered'), +hasAttachment(m.bodyStructure)
  )
  if (!res.changes) return
  run(
    'INSERT INTO fts(rowid, subject, sender, recipients, body) VALUES(?,?,?,?,?)',
    res.lastInsertRowid, env.subject || '', `${from.name} ${from.address}`,
    [...to, ...cc].map(x => `${x.name} ${x.address}`).join(' '), ''
  )
  // Address book: people I write to rank highest; everyone who writes to me is at least known.
  const people = f.role === 'sent' ? [...to, ...cc].map(p => ({ ...p, uses: 1 })) : [{ ...from, uses: 0 }]
  for (const p of people) {
    if (!p.address.includes('@')) continue
    run(
      `INSERT INTO contacts(email, name, uses, last_used) VALUES(?,?,?,?)
       ON CONFLICT(email) DO UPDATE SET uses=uses+excluded.uses, last_used=MAX(last_used, excluded.last_used),
         name=CASE WHEN contacts.name='' THEN excluded.name ELSE contacts.name END`,
      p.address, p.name, p.uses, date
    )
  }
}

/** Bring one folder's message list and flags in line with the server. Returns the number of new messages. */
export async function syncFolder(c: ImapFlow, a: Account, f: Folder): Promise<number> {
  const lock = await c.getMailboxLock(f.path)
  try {
    const mb = c.mailbox as any
    const state = `${mb.uidValidity}:${mb.uidNext}:${mb.exists}:${mb.highestModseq ?? ''}`
    if (mb.highestModseq && state === f.sync_state) return 0
    if (f.sync_state && f.sync_state.split(':')[0] !== String(mb.uidValidity))
      dropMessages(all<{ id: number }>('SELECT id FROM messages WHERE folder_id=?', f.id).map(r => r.id))

    const remote = new Map<number, Set<string>>()
    if (mb.exists) for await (const m of c.fetch('1:*', { uid: true, flags: true })) remote.set(m.uid, m.flags ?? new Set())

    const local = all<{ id: number; uid: number; seen: number; flagged: number; answered: number }>(
      'SELECT id, uid, seen, flagged, answered FROM messages WHERE folder_id=?', f.id
    )
    dropMessages(local.filter(l => !remote.has(l.uid)).map(l => l.id))
    tx(() => {
      for (const l of local) {
        const fl = remote.get(l.uid)
        if (!fl) continue
        const [s, g, r] = [+fl.has('\\Seen'), +fl.has('\\Flagged'), +fl.has('\\Answered')]
        if (s !== l.seen || g !== l.flagged || r !== l.answered)
          run('UPDATE messages SET seen=?, flagged=?, answered=? WHERE id=?', s, g, r, l.id)
        remote.delete(l.uid)
      }
    })

    const fresh = [...remote.keys()].sort((x, y) => y - x) // newest first
    for (let i = 0; i < fresh.length; i += 200) {
      const batch: any[] = []
      const query = { uid: true, envelope: true, flags: true, bodyStructure: true, size: true, internalDate: true, headers: ['references'] }
      for await (const m of c.fetch(fresh.slice(i, i + 200).join(','), query, { uid: true })) batch.push(m)
      tx(() => batch.forEach(m => insertMessage(a, f, m)))
      events.emit('sync', { account: a.email, folder: f.name, done: Math.min(i + 200, fresh.length), total: fresh.length })
      changed()
    }
    run('UPDATE folders SET sync_state=? WHERE id=?', state, f.id)
    return fresh.length
  } finally {
    lock.release()
  }
}

const setStatus = (a: Account, status: string) => {
  run('UPDATE accounts SET status=?, last_sync=? WHERE id=?', status, Date.now(), a.id)
  changed()
}

/** Sync folder list, message lists and flags for one account. Bodies are fetched separately. */
export async function syncAccount(a: Account): Promise<{ account: string; new: number; error?: string }> {
  try {
    const added = await withImap(a, async c => {
      let n = 0
      for (const f of await syncFolderList(c, a)) n += await syncFolder(c, a, f)
      return n
    })
    setStatus(a, 'ok')
    return { account: a.email, new: added }
  } catch (e: any) {
    setStatus(a, e instanceof AuthError ? 'auth' : `error: ${e.message}`)
    return { account: a.email, new: 0, error: e.message }
  }
}

// ---------- bodies ----------

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim()

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" }

/** Readable text for HTML-only mail. Drops what Outlook/Word hide in comments and <xml> blocks. */
function htmlToText(html: string) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|style|script|xml|title)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
      e[0] === '#' && e !== '#39'
        ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
        : ENTITIES[e.toLowerCase()] ?? m
    )
    .replace(/[ \t ]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function storeBody(accountId: number, id: number, source: Buffer, write = true) {
  if (write) {
    const file = rawPath(accountId, id)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, source)
  }
  const p = await simpleParser(source, { skipImageLinks: true, skipTextLinks: true, skipHtmlToText: true })
  const html = p.html || ''
  const text = p.text?.trim() ? p.text : htmlToText(html)
  const atts = p.attachments.map((x, idx) => ({
    idx, filename: x.filename || `attachment-${idx + 1}`, mime: x.contentType || '', size: x.size || 0,
    inline: +(!!x.cid && html.includes(`cid:${x.cid}`))
  }))
  tx(() => {
    run('DELETE FROM attachments WHERE message_id=?', id)
    for (const x of atts)
      run('INSERT INTO attachments(message_id, idx, filename, mime, size, inline) VALUES(?,?,?,?,?,?)', id, x.idx, x.filename, x.mime, x.size, x.inline)
    run(
      'UPDATE messages SET body_text=?, body_html=?, snippet=?, has_attachments=?, raw=1 WHERE id=?',
      text, html, collapse(text).slice(0, 220), +atts.some(x => !x.inline), id
    )
    run('UPDATE fts SET body=? WHERE rowid=?', text.slice(0, 200_000), id)
  })
}

/** Rebuild text, previews, attachment lists and the search index from the raw messages already on disk. */
export async function reindex() {
  let n = 0
  for (const m of all<{ id: number; account_id: number }>('SELECT id, account_id FROM messages WHERE raw=1')) {
    const file = rawPath(m.account_id, m.id)
    if (!fs.existsSync(file)) { run('UPDATE messages SET raw=0 WHERE id=?', m.id); continue }
    await storeBody(m.account_id, m.id, fs.readFileSync(file), false)
    n++
  }
  changed()
  return n
}

interface BodyJob { id: number; uid: number; folder_id: number; path: string }

async function downloadBodies(a: Account, jobs: BodyJob[]) {
  const byFolder = Map.groupBy(jobs, j => j.path)
  for (const [folderPath, group] of byFolder) {
    const got = await withImap(a, async c => {
      const lock = await c.getMailboxLock(folderPath)
      try {
        const out: [number, Buffer][] = []
        for await (const m of c.fetch(group.map(g => g.uid).join(','), { uid: true, source: true }, { uid: true }))
          if (m.source) out.push([m.uid, m.source])
        return out
      } finally {
        lock.release()
      }
    })
    const byUid = new Map(got)
    for (const j of group) {
      const src = byUid.get(j.uid)
      if (src) await storeBody(a.id, j.id, src)
      else run('UPDATE messages SET raw=2 WHERE id=?', j.id)
    }
  }
}

/** Download message bodies that are not on disk yet, newest first, in small batches. */
export async function fetchBodies(a: Account, max = Infinity): Promise<number> {
  let done = 0
  const MAX_SIZE = 40 * 1024 * 1024
  run('UPDATE messages SET raw=2 WHERE account_id=? AND raw=0 AND size>?', a.id, MAX_SIZE)
  while (done < max) {
    const jobs = all<BodyJob>(
      `SELECT m.id, m.uid, m.folder_id, f.path FROM messages m JOIN folders f ON f.id=m.folder_id
       WHERE m.account_id=? AND m.raw=0 ORDER BY m.date DESC LIMIT 25`, a.id
    )
    if (!jobs.length) break
    await downloadBodies(a, jobs)
    done += jobs.length
    const left = get<{ n: number }>('SELECT COUNT(*) n FROM messages WHERE account_id=? AND raw=0', a.id)!.n
    events.emit('sync', { account: a.email, folder: 'message bodies', done, total: done + left })
    changed()
  }
  return done
}

/** Make sure one message's body is on disk (used when opening mail that was never downloaded). */
export async function ensureBody(id: number) {
  const m = get<BodyJob & { raw: number; account_id: number }>(
    'SELECT m.id, m.uid, m.folder_id, m.raw, m.account_id, f.path FROM messages m JOIN folders f ON f.id=m.folder_id WHERE m.id=?', id
  )
  if (!m) throw new Error(`No message with id ${id}`)
  if (m.raw === 1 && fs.existsSync(rawPath(m.account_id, id))) return
  const a = get<Account>('SELECT * FROM accounts WHERE id=?', m.account_id)!
  await downloadBodies(a, [m])
}

export async function parseRaw(id: number) {
  await ensureBody(id)
  const m = get<{ account_id: number }>('SELECT account_id FROM messages WHERE id=?', id)!
  return simpleParser(fs.readFileSync(rawPath(m.account_id, id)))
}

// ---------- actions (local change first so the UI is instant, then the server) ----------

interface Loc { id: number; uid: number; account_id: number; folder_id: number; path: string; role: string }

function locate(ids: number[]): Map<string, Loc[]> {
  if (!ids.length) return new Map()
  const rows = all<Loc>(
    `SELECT m.id, m.uid, m.account_id, m.folder_id, f.path, f.role FROM messages m JOIN folders f ON f.id=m.folder_id
     WHERE m.id IN (${placeholders(ids.length)})`, ...ids
  )
  return Map.groupBy(rows, r => `${r.account_id}:${r.folder_id}`)
}

const accountById = (id: number) => get<Account>('SELECT * FROM accounts WHERE id=?', id)!
const uidsOf = (g: Loc[]) => g.map(x => x.uid).join(',')

/** Run a server change for a group; if it fails, force the folder to fully resync so the local optimistic change is undone. */
async function onServer(g: Loc[], fn: (c: ImapFlow, a: Account) => Promise<void>) {
  const a = accountById(g[0].account_id)
  try {
    await withImap(a, c => fn(c, a))
  } catch (e) {
    run("UPDATE folders SET sync_state='' WHERE id=?", g[0].folder_id)
    throw e
  }
}

async function inFolder(c: ImapFlow, folderPath: string, fn: () => Promise<unknown>) {
  const lock = await c.getMailboxLock(folderPath)
  try {
    await fn()
  } finally {
    lock.release()
  }
}

export async function setFlags(ids: number[], f: { seen?: boolean; flagged?: boolean; answered?: boolean }) {
  const groups = locate(ids)
  const cols: [string, string, boolean | undefined][] = [
    ['seen', '\\Seen', f.seen], ['flagged', '\\Flagged', f.flagged], ['answered', '\\Answered', f.answered]
  ]
  tx(() => {
    for (const [col, , v] of cols)
      if (v !== undefined) run(`UPDATE messages SET ${col}=? WHERE id IN (${placeholders(ids.length)})`, +v, ...ids)
  })
  changed()
  for (const g of groups.values()) {
    await onServer(g, c =>
      inFolder(c, g[0].path, async () => {
        for (const [, flag, v] of cols) {
          if (v === undefined) continue
          if (v) await c.messageFlagsAdd(uidsOf(g), [flag], { uid: true })
          else await c.messageFlagsRemove(uidsOf(g), [flag], { uid: true })
        }
      })
    )
  }
}

/** Move messages to a folder given by role, path or name. "archive" is created if the account has none. */
export async function moveMessages(ids: number[], dest: string) {
  const groups = locate(ids)
  dropMessages(ids)
  changed()
  for (const g of groups.values()) {
    await onServer(g, async (c, a) => {
      let target = findFolder(a.id, dest)
      if (!target && dest.toLowerCase() === 'archive') {
        const inbox = folderByRole(a.id, 'inbox')
        const nested = all<Folder>('SELECT * FROM folders WHERE account_id=?', a.id).find(x => /^INBOX[./]/.test(x.path))
        await c.mailboxCreate(nested ? `${inbox?.path ?? 'INBOX'}${nested.path[5]}Archive` : 'Archive')
        await syncFolderList(c, a)
        target = findFolder(a.id, 'archive')
      }
      if (!target) throw new Error(`${a.email} has no folder "${dest}"`)
      if (target.id === g[0].folder_id) throw new Error(`Already in ${target.name}`)
      const destPath = target.path
      await inFolder(c, g[0].path, () => c.messageMove(uidsOf(g), destPath, { uid: true }))
      await syncFolder(c, a, target)
    })
  }
  changed()
}

/** Move to Trash; messages already in Trash (or with permanent=true) are deleted for good. */
export async function deleteMessages(ids: number[], permanent = false) {
  const groups = [...locate(ids).values()]
  const hard = groups.filter(g => permanent || g[0].role === 'trash' || !folderByRole(g[0].account_id, 'trash'))
  const soft = groups.filter(g => !hard.includes(g))
  if (soft.length) await moveMessages(soft.flat().map(x => x.id), 'trash')
  dropMessages(hard.flat().map(x => x.id))
  changed()
  for (const g of hard) await onServer(g, c => inFolder(c, g[0].path, () => c.messageDelete(uidsOf(g), { uid: true })))
}
