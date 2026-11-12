import { Entry } from '@napi-rs/keyring'
import type { Account } from './db'

// Secrets live in the OS credential store (Windows Credential Manager), never in the database.
// Credential Manager caps a blob at ~1280 UTF-16 chars, and OAuth refresh tokens are longer,
// so long values are split across numbered entries.
const SERVICE = 'quickMail' // the app's old name; kept so passwords saved before the rename are still found
const CHUNK = 1000
const MARK = '@@chunks:'

const read = (k: string): string | null => {
  try {
    return new Entry(SERVICE, k).getPassword() || null
  } catch {
    return null
  }
}

export function getSecret(key: string): string | null {
  const head = read(key)
  if (!head?.startsWith(MARK)) return head
  let out = ''
  for (let i = 0; i < Number(head.slice(MARK.length)); i++) out += read(`${key}#${i}`) ?? ''
  return out
}

export function setSecret(key: string, value: string) {
  if (value.length <= CHUNK) return new Entry(SERVICE, key).setPassword(value)
  const n = Math.ceil(value.length / CHUNK)
  for (let i = 0; i < n; i++) new Entry(SERVICE, `${key}#${i}`).setPassword(value.slice(i * CHUNK, (i + 1) * CHUNK))
  new Entry(SERVICE, key).setPassword(MARK + n)
}

export const passwordKey = (a: Pick<Account, 'email'>) => a.email
export const oauthKey = (a: Pick<Account, 'email'>) => `${a.email}:oauth`

export const hasCredentials = (a: Account) =>
  !!getSecret(a.auth === 'oauth2' ? oauthKey(a) : passwordKey(a))

export class AuthError extends Error {
  constructor(public email: string, msg: string) {
    super(msg)
  }
}
