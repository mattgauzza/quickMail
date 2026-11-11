import { useEffect, useRef, useState } from 'react'
import { type Account, type FileRef, type Message, Icon, IconButton, call, esc, fileSize, fmt, longDate, sanitize } from './lib'

export interface ComposeState {
  from: number
  to: string
  cc: string
  bcc: string
  subject: string
  /** Initial editor content (already sanitized). */
  html: string
  replyTo?: number
  forward?: number
  title: string
}

export const blankDraft = (from: number): ComposeState => ({ from, to: '', cc: '', bcc: '', subject: '', html: '', title: 'New message' })

/** Build a reply / reply-all / forward draft for a message, quoting it the way Gmail does. */
export function replyDraft(m: Message, mode: 'reply' | 'all' | 'forward'): ComposeState {
  const me = m.account.toLowerCase()
  const body = m.html ? sanitize(m.html) : esc(m.text).replace(/\n/g, '<br>')
  const to = mode === 'forward' ? [] : m.from.address === me ? m.to : [m.from]
  const cc = mode === 'all' ? [...m.to, ...m.cc].filter(p => p.address !== me && !to.some(t => t.address === p.address)) : []
  const prefix = mode === 'forward' ? 'Fwd: ' : 'Re: '
  const subject = new RegExp(`^${prefix.trim()}`, 'i').test(m.subject) ? m.subject : prefix + m.subject
  const quote =
    mode === 'forward'
      ? `<br><br><div>---------- Forwarded message ----------<br>From: ${esc(fmt(m.from))}<br>Date: ${esc(longDate(m.date))}<br>Subject: ${esc(m.subject)}<br>To: ${esc(m.to.map(fmt).join(', '))}<br><br>${body}</div>`
      : `<br><br><div>On ${esc(longDate(m.date))}, ${esc(fmt(m.from))} wrote:<blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${body}</blockquote></div>`
  return {
    from: m.accountId, to: to.map(fmt).join(', '), cc: cc.map(fmt).join(', '), bcc: '', subject, html: quote,
    replyTo: mode === 'forward' ? undefined : m.id, forward: mode === 'forward' ? m.id : undefined,
    title: mode === 'forward' ? 'Forward' : 'Reply'
  }
}

function Recipients(p: { label: string; value: string; onChange: (v: string) => void; autoFocus?: boolean; extra?: React.ReactNode }) {
  const [options, setOptions] = useState<{ email: string; name: string }[]>([])
  const [sel, setSel] = useState(0)
  const token = p.value.split(',').pop()!.trim()

  useEffect(() => {
    if (!token) return setOptions([])
    let live = true
    call('searchContacts', token, 6).then(r => {
      if (!live) return
      setOptions(r.filter(c => !p.value.toLowerCase().includes(c.email)))
      setSel(0)
    })
    return () => { live = false }
  }, [token])

  const pick = (c: { email: string; name: string }) => {
    const kept = p.value.split(',').slice(0, -1).map(s => s.trim()).filter(Boolean)
    const name = c.name.includes(',') ? `"${c.name}"` : c.name
    p.onChange([...kept, name ? `${name} <${c.email}>` : c.email].join(', ') + ', ')
    setOptions([])
  }

  return (
    <div className="field">
      <label>{p.label}</label>
      <input
        value={p.value} autoFocus={p.autoFocus} spellCheck={false}
        onChange={e => p.onChange(e.target.value)}
        onBlur={() => setTimeout(() => setOptions([]), 150)}
        onKeyDown={e => {
          if (!options.length) return
          if (e.key === 'ArrowDown') (e.preventDefault(), setSel((sel + 1) % options.length))
          else if (e.key === 'ArrowUp') (e.preventDefault(), setSel((sel + options.length - 1) % options.length))
          else if (e.key === 'Enter' || e.key === 'Tab') (e.preventDefault(), pick(options[sel]))
          else if (e.key === 'Escape') (e.stopPropagation(), setOptions([]))
        }}
      />
      {p.extra}
      {options.length > 0 && (
        <ul className="suggest">
          {options.map((c, i) => (
            <li key={c.email} className={i === sel ? 'sel' : ''} onMouseDown={e => (e.preventDefault(), pick(c))}>
              <b>{c.name || c.email}</b>
              {c.name && <span>{c.email}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function Compose(p: { initial: ComposeState; accounts: Account[]; onClose: () => void; onSent: (msg: string) => void }) {
  const [d, setD] = useState(p.initial)
  const [showCc, setShowCc] = useState(!!p.initial.cc)
  const [files, setFiles] = useState<FileRef[]>([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const editor = useRef<HTMLDivElement>(null)
  const set = (patch: Partial<ComposeState>) => setD(x => ({ ...x, ...patch }))

  useEffect(() => {
    const el = editor.current!
    el.innerHTML = p.initial.html
    // Replies start in the body with the cursor above the quote; new mail starts in "To".
    if (p.initial.to) {
      el.focus()
      window.getSelection()?.collapse(el, 0)
    }
  }, [])

  const dirty = () => (editor.current?.innerText.trim() ?? '') !== '' && editor.current!.innerHTML !== p.initial.html
  const close = () => {
    if (!dirty() || confirm('Discard this message?')) p.onClose()
  }

  const send = async () => {
    if (!d.to.trim()) return setError('Add at least one recipient.')
    if (!d.subject.trim() && !confirm('Send this message without a subject?')) return
    setSending(true)
    setError('')
    try {
      const el = editor.current!
      await call('send', {
        from: d.from, to: d.to, cc: d.cc || undefined, bcc: d.bcc || undefined, subject: d.subject,
        html: el.innerHTML, text: el.innerText, attachments: files.map(f => ({ path: f.path, filename: f.name })),
        replyTo: d.replyTo, forward: d.forward
      })
      p.onSent('Message sent')
    } catch (e: any) {
      setError(String(e.message).replace(/^Error invoking remote method '\w+': (Error: )?/, ''))
      setSending(false)
    }
  }

  const addFiles = (more: FileRef[]) => setFiles(f => [...f, ...more.filter(m => !f.some(x => x.path === m.path))])

  return (
    <div
      className="compose"
      onKeyDown={e => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send()
        if (e.key === 'Escape') close()
      }}
      onDragOver={e => e.preventDefault()}
      onDrop={async e => {
        e.preventDefault()
        const dropped = [...e.dataTransfer.files].map(f => window.qm.pathFor(f)).filter(Boolean)
        addFiles(await Promise.all(dropped.map(path => window.qm.invoke('fileInfo', path))))
      }}
    >
      <header>
        <span>{d.subject || d.title}</span>
        <IconButton icon="close" label="Close" size={18} onClick={close} />
      </header>
      {p.accounts.length > 1 && (
        <div className="field">
          <label>From</label>
          <select value={d.from} onChange={e => set({ from: Number(e.target.value) })}>
            {p.accounts.map(a => <option key={a.id} value={a.id}>{a.name ? `${a.name} <${a.email}>` : a.email}</option>)}
          </select>
        </div>
      )}
      <Recipients
        label="To" value={d.to} onChange={to => set({ to })} autoFocus={!p.initial.to}
        extra={!showCc && <button className="link" onClick={() => setShowCc(true)}>Cc Bcc</button>}
      />
      {showCc && <Recipients label="Cc" value={d.cc} onChange={cc => set({ cc })} />}
      {showCc && <Recipients label="Bcc" value={d.bcc} onChange={bcc => set({ bcc })} />}
      <div className="field">
        <input placeholder="Subject" value={d.subject} onChange={e => set({ subject: e.target.value })} />
      </div>
      <div className="editor" ref={editor} contentEditable suppressContentEditableWarning />
      {(files.length > 0 || d.forward) && (
        <div className="chips">
          {d.forward && <span className="chip muted">Original attachments are included</span>}
          {files.map(f => (
            <span className="chip" key={f.path}>
              <Icon name="attach" size={14} /> {f.name} <i>{fileSize(f.size)}</i>
              <button aria-label={`Remove ${f.name}`} onClick={() => setFiles(fs => fs.filter(x => x !== f))}><Icon name="close" size={14} /></button>
            </span>
          ))}
        </div>
      )}
      {error && <div className="compose-error">{error}</div>}
      <footer>
        <button className="primary" disabled={sending} onClick={send}>{sending ? 'Sending…' : 'Send'}</button>
        <IconButton icon="attach" label="Attach files" onClick={async () => addFiles(await window.qm.invoke('pickFiles'))} />
        <span className="hint">Ctrl+Enter to send</span>
        <IconButton icon="trash" label="Discard" onClick={close} />
      </footer>
    </div>
  )
}
