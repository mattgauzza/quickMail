import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { type Account, Icon, call } from './lib'

type Bundle = { code: string; passphrase: string; count: number; missing: string[] }

/** Settings → Phone: a QR code the Android app scans to add these mailboxes, with the passphrase beside it. */
export function PhoneExport(p: { accounts: Account[] }) {
  const [picked, setPicked] = useState<Set<number>>(() => new Set(p.accounts.map(a => a.id)))
  const [bundle, setBundle] = useState<Bundle | null>(null)
  const [image, setImage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // The code holds passwords (sealed), so it is never kept: it goes when this tab closes, or after five minutes.
  useEffect(() => {
    if (!bundle) return
    const t = setTimeout(() => (setBundle(null), setImage('')), 5 * 60_000)
    return () => clearTimeout(t)
  }, [bundle])

  const make = async () => {
    setBusy(true)
    setError('')
    try {
      const b: Bundle = await call('exportBundle', [...picked])
      setImage(await QRCode.toDataURL(b.code, { errorCorrectionLevel: 'L', margin: 2, width: 320, color: { dark: '#000000', light: '#ffffff' } }))
      setBundle(b)
    } catch (e) {
      setError(String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
    setBusy(false)
  }
  const toggle = (id: number) => setPicked(s => {
    const n = new Set(s)
    if (n.has(id)) n.delete(id); else n.add(id)
    return n
  })
  const kind = (a: Account) => (a.auth !== 'oauth2' ? 'password' : a.provider)

  if (bundle) {
    return (
      <div className="phone-export">
        <div className="phone-code">
          <img src={image} width={320} height={320} alt="QR code for the Qmail phone app" />
          <div className="phone-steps">
            <ol>
              <li>On the phone, open Qmail and tap <b>Import from computer</b> (in the menu, or on the first screen).</li>
              <li>Scan this code.</li>
              <li>Type this passphrase:</li>
            </ol>
            <p className="passphrase" aria-label="Passphrase">{bundle.passphrase}</p>
            <p className="help">
              The code holds {bundle.count === 1 ? 'one mailbox' : `${bundle.count} mailboxes`}, sealed with the passphrase.
              Without it the code is useless, so don't photograph the two together.
            </p>
            {bundle.missing.length > 0 && (
              <p className="help warn">No saved password for {bundle.missing.join(', ')}, so the phone can't read {bundle.missing.length === 1 ? 'it' : 'them'}. Add {bundle.missing.length === 1 ? 'it' : 'them'} on the phone by hand instead.</p>
            )}
            <button type="button" className="text-btn" onClick={() => (setBundle(null), setImage(''))}>Hide code</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="phone-export">
      <p className="help">
        Add these mailboxes to Qmail on your phone without typing them in. Nothing goes through a server: the phone reads a QR code
        from this screen. Password mailboxes arrive ready to use. Google mailboxes bring their sign-in with them;
        Microsoft mailboxes can't be used on the phone yet.
      </p>
      <ul className="rules">
        {p.accounts.map(a => (
          <li key={a.id}>
            <label className="check phone-pick">
              <input type="checkbox" checked={picked.has(a.id)} onChange={() => toggle(a.id)} />
              <span className="dot" style={{ background: a.color }} /> <span>{a.email}</span>
              <small className="muted">{kind(a) === 'password' ? 'Password' : kind(a) === 'Google' ? 'Google: signed in' : 'Microsoft: not on the phone yet'}</small>
            </label>
          </li>
        ))}
      </ul>
      {error && <p className="error">{error}</p>}
      <button type="button" className="primary" disabled={busy || picked.size === 0} onClick={make}>
        <Icon name="popout" size={18} /> {busy ? 'Making the code…' : 'Show QR code'}
      </button>
    </div>
  )
}
