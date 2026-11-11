import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { changed, run, sqlite, tx, accounts } from './db'
import { oauthKey, passwordKey, setSecret } from './secrets'

const TB_DIR =
  process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Thunderbird')
  : process.platform === 'win32' ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Thunderbird')
  : path.join(os.homedir(), '.thunderbird')
const COLORS = ['#1a73e8', '#d93025', '#188038', '#e37400', '#9334e6', '#12b5cb']

/** The profile Thunderbird actually starts with. */
export function findProfile(): string {
  const ini = fs.readFileSync(path.join(TB_DIR, 'profiles.ini'), 'utf8')
  const rel =
    ini.match(/^\[Install[^\]]*\][^[]*?^Default=(.+)$/m)?.[1] ||
    ini.match(/^Path=(.+)$(?=[^[]*^Default=1)/m)?.[1] ||
    ini.match(/^Path=(.+)$/m)?.[1]
  if (!rel) throw new Error('No Thunderbird profile found')
  return path.join(TB_DIR, rel.trim())
}

function readPrefs(profile: string) {
  const prefs = new Map<string, string>()
  const text = fs.readFileSync(path.join(profile, 'prefs.js'), 'utf8')
  for (const m of text.matchAll(/^user_pref\("([^"]+)",\s*(.*)\);\s*$/gm)) {
    try {
      prefs.set(m[1], String(JSON.parse(m[2])))
    } catch {}
  }
  return prefs
}

/** Copy account settings (servers, ports, names; no secrets) out of Thunderbird. */
export function importAccounts(profile = findProfile()) {
  const p = readPrefs(profile)
  const added: string[] = []
  const ids = (p.get('mail.accountmanager.accounts') || '').split(',').filter(Boolean)
  tx(() => {
    for (const acct of ids) {
      const server = p.get(`mail.account.${acct}.server`)
      const identity = p.get(`mail.account.${acct}.identities`)?.split(',')[0]
      const s = (k: string) => p.get(`mail.server.${server}.${k}`)
      if (!identity || s('type') !== 'imap') continue
      const email = p.get(`mail.identity.${identity}.useremail`)
      const smtp = p.get(`mail.identity.${identity}.smtpServer`) || p.get('mail.smtp.defaultserver')
      const m = (k: string) => p.get(`mail.smtpserver.${smtp}.${k}`)
      if (!email || !s('hostname') || !m('hostname')) continue
      const n = accounts().length + added.length
      const res = run(
        `INSERT OR IGNORE INTO accounts(email, name, username, imap_host, imap_port, imap_secure,
           smtp_host, smtp_port, smtp_secure, auth, color) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        email, p.get(`mail.identity.${identity}.fullName`) || '', s('userName') || email,
        s('hostname')!, Number(s('port') || 993), +(s('socketType') === '3'),
        m('hostname')!, Number(m('port') || 587), +(m('try_ssl') === '3'),
        s('authMethod') === '10' ? 'oauth2' : 'password', COLORS[n % COLORS.length]
      )
      if (res.changes) added.push(email)
    }
  })
  changed()
  return added
}

/** Copy address book entries (personal book, collected addresses, extra books). */
export function importContacts(profile = findProfile()) {
  let count = 0
  const files = fs.readdirSync(profile).filter(f => /^(abook(-\d+)?|history)\.sqlite$/.test(f))
  for (const file of files) {
    // Work on a copy so an open Thunderbird can't hold a lock against us.
    const tmp = path.join(os.tmpdir(), `qm-${crypto.randomUUID()}.sqlite`)
    try {
      fs.copyFileSync(path.join(profile, file), tmp)
      const db = new (sqlite().DatabaseSync)(tmp, { readOnly: true })
      const cards = new Map<string, Record<string, string>>()
      for (const r of db.prepare(
        "SELECT card, name, value FROM properties WHERE name IN ('DisplayName','PrimaryEmail','FirstName','LastName')"
      ).all() as any[])
        (cards.get(r.card) ?? cards.set(r.card, {}).get(r.card)!)[r.name] = r.value
      db.close()
      tx(() => {
        for (const c of cards.values()) {
          const email = c.PrimaryEmail?.trim().toLowerCase()
          if (!email?.includes('@')) continue
          const name = c.DisplayName || [c.FirstName, c.LastName].filter(Boolean).join(' ')
          run(
            `INSERT INTO contacts(email, name, source) VALUES(?,?,'thunderbird')
             ON CONFLICT(email) DO UPDATE SET name=CASE WHEN excluded.name<>'' THEN excluded.name ELSE contacts.name END`,
            email, name
          )
          count++
        }
      })
    } catch {
      // unreadable or foreign-format book: skip it
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  }
  return count
}

// ---------- saved passwords (Mozilla NSS key4.db + logins.json) ----------

interface Der { tag: number; value: Buffer; kids: Der[] }

function der(buf: Buffer): Der[] {
  const out: Der[] = []
  let pos = 0
  while (pos < buf.length) {
    const tag = buf[pos++]
    let len = buf[pos++]
    if (len & 0x80) {
      const n = len & 0x7f
      len = 0
      for (let i = 0; i < n; i++) len = len * 256 + buf[pos++]
    }
    const value = buf.subarray(pos, pos + len)
    out.push({ tag, value, kids: tag === 0x30 ? der(value) : [] })
    pos += len
  }
  return out
}

const OID = { pbes2: '2a864886f70d01050d', des3: '2a864886f70d0307', aes256: '60864801650304012a' }

function decipher(alg: string, key: Buffer, iv: Buffer, data: Buffer, pad: boolean) {
  const d = crypto.createDecipheriv(alg, key, iv).setAutoPadding(pad)
  return Buffer.concat([d.update(data), d.final()])
}

/** Decrypt a key4.db entry protected with the (empty) primary password. */
function decryptPbe(item: Buffer, globalSalt: Buffer, pad: boolean): Buffer {
  const [root] = der(item)
  const [algo, cipherText] = root.kids
  if (algo.kids[0].value.toString('hex') !== OID.pbes2)
    throw new Error('This Thunderbird profile uses an older key format that is not supported')
  const [kdf, enc] = algo.kids[1].kids
  const [salt, iterations, keyLen] = kdf.kids[1].kids
  const seed = crypto.createHash('sha1').update(globalSalt).digest() // sha1(globalSalt + "") for an empty primary password
  const key = crypto.pbkdf2Sync(seed, salt.value, iterations.value.readUIntBE(0, iterations.value.length), keyLen.value.readUIntBE(0, keyLen.value.length), 'sha256')
  const iv = Buffer.concat([Buffer.from([0x04, 0x0e]), enc.kids[1].value])
  return decipher('aes-256-cbc', key, iv, cipherText.value, pad)
}

function readLogins(profile: string): { host: string; user: string; pass: string }[] {
  const tmp = path.join(os.tmpdir(), `qm-${crypto.randomUUID()}.db`)
  fs.copyFileSync(path.join(profile, 'key4.db'), tmp)
  let keys: Buffer[]
  try {
    const db = new (sqlite().DatabaseSync)(tmp, { readOnly: true })
    const meta = db.prepare("SELECT item1, item2 FROM metadata WHERE id='password'").get() as any
    const globalSalt = Buffer.from(meta.item1)
    if (!decryptPbe(Buffer.from(meta.item2), globalSalt, false).toString('latin1').startsWith('password-check'))
      throw new Error('Thunderbird has a primary password set, so saved passwords cannot be read. Enter them by hand instead.')
    keys = (db.prepare('SELECT a11 FROM nssPrivate WHERE a11 IS NOT NULL').all() as any[]).map(r =>
      decryptPbe(Buffer.from(r.a11), globalSalt, true)
    )
    db.close()
  } finally {
    fs.rmSync(tmp, { force: true })
  }
  const field = (b64: string): string => {
    const [root] = der(Buffer.from(b64, 'base64'))
    const [, algo, data] = root.kids
    const oid = algo.kids[0].value.toString('hex')
    const iv = algo.kids[1].value
    for (const k of keys) {
      try {
        if (oid === OID.des3) return decipher('des-ede3-cbc', k.subarray(0, 24), iv, data.value, true).toString('utf8')
        if (oid === OID.aes256 && k.length >= 32) return decipher('aes-256-cbc', k.subarray(0, 32), iv, data.value, true).toString('utf8')
      } catch {}
    }
    throw new Error('could not decrypt a saved login')
  }
  const { logins } = JSON.parse(fs.readFileSync(path.join(profile, 'logins.json'), 'utf8'))
  const out: { host: string; user: string; pass: string }[] = []
  for (const l of logins) {
    try {
      out.push({ host: l.hostname, user: field(l.encryptedUsername), pass: field(l.encryptedPassword) })
    } catch {}
  }
  return out
}

/**
 * Copy the saved mail passwords / Microsoft sign-in for accounts quickMail knows about
 * from Thunderbird into the OS credential store. Returns the emails that got credentials.
 */
export function importPasswords(profile = findProfile()): string[] {
  const logins = readLogins(profile)
  const done: string[] = []
  for (const a of accounts()) {
    const mine = logins.filter(l => l.user.toLowerCase() === a.username.toLowerCase())
    if (a.auth === 'oauth2') {
      const hit = mine.find(l => l.host.startsWith('oauth://'))
      if (hit) { setSecret(oauthKey(a), hit.pass); done.push(a.email) }
    } else {
      const hit = mine.find(l => l.host === `imap://${a.imap_host}`) || mine.find(l => l.host === `smtp://${a.smtp_host}`)
      if (hit) { setSecret(passwordKey(a), hit.pass); done.push(a.email) }
    }
  }
  return done
}
