import fs from 'node:fs'
import path from 'node:path'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { accessToken } from './oauth'
import { AuthError, getSecret, passwordKey } from './secrets'
import {
  type Account, type Folder, HOME, all, changed, dropMessages, events, get, placeholders, rawPath, run, tx
} from './db'

/** One line in ~/.quickmail/slow.log (timings only, never mail content); logging must never break mail. */
function slowLog(line: string) {
  try { fs.appendFileSync(path.join(HOME, 'slow.log'), `${new Date().toISOString()} ${line} role=${process.env.QUICKMAIL_ROLE ?? 'cli'}\n`) } catch { /* ignore */ }
}

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
    logger: false, clientInfo: { name: 'Qmail' }
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

/** Each folder's state as the folder listing reported it at the previous check, per account and path. */
const lastListed = new Map<string, string>()

/** A folder's state as the sync records it; the same string from a SELECT or from a STATUS means nothing changed. */
const stateOf = (s: { uidValidity?: unknown; uidNext?: unknown; exists?: unknown; highestModseq?: unknown }) =>
  `${s.uidValidity}:${s.uidNext}:${s.exists}:${s.highestModseq ?? ''}`

/**
 * List the account's folders. With `states`, each folder's state is asked for in the same command (LIST-STATUS;
 * servers without it answer STATUS per folder, which still doesn't open the folder), so unchanged folders can be
 * skipped: on Gmail opening a folder costs 1.6-3.3 s even when nothing changed.
 */
async function syncFolderList(c: ImapFlow, a: Account, states?: Map<string, string>): Promise<Folder[]> {
  const exchange = /office365|outlook/i.test(a.imap_host)
  // Gmail's Important and Starred "folders" are only other views of mail that already lives elsewhere.
  const view = (b: { flags: Set<string> }) => b.flags.has('\\Important') || b.flags.has('\\Flagged')
  const listed = await c.list(states ? { statusQuery: { messages: true, uidNext: true, uidValidity: true, highestModseq: true } } : {})
  const boxes = listed.filter(b => !b.flags.has('\\Noselect') && !view(b) && !(exchange && NOT_MAIL.test(b.path)))
  if (states)
    for (const b of boxes)
      if (b.status?.highestModseq) states.set(b.path, stateOf({ ...b.status, exists: b.status.messages }))
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

/** Stores one message's headers. Returns its new id, or 0 when it was already there. */
function insertMessage(a: Account, f: Folder, m: any): number {
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
  if (!res.changes) return 0
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
  return Number(res.lastInsertRowid)
}

/**
 * Bring one folder's message list and flags in line with the server. Returns the number of new messages.
 * Mail that newly arrived in an inbox is also noted in `arrived` (for the sorting rules): only for a folder that
 * was synced before, and only mail dated after the previous check, so a first download of a mailbox or a
 * message someone moved back into the inbox is not mistaken for new mail.
 */
export async function syncFolder(c: ImapFlow, a: Account, f: Folder, arrived?: number[]): Promise<number> {
  const lock = await c.getMailboxLock(f.path)
  try {
    const mb = c.mailbox as any
    const state = stateOf(mb)
    if (mb.highestModseq && state === f.sync_state) return 0
    const watch = arrived && f.role === 'inbox' && !!f.sync_state && f.sync_state.split(':')[0] === String(mb.uidValidity)
    const newerThan = a.last_sync - 15 * 60_000
    if (f.sync_state && f.sync_state.split(':')[0] !== String(mb.uidValidity))
      dropMessages(all<{ id: number }>('SELECT id FROM messages WHERE folder_id=?', f.id).map(r => r.id))

    // With a change counter from the last check (CONDSTORE), ask only for what changed since then: flag changes and
    // new mail. Reading every message's flags took 5-65 s per Gmail folder, and Gmail's counter is one for the
    // whole mailbox, so any new mail anywhere made every folder look changed.
    const [prevValidity, , , prevModseq] = (f.sync_state || '').split(':')
    const incremental = !!f.sync_state && prevValidity === String(mb.uidValidity) && !!prevModseq && !!mb.highestModseq
    const remote = new Map<number, Set<string>>()
    if (mb.exists)
      for await (const m of c.fetch('1:*', { uid: true, flags: true }, incremental ? { changedSince: BigInt(prevModseq) } : {}))
        remote.set(m.uid, m.flags ?? new Set())

    const local = all<{ id: number; uid: number; seen: number; flagged: number; answered: number; message_id: string }>(
      'SELECT id, uid, seen, flagged, answered, message_id FROM messages WHERE folder_id=?', f.id
    )
    let gone: number[]
    if (!incremental) gone = local.filter(l => !remote.has(l.uid)).map(l => l.id)
    else {
      // Removed mail doesn't show up as a change; the count gives it away, and then the full UID list is compared once.
      const known = new Set(local.map(l => l.uid))
      const added = [...remote.keys()].filter(uid => !known.has(uid)).length
      gone = []
      if (local.length + added !== mb.exists) {
        const uids = new Set(((await c.search({ all: true }, { uid: true })) || []) as number[])
        gone = local.filter(l => !uids.has(l.uid)).map(l => l.id)
      }
    }
    dropMessages(gone)
    if (process.env.QUICKMAIL_SYNC_DEBUG) slowLog(`check ${a.email} folder="${f.path}" incremental=${incremental} changed=${remote.size} gone=${gone.length}`)
    // On Gmail a message's flags are the same in every folder, so a change seen here (usually in All Mail, which
    // is checked every time) is copied to its other copies, whose folders may not be opened this round.
    const gmail = isGmail(a.id)
    tx(() => {
      for (const l of local) {
        const fl = remote.get(l.uid)
        if (!fl) continue
        const [s, g, r] = [+fl.has('\\Seen'), +fl.has('\\Flagged'), +fl.has('\\Answered')]
        if (s !== l.seen || g !== l.flagged || r !== l.answered) {
          run('UPDATE messages SET seen=?, flagged=?, answered=? WHERE id=?', s, g, r, l.id)
          if (gmail && l.message_id)
            run('UPDATE messages SET seen=?, flagged=?, answered=? WHERE account_id=? AND message_id=? AND id<>?', s, g, r, a.id, l.message_id, l.id)
        }
        remote.delete(l.uid)
      }
    })

    const fresh = [...remote.keys()].sort((x, y) => y - x) // newest first
    for (let i = 0; i < fresh.length; i += 200) {
      const batch: any[] = []
      const query = { uid: true, envelope: true, flags: true, bodyStructure: true, size: true, internalDate: true, headers: ['references'] }
      for await (const m of c.fetch(fresh.slice(i, i + 200).join(','), query, { uid: true })) batch.push(m)
      tx(() =>
        batch.forEach(m => {
          const id = insertMessage(a, f, m)
          if (id && watch && +(m.envelope?.date || m.internalDate || 0) >= newerThan) arrived!.push(id)
        })
      )
      // New mail (a handful of messages in a folder that was synced before): save the bodies now, before the
      // list hears about it, so a message opens at once however soon it is clicked. This includes Gmail's All
      // Mail: mail a Gmail filter files under a label skips the Inbox, and All Mail is synced before the labels,
      // so for a while its All Mail copy is the only one (opening it later means opening All Mail on the
      // server: 13-36 s). A copy already saved from another folder (usually the Inbox) is linked, not downloaded.
      if (f.sync_state && fresh.length <= 20)
        try {
          const rows = all<{ id: number; uid: number }>(
            `SELECT id, uid FROM messages WHERE folder_id=? AND raw=0 AND size<=? AND uid IN (${placeholders(batch.length)})`,
            f.id, 10 * 1024 * 1024, ...batch.map(m => m.uid)
          )
          const need: typeof rows = []
          for (const r of rows) if (!(await fromTwin(a.id, r.id))) need.push(r)
          const got: [number, Buffer][] = []
          if (need.length)
            for await (const m of c.fetch(need.map(r => r.uid).join(','), { uid: true, source: true }, { uid: true }))
              if (m.source) got.push([m.uid, m.source])
          for (const [uid, source] of got) await storeBody(a.id, need.find(r => r.uid === uid)!.id, source)
        } catch { /* the background download will get them */ }
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
export async function syncAccount(a: Account): Promise<{ account: string; new: number; error?: string; arrived: number[] }> {
  const arrived: number[] = []
  try {
    const added = await withImap(a, async c => {
      let n = 0
      const t0 = Date.now()
      const gmail = isGmail(a.id)
      const states = new Map<string, string>()
      const folders = await syncFolderList(c, a, states)
      let opened = 0
      for (const f of folders) {
        const t1 = Date.now()
        const key = `${a.id}:${f.path}`
        const now = states.get(f.path)
        // Unchanged since the last check: don't open the folder. Gmail's STATUS count for All Mail differs from
        // the count seen on opening it (18,916 vs 18,911), so the count only has to match what the listing
        // said last time; validity, next UID and the change counter must match the folder's recorded state.
        const core = (s: string) => s.split(':').filter((_, i) => i !== 2).join(':')
        const unchanged = (() => {
          if (!now || !f.sync_state) return false
          if (gmail) {
            // Gmail's change counter covers the whole mailbox, so it can't tell which folder changed. All Mail is
            // checked every time (it sees every flag change, copied to the other copies); any other folder only
            // when mail arrived (next UID moved) or left it (its listed count moved).
            if (f.role === 'archive') return false
            const [v, next, count] = now.split(':')
            const [sv, snext, scount] = f.sync_state.split(':')
            return v === sv && next === snext && count === (lastListed.get(key)?.split(':')[2] ?? scount)
          }
          return now === f.sync_state || (now === lastListed.get(key) && core(now) === core(f.sync_state))
        })()
        const got = unchanged ? 0 : await syncFolder(c, a, f, arrived)
        if (now) lastListed.set(key, now)
        n += got
        if (!unchanged) opened++
        // A folder that takes long to check is written down (timings only) so the cause can be found afterwards.
        if (Date.now() - t1 > (process.env.QUICKMAIL_SYNC_DEBUG ? 0 : 5000)) slowLog(`sync ${a.email} folder="${f.path}" ${Date.now() - t1}ms new=${got}`)
      }
      if (process.env.QUICKMAIL_SYNC_DEBUG || Date.now() - t0 > 15000)
        slowLog(`sync ${a.email} total=${Date.now() - t0}ms folders=${folders.length} opened=${opened} new=${n}`)
      return n
    })
    setStatus(a, 'ok')
    return { account: a.email, new: added, arrived }
  } catch (e: any) {
    setStatus(a, e instanceof AuthError ? 'auth' : `error: ${e.message}`)
    return { account: a.email, new: 0, error: e.message, arrived }
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
    const fresh: BodyJob[] = []
    for (const j of jobs) if (!(await fromTwin(a.id, j.id))) fresh.push(j)
    if (fresh.length) await downloadBodies(a, fresh)
    done += jobs.length
    const left = get<{ n: number }>('SELECT COUNT(*) n FROM messages WHERE account_id=? AND raw=0', a.id)!.n
    events.emit('sync', { account: a.email, folder: 'message bodies', done, total: done + left })
    changed()
  }
  return done
}

/**
 * Gmail shows one message in several folders (Inbox, All Mail, every label). When another copy is already
 * on disk, reuse it instead of downloading: a hard link, so it takes no time and no extra space.
 */
async function fromTwin(accountId: number, id: number): Promise<boolean> {
  const twin = get<{ id: number }>(
    `SELECT t.id FROM messages m JOIN messages t ON t.account_id=m.account_id AND t.message_id=m.message_id AND t.raw=1 AND t.id<>m.id
     WHERE m.id=? AND m.message_id<>'' LIMIT 1`, id
  )
  const have = twin && rawPath(accountId, twin.id)
  if (!have || !fs.existsSync(have)) return false
  try {
    const file = rawPath(accountId, id)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.rmSync(file, { force: true })
    try { fs.linkSync(have, file) } catch { fs.copyFileSync(have, file) }
    await storeBody(accountId, id, fs.readFileSync(file), false)
    return true
  } catch {
    return false
  }
}

/** Make sure one message's body is on disk (used when opening mail that was never downloaded). */
export async function ensureBody(id: number) {
  const m = get<BodyJob & { raw: number; account_id: number; role: string }>(
    'SELECT m.id, m.uid, m.folder_id, m.raw, m.account_id, f.path, f.role FROM messages m JOIN folders f ON f.id=m.folder_id WHERE m.id=?', id
  )
  if (!m) throw new Error(`No message with id ${id}`)
  if (m.raw === 1 && fs.existsSync(rawPath(m.account_id, id))) return
  // Opening Gmail's All Mail copy of a new message used to download it again (25-36 s to open the huge
  // All Mail folder) although its Inbox copy was already on disk.
  if (await fromTwin(m.account_id, id)) return
  const a = get<Account>('SELECT * FROM accounts WHERE id=?', m.account_id)!
  if (m.role === 'archive') {
    // Rather than open Gmail's huge All Mail on the server, download a copy that sits in a smaller folder
    // (the Inbox or a label) and link it.
    const other = get<BodyJob>(
      `SELECT t.id, t.uid, t.folder_id, f.path FROM messages m JOIN messages t ON t.account_id=m.account_id AND t.message_id=m.message_id AND t.id<>m.id
       JOIN folders f ON f.id=t.folder_id WHERE m.id=? AND m.message_id<>'' AND f.role NOT IN ('archive', 'trash', 'junk') LIMIT 1`, id
    )
    if (other)
      try {
        await downloadBodies(a, [other])
        if (await fromTwin(m.account_id, id)) return
      } catch { /* fall back to All Mail itself */ }
  }
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

/**
 * The ids plus every other copy of the same messages. Gmail lists one message under Inbox, All Mail and
 * each label, and the app shows those copies as one; a flag set on only one copy would leave the others
 * unread (or unstarred), so the conversation would stay in Unread after it was read.
 */
function withCopies(ids: number[]): number[] {
  if (!ids.length) return ids
  const copies = all<{ id: number }>(
    `SELECT c.id FROM messages m JOIN messages c ON c.account_id=m.account_id AND c.message_id=m.message_id AND c.id<>m.id
     WHERE m.id IN (${placeholders(ids.length)}) AND m.message_id<>''`, ...ids
  )
  return [...new Set([...ids, ...copies.map(c => c.id)])]
}

const isGmail = (accountId: number) => /gmail|googlemail/i.test(accountById(accountId).imap_host)

export async function setFlags(ids: number[], f: { seen?: boolean; flagged?: boolean; answered?: boolean }) {
  const asked = new Set(ids)
  ids = withCopies(ids)
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
    // On Gmail the copies are one message, so the server already applies the flag everywhere; opening the
    // other folders (All Mail is huge) would only hold up the connection that opens mail. Other servers keep
    // real copies, so each one is flagged.
    if (!g.some(x => asked.has(x.id)) && isGmail(g[0].account_id)) continue
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

/**
 * Move messages to a folder given by role, path or name. "archive" is created if the account has none;
 * with create=true any other missing folder (a Gmail label, e.g. "Money/Receipts") is created too.
 */
export async function moveMessages(ids: number[], dest: string, create = false) {
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
      if (!target && create) {
        await c.mailboxCreate(dest)
        await syncFolderList(c, a)
        target = findFolder(a.id, dest)
      }
      if (!target) throw new Error(`${a.email} has no folder "${dest}"`)
      if (target.id === g[0].folder_id) throw new Error(`Already in ${target.name}`)
      const destPath = target.path
      await inFolder(c, g[0].path, async () => {
        const res: any = await c.messageMove(uidsOf(g), destPath, { uid: true })
        // Servers that report what they moved (Gmail does) sometimes move only part of a large batch.
        // Saying so makes onServer resync the folder, which puts the unmoved messages back in the list.
        const moved = res?.uidMap?.size
        if (typeof moved === 'number' && moved < g.length)
          throw new Error(`${a.email}: the server moved only ${moved} of ${g.length} messages to ${target!.name}; the rest are still in place`)
      })
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
