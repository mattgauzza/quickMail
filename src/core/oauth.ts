import crypto from 'node:crypto'
import http from 'node:http'
import type { Account } from './db'
import { AuthError, getSecret, oauthKey, setSecret } from './secrets'

// Microsoft 365 sign-in. Uses Thunderbird's public client registration by default (the same one
// the imported refresh token was issued to); set QUICKMAIL_MS_CLIENT_ID to use your own app.
export const MS = {
  clientId: process.env.QUICKMAIL_MS_CLIENT_ID || '9e5f94bc-e8a4-4e73-b8be-63364c29d753',
  redirect: 'https://localhost',
  authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  scope: 'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access'
}

const b64url = (b: Buffer) => b.toString('base64url')

export function authUrl(email: string) {
  const verifier = b64url(crypto.randomBytes(32))
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest())
  const url =
    `${MS.authorize}?` +
    new URLSearchParams({
      client_id: MS.clientId,
      response_type: 'code',
      redirect_uri: MS.redirect,
      scope: MS.scope,
      login_hint: email,
      code_challenge: challenge,
      code_challenge_method: 'S256'
    })
  return { url, verifier }
}

// Google sign-in. Google has no shared public client for mail apps, so Qmail uses the user's own
// "Desktop app" OAuth client (Google Cloud Console), saved once with: qmail accounts google-client
export const GOOGLE = {
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  scope: 'https://mail.google.com/'
}
const GOOGLE_KEY = 'google:client'
export const isGoogle = (a: Pick<Account, 'imap_host'>) => /gmail|googlemail/i.test(a.imap_host)

export function googleClient() {
  if (process.env.QUICKMAIL_GOOGLE_CLIENT_ID)
    return { id: process.env.QUICKMAIL_GOOGLE_CLIENT_ID, secret: process.env.QUICKMAIL_GOOGLE_CLIENT_SECRET || '' }
  const saved = getSecret(GOOGLE_KEY)
  return saved ? (JSON.parse(saved) as { id: string; secret: string }) : null
}
export const hasGoogleClient = () => !!googleClient()
export function setGoogleClient(id: string, secret: string) {
  if (!id.trim().endsWith('.apps.googleusercontent.com')) throw new Error('A Google client ID ends with .apps.googleusercontent.com')
  setSecret(GOOGLE_KEY, JSON.stringify({ id: id.trim(), secret: secret.trim() }))
}
function needGoogleClient() {
  const c = googleClient()
  if (!c) throw new Error('Google sign-in is not set up yet. Save your Google client first: qmail accounts google-client <client-id> <client-secret>')
  return c
}

/**
 * Sign a Gmail account in through the system browser. A one-off listener on 127.0.0.1 receives
 * Google's redirect (the flow Google requires of desktop apps; it blocks embedded sign-in windows).
 */
export async function googleSignIn(a: Pick<Account, 'email'>, open: (url: string) => void) {
  const client = needGoogleClient()
  const verifier = b64url(crypto.randomBytes(32))
  const state = b64url(crypto.randomBytes(16))
  const server = http.createServer()
  await new Promise<void>((ok, fail) => server.once('error', fail).listen(0, '127.0.0.1', ok))
  const redirect = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Google sign-in timed out')), 5 * 60_000)
      server.on('request', (req, res) => {
        const q = new URL(req.url || '/', redirect).searchParams
        if (!q.get('code') && !q.get('error')) return void res.writeHead(404).end()
        const good = !!q.get('code') && q.get('state') === state
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(`<body style="font:16px system-ui;margin:15vh auto;max-width:420px;text-align:center"><h2>Qmail</h2><p>${
          good ? 'You are signed in. You can close this tab.' : 'Sign-in did not complete. Close this tab and try again.'
        }</p></body>`)
        clearTimeout(timer)
        if (good) resolve(q.get('code')!)
        else reject(new Error(q.get('error') === 'access_denied' ? 'Sign-in was cancelled' : 'Google sign-in failed'))
      })
      open(
        `${GOOGLE.authorize}?` +
          new URLSearchParams({
            client_id: client.id, response_type: 'code', redirect_uri: redirect, scope: GOOGLE.scope, login_hint: a.email, state,
            access_type: 'offline', prompt: 'consent', code_challenge_method: 'S256',
            code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest())
          })
      )
    })
    const t = await tokenRequest(
      { grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier, client_id: client.id, client_secret: client.secret },
      GOOGLE.token
    )
    if (!t.refresh_token) throw new Error('Google did not return a long-lived sign-in; try again')
    return remember(a, t)
  } finally {
    server.close()
  }
}

async function tokenRequest(params: Record<string, string>, endpoint = MS.token) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: MS.clientId, ...params })
  })
  const json: any = await res.json()
  if (!res.ok) throw new Error(json.error_description?.split('\n')[0] || json.error || `token request failed (${res.status})`)
  return json as { access_token: string; refresh_token?: string; expires_in: number }
}

const cache = new Map<string, { token: string; expires: number }>()

function remember(a: Pick<Account, 'email'>, t: { access_token: string; refresh_token?: string; expires_in: number }) {
  if (t.refresh_token) setSecret(oauthKey(a), t.refresh_token)
  cache.set(a.email, { token: t.access_token, expires: Date.now() + (t.expires_in - 120) * 1000 })
  return t.access_token
}

/** Finish sign-in: accepts the auth code, or the whole https://localhost/?code=... redirect URL. */
export async function exchangeCode(a: Pick<Account, 'email'>, codeOrUrl: string, verifier: string) {
  const code = codeOrUrl.includes('code=') ? new URL(codeOrUrl).searchParams.get('code')! : codeOrUrl
  return remember(
    a,
    await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: MS.redirect, code_verifier: verifier })
  )
}

export async function accessToken(a: Account): Promise<string> {
  const hit = cache.get(a.email)
  if (hit && hit.expires > Date.now()) return hit.token
  const refresh = getSecret(oauthKey(a))
  const who = isGoogle(a) ? 'Google' : 'Microsoft'
  if (!refresh) throw new AuthError(a.email, `${a.email} needs to sign in with ${who}`)
  try {
    if (isGoogle(a)) {
      const c = needGoogleClient()
      return remember(a, await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh, client_id: c.id, client_secret: c.secret }, GOOGLE.token))
    }
    return remember(a, await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh, scope: MS.scope }))
  } catch (e: any) {
    throw new AuthError(a.email, `${a.email}: ${who} sign-in expired (${e.message})`)
  }
}
