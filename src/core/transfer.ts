// Moving mailboxes from this PC to the phone app with no server in between.
//
// The bundle is account settings plus saved passwords, gzipped, then sealed with AES-256-GCM under a key
// from PBKDF2-SHA256 (600,000 rounds) of a five-word passphrase. It is printed as
//   QMX1:<base64url(salt[16] | iv[12] | ciphertext | tag[16])>
// and shown as a QR code. The passphrase is shown beside the code, never inside it, so a photo of the
// QR alone gives nothing away. The Android app (android/.../Transfer.kt) reads the same format.
//
// Google and Microsoft mailboxes travel with their long-lived sign-in (refresh token) and the client it was
// issued to, so the phone reads them without the account being added to Android.
import { createCipheriv, pbkdf2Sync, randomBytes, randomInt } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { all } from './db'
import { MS, googleClient } from './oauth'
import { getSecret, oauthKey, passwordKey } from './secrets'

export const BUNDLE_PREFIX = 'QMX1:'
const ROUNDS = 600_000

// 256 short, distinct, easy-to-type words: five of them are 40 bits, stretched by PBKDF2.
const WORDS = (
  'acid acorn actor agent alarm album alley amber angle apple apron arena armor arrow atlas attic audio avid ' +
  'bacon badge bagel baker bamboo banjo barn basil beach beard bench berry bison blade blank blaze bloom board ' +
  'bonus boots brave bread brick bride brook brush bucket buddy bugle cabin cable cactus camel candy canoe cargo ' +
  'carpet cedar chalk charm cheese cherry chess chief chili cider cinema civic clay cliff cloud clover coast cobra ' +
  'cocoa comet coral cotton couch cover crane crayon creek crown cube cupid curve daisy dance delta denim depot ' +
  'desk diner disco dodge dolphin donut dragon drift drum dune eagle easel echo elbow elder ember empty engine ' +
  'equal fable fabric falcon fancy farm feast fence ferry fiber field fig flag flame flute focus forest fossil ' +
  'frame frost fruit gadget galaxy garden gecko gem ghost giant ginger glass globe glove goat gold grape gravel ' +
  'guitar habit hammer harbor hazel helmet heron hippo honey hotel husky igloo index indigo iron island ivory ' +
  'jacket jaguar jelly jewel jungle kayak kettle kiwi koala ladder lagoon lamp lava lemon lilac linen lion lobster ' +
  'locket lotus lunar magnet mango maple marble meadow melon metal mint mirror mocha monkey moose mosaic motor ' +
  'muffin museum nectar needle noble noodle oasis ocean olive onion opera orbit otter oven owl paddle panda ' +
  'paper parrot pasta peach pebble pepper piano pickle pilot pine pirate pizza planet plum polar pony poppy ' +
  'potato prism pumpkin puzzle quartz quill rabbit radar radio raven reef ribbon river robin rocket ruby saddle ' +
  'salad salmon sandal satin scarf scout shadow shell silver sketch sled slope solar spice spoon spruce squid ' +
  'stamp storm sugar summit sunny swan table tango tiger toast topaz torch tulip tundra turtle velvet violet'
).split(' ')

/** A passphrase like "maple otter cinema frost quill". Typing is forgiving: case, extra spaces and dashes don't matter. */
export function makePassphrase(n = 5) {
  return Array.from({ length: n }, () => WORDS[randomInt(WORDS.length)]).join(' ')
}

export const normalizePassphrase = (p: string) => p.trim().toLowerCase().split(/[\s\-_.,]+/).filter(Boolean).join(' ')

type Row = {
  id: number; email: string; name: string; username: string; imap_host: string; imap_port: number; imap_secure: number
  smtp_host: string; smtp_port: number; smtp_secure: number; auth: string; color: string
}

/**
 * Seals the chosen mailboxes (all when [ids] is empty) for the phone.
 * Returns the QR text, its passphrase, and which password mailboxes had no saved password to send.
 */
export function exportBundle(ids: number[] = []) {
  const rows = all<Row>('SELECT * FROM accounts ORDER BY id').filter(a => !ids.length || ids.includes(a.id))
  if (!rows.length) throw new Error('Pick at least one mailbox to send to the phone.')
  const missing: string[] = []
  const accounts = rows.map(a => {
    const kind = a.auth !== 'oauth2' ? 'password' : /gmail|googlemail/i.test(a.imap_host) ? 'google' : 'microsoft'
    const password = kind === 'password' ? getSecret(passwordKey(a)) : null
    // Google and Microsoft: the refresh token, so the phone needs no sign-in screens at all.
    const refresh = kind !== 'password' ? getSecret(oauthKey(a)) : null
    if (kind === 'password' && !password) missing.push(a.email)
    // Short keys keep the QR code small enough to scan easily.
    return {
      e: a.email, n: a.name || undefined, u: a.username !== a.email ? a.username : undefined, k: kind, c: a.color,
      ih: a.imap_host, ip: a.imap_port, is: a.imap_secure ? 1 : 0,
      sh: a.smtp_host, sp: a.smtp_port, ss: a.smtp_secure ? 1 : 0,
      p: password ?? undefined, r: refresh ?? undefined
    }
  })
  const passphrase = makePassphrase()
  // The Google client lets the phone refresh those tokens, and sign in to more Gmail in its browser.
  const client = accounts.some(a => a.k === 'google') ? googleClient() : null
  const extra: Record<string, unknown> = client ? { g: { i: client.id, s: client.secret } } : {}
  // Microsoft's public client has no secret; the phone needs its ID to refresh the token.
  if (accounts.some(a => a.k === 'microsoft')) extra.m = MS.clientId
  return { code: sealBundle(accounts, passphrase, extra), passphrase, count: rows.length, missing }
}

/** The QR text for a list of mailboxes (in the short-key form above), sealed with [passphrase]. */
export function sealBundle(accounts: object[], passphrase: string, extra: object = {}) {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = pbkdf2Sync(normalizePassphrase(passphrase), salt, ROUNDS, 32, 'sha256')
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const plain = gzipSync(JSON.stringify({ v: 1, t: Date.now(), a: accounts, ...extra }))
  const sealed = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()])
  return BUNDLE_PREFIX + Buffer.concat([salt, iv, sealed]).toString('base64url')
}
