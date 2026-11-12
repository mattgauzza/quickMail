import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import type { DatabaseSync, StatementSync } from 'node:sqlite'

/** All quickMail data lives here: the SQLite store and the raw .eml files. */
export const HOME = process.env.QUICKMAIL_HOME || path.join(os.homedir(), '.quickmail')
export const DB_PATH = path.join(HOME, 'mail.db')
export const rawPath = (accountId: number, id: number) =>
  path.join(HOME, 'raw', String(accountId), `${id}.eml`)

/** Fires 'changed' whenever mail data changes, 'sync' with progress info. */
export const events = new EventEmitter()
export const changed = () => events.emit('changed')

export interface Account {
  id: number
  email: string
  name: string
  username: string
  imap_host: string
  imap_port: number
  imap_secure: number
  smtp_host: string
  smtp_port: number
  smtp_secure: number
  auth: 'password' | 'oauth2'
  color: string
  status: string
  last_sync: number
}

export interface Folder {
  id: number
  account_id: number
  path: string
  name: string
  role: string
  sync_state: string
  unread?: number
  total?: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL,
  imap_host TEXT NOT NULL, imap_port INTEGER NOT NULL DEFAULT 993, imap_secure INTEGER NOT NULL DEFAULT 1,
  smtp_host TEXT NOT NULL, smtp_port INTEGER NOT NULL DEFAULT 465, smtp_secure INTEGER NOT NULL DEFAULT 1,
  auth TEXT NOT NULL DEFAULT 'password',
  color TEXT NOT NULL DEFAULT '#1a73e8',
  status TEXT NOT NULL DEFAULT 'new',
  last_sync INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  sync_state TEXT NOT NULL DEFAULT '',
  UNIQUE(account_id, path)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  uid INTEGER NOT NULL,
  message_id TEXT NOT NULL DEFAULT '',
  thread_id TEXT NOT NULL DEFAULT '',
  refs TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  from_name TEXT NOT NULL DEFAULT '',
  from_addr TEXT NOT NULL DEFAULT '',
  to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]',
  date INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  seen INTEGER NOT NULL DEFAULT 0,
  flagged INTEGER NOT NULL DEFAULT 0,
  answered INTEGER NOT NULL DEFAULT 0,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  snippet TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL DEFAULT '',
  raw INTEGER NOT NULL DEFAULT 0, -- 0 = not downloaded, 1 = on disk, 2 = skipped (fetch on demand)
  UNIQUE(folder_id, uid)
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(account_id, thread_id);
CREATE INDEX IF NOT EXISTS messages_folder_date ON messages(folder_id, date DESC);
CREATE INDEX IF NOT EXISTS messages_msgid ON messages(account_id, message_id);
CREATE INDEX IF NOT EXISTS messages_raw ON messages(account_id, raw, date DESC);
CREATE TABLE IF NOT EXISTS attachments (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  filename TEXT NOT NULL DEFAULT '',
  mime TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  inline INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(message_id, idx)
);
CREATE TABLE IF NOT EXISTS contacts (
  email TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  uses INTEGER NOT NULL DEFAULT 0,
  last_used INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'mail'
);
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY,
  account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE, -- NULL = every mailbox
  from_text TEXT NOT NULL DEFAULT '',
  subject_text TEXT NOT NULL DEFAULT '',
  to_text TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT 'move',
  folder TEXT NOT NULL DEFAULT '',
  also_read INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  hits INTEGER NOT NULL DEFAULT 0
);
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(subject, sender, recipients, body, tokenize='porter unicode61');
`

let db: DatabaseSync | null = null
const stmts = new Map<string, StatementSync>()

/** node:sqlite is still flagged experimental on Node 22; load it without the console warning. */
export function sqlite(): typeof import('node:sqlite') {
  const orig = process.emitWarning
  process.emitWarning = ((w: any, ...rest: any[]) => {
    if (String(w?.message ?? w).includes('SQLite')) return
    return (orig as any).call(process, w, ...rest)
  }) as any
  try {
    return process.getBuiltinModule('node:sqlite')
  } finally {
    process.emitWarning = orig
  }
}

export function open(): DatabaseSync {
  if (db) return db
  fs.mkdirSync(HOME, { recursive: true })
  db = new (sqlite().DatabaseSync)(DB_PATH)
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=15000; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;')
  db.exec(SCHEMA)
  // Everything the mail list and the folder counts need, without touching the wide message rows (which carry the bodies).
  // Built once on an existing store; the window's own process leaves that to the background one rather than wait on it.
  if (process.env.QUICKMAIL_ROLE !== 'ui' && !db.prepare("SELECT 1 FROM sqlite_master WHERE name='messages_list'").get())
    try {
      db.exec('CREATE INDEX IF NOT EXISTS messages_list ON messages(folder_id, account_id, thread_id, date, seen, flagged, has_attachments, message_id)')
    } catch { /* another quickMail process is building it */ }
  return db
}

function stmt(sql: string): StatementSync {
  let s = stmts.get(sql)
  if (!s) stmts.set(sql, (s = open().prepare(sql)))
  return s
}

export const all = <T = any>(sql: string, ...p: any[]): T[] => stmt(sql).all(...p) as T[]
export const get = <T = any>(sql: string, ...p: any[]): T | undefined => stmt(sql).get(...p) as T | undefined
export const run = (sql: string, ...p: any[]) => stmt(sql).run(...p)

export function tx<T>(fn: () => T): T {
  const d = open()
  d.exec('BEGIN IMMEDIATE')
  try {
    const r = fn()
    d.exec('COMMIT')
    return r
  } catch (e) {
    d.exec('ROLLBACK')
    throw e
  }
}

export const placeholders = (n: number) => Array(n).fill('?').join(',')

export const accounts = () => all<Account>('SELECT * FROM accounts ORDER BY id')

/** Look an account up by id, exact email, or unique substring of the email. */
export function account(ref: number | string): Account {
  const list = accounts()
  const s = String(ref).toLowerCase()
  const hit =
    list.find(a => String(a.id) === s) ||
    list.find(a => a.email.toLowerCase() === s) ||
    (list.filter(a => a.email.toLowerCase().includes(s)).length === 1
      ? list.find(a => a.email.toLowerCase().includes(s))
      : undefined)
  if (!hit) throw new Error(`No account matches "${ref}". Known: ${list.map(a => a.email).join(', ') || '(none)'}`)
  return hit
}

/** Remove messages locally: rows, search index and raw files. */
export function dropMessages(ids: number[]) {
  if (!ids.length) return
  tx(() => {
    for (const id of ids) {
      const m = get<{ account_id: number }>('SELECT account_id FROM messages WHERE id=?', id)
      if (!m) continue
      run('DELETE FROM fts WHERE rowid=?', id)
      run('DELETE FROM messages WHERE id=?', id)
      fs.rmSync(rawPath(m.account_id, id), { force: true })
    }
  })
}
