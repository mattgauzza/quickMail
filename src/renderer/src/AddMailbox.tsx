import { useState } from 'react'
import { call } from './lib'

const MICROSOFT = { imap: 'outlook.office365.com', smtp: 'smtp.office365.com:587' }
const GOOGLE = { imap: 'imap.gmail.com', smtp: 'smtp.gmail.com' }
const KNOWN: Record<string, { imap: string; smtp: string; note?: string }> = {
  'gmail.com': { imap: 'imap.gmail.com', smtp: 'smtp.gmail.com', note: 'Gmail needs an app password (Google Account → Security → App passwords), not your normal one.' },
  'yahoo.com': { imap: 'imap.mail.yahoo.com', smtp: 'smtp.mail.yahoo.com', note: 'Yahoo needs an app password from your account security page.' },
  'icloud.com': { imap: 'imap.mail.me.com', smtp: 'smtp.mail.me.com:587', note: 'iCloud needs an app-specific password from appleid.apple.com.' }
}
const clean = (e: any) => String(e?.message ?? e).replace(/^Error invoking remote method '\w+': (Error: )?/, '')

/** Dialog for adding a mailbox by hand. The mailbox is only kept if it signs in. */
export function AddMailbox({ onClose }: { onClose: (added?: string) => void }) {
  const [f, setF] = useState({ email: '', name: '', password: '', imap: '', smtp: '', microsoft: false, google: false })
  const oauth = f.microsoft || f.google
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = (patch: Partial<typeof f>) => setF(v => ({ ...v, ...patch }))
  const domain = f.email.split('@')[1]?.toLowerCase() ?? ''

  // Fill in the servers the first time the address is known; never overwrite what was typed.
  const guess = () => {
    if (!domain || f.imap || f.smtp || oauth) return
    const k = KNOWN[domain]
    set(k ? { imap: k.imap, smtp: k.smtp } : { imap: `mail.${domain}`, smtp: `mail.${domain}` })
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    let id: number | null = null
    try {
      id = await call('addMailbox', { email: f.email, name: f.name, imap: f.imap, smtp: f.smtp, oauth })
      if (oauth) await window.qm.invoke('signIn', id)
      else await call('setPassword', id, f.password)
      await window.qm.invoke('refresh', id)
      const status = (await call('listAccounts')).find(a => a.id === id)?.status ?? ''
      if (status !== 'ok') throw new Error(status === 'auth' ? 'The server refused the sign-in. Check the address and password.' : status.replace(/^error:?\s*/, '') || 'Could not connect')
      onClose(f.email)
    } catch (err) {
      if (id !== null) await call('removeAccount', id).catch(() => {})
      setError(clean(err))
      setBusy(false)
    }
  }

  return (
    <div className="scrim" onMouseDown={e => e.target === e.currentTarget && !busy && onClose()}>
      <form className="dialog" onSubmit={submit}>
        <h2>Add a mailbox</h2>
        <label className="tf">
          <span>Email address</span>
          <input type="email" required autoFocus value={f.email} onChange={e => set({ email: e.target.value })} onBlur={guess} />
        </label>
        <label className="tf">
          <span>Your name (shown to recipients)</span>
          <input value={f.name} onChange={e => set({ name: e.target.value })} />
        </label>
        <label className="check">
          <input
            type="checkbox" checked={f.microsoft}
            onChange={e => set(e.target.checked ? { microsoft: true, google: false, ...MICROSOFT } : { microsoft: false, imap: '', smtp: '' })}
          />
          Microsoft 365 / Outlook account (sign in with Microsoft)
        </label>
        <label className="check">
          <input
            type="checkbox" checked={f.google}
            onChange={e => set(e.target.checked ? { google: true, microsoft: false, ...GOOGLE } : { google: false, imap: '', smtp: '' })}
          />
          Gmail / Google account (sign in with Google in your browser)
        </label>
        {!oauth && (
          <label className="tf">
            <span>Password</span>
            <input type="password" required value={f.password} onChange={e => set({ password: e.target.value })} />
          </label>
        )}
        <div className="pair">
          <label className="tf">
            <span>Incoming server (IMAP)</span>
            <input required placeholder="mail.example.com" spellCheck={false} value={f.imap} onChange={e => set({ imap: e.target.value })} />
          </label>
          <label className="tf">
            <span>Outgoing server (SMTP)</span>
            <input required placeholder="mail.example.com" spellCheck={false} value={f.smtp} onChange={e => set({ smtp: e.target.value })} />
          </label>
        </div>
        <p className="help">
          {f.google ? 'Your browser will open for the Google sign-in. Come back here when it says you are signed in.' : KNOWN[domain]?.note ?? 'Ports 993 and 465 are assumed. Add one after a colon if yours differ, e.g. smtp.example.com:587.'}
        </p>
        {error && <p className="error">{error}</p>}
        <footer>
          {busy && <span className="muted">Connecting…</span>}
          <button type="button" className="text-btn" disabled={busy} onClick={() => onClose()}>Cancel</button>
          <button className="primary" disabled={busy}>Add mailbox</button>
        </footer>
      </form>
    </div>
  )
}
