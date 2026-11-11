import crypto from 'node:crypto'
import nodemailer from 'nodemailer'
import MailComposer from 'nodemailer/lib/mail-composer'
import { type Account, account, get } from './db'
import { folderByRole, parseRaw, setFlags, syncFolder, withImap } from './imap'
import { accessToken } from './oauth'
import { AuthError, getSecret, passwordKey } from './secrets'

export interface Draft {
  /** Account id or email to send from. */
  from: number | string
  to: string | string[]
  cc?: string | string[]
  bcc?: string | string[]
  subject: string
  text?: string
  html?: string
  attachments?: { path?: string; filename?: string; content?: string; contentType?: string }[]
  /** Message id this is a reply to: sets the threading headers and marks the original answered. */
  replyTo?: number
  /** Message id being forwarded: its attachments are carried over. */
  forward?: number
  /** A calendar part (e.g. the answer to an invitation), sent as text/calendar alongside the text. */
  ical?: { method: string; content: string }
}

async function transport(a: Account) {
  const auth =
    a.auth === 'oauth2'
      ? { type: 'OAuth2' as const, user: a.username, accessToken: await accessToken(a) }
      : { user: a.username, pass: getSecret(passwordKey(a)) ?? '' }
  if ('pass' in auth && !auth.pass) throw new AuthError(a.email, `${a.email} has no saved password`)
  return nodemailer.createTransport({ host: a.smtp_host, port: a.smtp_port, secure: !!a.smtp_secure, auth } as any)
}

export async function send(d: Draft) {
  const a = account(d.from)
  const headers: Record<string, any> = {}
  if (d.replyTo) {
    const orig = get<{ message_id: string; refs: string }>('SELECT message_id, refs FROM messages WHERE id=?', d.replyTo)
    if (!orig) throw new Error(`No message with id ${d.replyTo} to reply to`)
    headers.inReplyTo = orig.message_id
    headers.references = [...orig.refs.split(' ').filter(Boolean), orig.message_id]
  }
  const attachments: any[] = (d.attachments || []).map(x =>
    x.path
      ? { path: x.path, filename: x.filename }
      : { filename: x.filename, content: Buffer.from(x.content || '', 'base64'), contentType: x.contentType }
  )
  if (d.forward)
    for (const x of (await parseRaw(d.forward)).attachments)
      if (!x.related) attachments.push({ filename: x.filename, content: x.content, contentType: x.contentType })

  const messageId = `<${crypto.randomUUID()}@${a.email.split('@')[1]}>`
  const node = new MailComposer({
    from: { name: a.name, address: a.email },
    to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject,
    text: d.text, html: d.html, attachments, messageId, date: new Date(), ...headers,
    ...(d.ical ? { icalEvent: { method: d.ical.method, content: d.ical.content } } : {})
  }).compile()
  const envelope = node.getEnvelope()
  if (!envelope.to?.length) throw new Error('No recipients')
  const raw = await node.build()

  await (await transport(a)).sendMail({ envelope, raw })

  // Keep a copy in Sent. Microsoft and Google file it themselves; everyone else needs an append.
  const filedByServer = /office365|outlook|gmail|googlemail/i.test(a.smtp_host)
  const sent = folderByRole(a.id, 'sent')
  if (sent)
    await withImap(a, async c => {
      if (!filedByServer) await c.append(sent.path, raw, ['\\Seen'])
      await syncFolder(c, a, sent)
    }).catch(() => {})
  if (d.replyTo) await setFlags([d.replyTo], { answered: true }).catch(() => {})
  return { messageId, from: a.email, to: envelope.to }
}
