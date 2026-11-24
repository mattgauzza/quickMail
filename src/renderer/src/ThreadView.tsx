import { useEffect, useMemo, useRef, useState } from 'react'
import { type ComposeState, replyDraft } from './Compose'
import { type Message, type Meta, type Thread, Icon, IconButton, avatarColor, call, esc, fileKind, fileSize, longDate, shortDate, who } from './lib'
import { findCodes } from './Codes'

type Att = Message['attachments'][number]

function Attachments({ id, files }: { id: number; files: Att[] }) {
  const [saved, setSaved] = useState<Record<number, string>>({})
  const [note, setNote] = useState<{ text: string; file?: string } | null>(null)
  const total = files.reduce((n, f) => n + (f.size || 0), 0)
  const fail = (e: unknown) => setNote({ text: `Couldn't do that: ${String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}` })
  const saveAll = async () => {
    try {
      const paths = await window.qm.invoke('saveAllAttachments', id, files.map(f => ({ index: f.index, filename: f.filename })))
      if (!paths) return
      setSaved(Object.fromEntries(files.map((f, i) => [f.index, paths[i]])))
      setNote({ text: `Saved ${paths.length} files`, file: paths[0] })
    } catch (e) { fail(e) }
  }
  return (
    <section className="files">
      <div className="files-head">
        <Icon name="attach" size={16} />
        <span>{files.length === 1 ? '1 attachment' : `${files.length} attachments`} · {fileSize(total)}</span>
        {files.length > 1 && <button type="button" className="link" onClick={saveAll}>Save all</button>}
        {note && (
          <span className="files-note">
            {note.text}
            {note.file && <button type="button" className="link" onClick={() => window.qm.invoke('showInFolder', note.file)}>Show in folder</button>}
          </span>
        )}
      </div>
      <div className="file-grid">
        {files.map(f => {
          const k = fileKind(f)
          const open = () => window.qm.invoke('openAttachment', id, f.index).catch(fail)
          const where = saved[f.index]
          return (
            <div className="file" key={f.index} role="button" tabIndex={0} title={`Open ${f.filename}`} onClick={open}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } }}>
              <span className="file-badge" style={{ background: k.color }}>{k.label}</span>
              <span className="file-text">
                <b>{f.filename}</b>
                <small>{where ? 'Saved' : `${k.name} · ${fileSize(f.size)}`}</small>
              </span>
              <span className="file-actions" onClick={e => e.stopPropagation()}>
                {where
                  ? <IconButton icon="folder" label="Show in folder" size={18} onClick={() => window.qm.invoke('showInFolder', where)} />
                  : <IconButton icon="download" label={`Save ${f.filename}…`} size={18} onClick={async () => {
                      try {
                        const p = await window.qm.invoke('saveAttachment', id, f.index, f.filename)
                        if (p) setSaved(s => ({ ...s, [f.index]: p }))
                      } catch (e) { fail(e) }
                    }} />}
              </span>
            </div>
          )
        })}
      </div>
    </section>
  )
}

const ROLE_LABEL: Record<string, string> ={ inbox: 'Inbox', sent: 'Sent', drafts: 'Drafts', archive: 'Archive', junk: 'Spam', trash: 'Trash' }

/** Email HTML is shown in a script-less sandboxed frame with its own strict content policy. */
function Body({ html, text }: { html: string; text: string }) {
  const ref = useRef<HTMLIFrameElement>(null)
  const doc = useMemo(
    () =>
      `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'; font-src data: https:">
<base target="_blank">
<style>html{overflow:hidden}body{margin:0;padding:1px 0;font:14px/1.5 'Segoe UI',Roboto,Arial,sans-serif;color:#202124;background:#fff;overflow-wrap:anywhere}
img{max-width:100%}img:not([height]){height:auto}table{max-width:100%}pre{white-space:pre-wrap;font:inherit;margin:0}
blockquote{margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex}a{color:#0b57d0}</style></head>
<body>${html || `<pre>${esc(text)}</pre>`}</body></html>`,
    [html, text]
  )
  // The address of the link under the pointer, shown in the corner as a browser does, so a fake link can be spotted.
  const [hover, setHover] = useState('')
  const fit = () => {
    const f = ref.current
    const d = f?.contentDocument
    if (f && d?.body) f.style.height = `${Math.max(d.body.scrollHeight, d.documentElement.scrollHeight)}px`
  }
  return (
    <>
      <iframe
        ref={ref} className="body" title="Message" srcDoc={doc}
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        onMouseLeave={() => setHover('')}
        onLoad={() => {
          const d = ref.current?.contentDocument
          if (d?.body) linkify(d)
          fit()
          if (d?.body) new ResizeObserver(fit).observe(d.body)
          d?.addEventListener('keydown', e => {
            if (e.ctrlKey || e.metaKey || e.altKey) {
              // Leave copy, select-all and friends alone; find and undo belong to the app.
              if (!e.altKey && /^[fz]$/i.test(e.key)) (e.preventDefault(), window.dispatchEvent(new KeyboardEvent('keydown', { key: e.key, ctrlKey: true, shiftKey: e.shiftKey })))
              return
            }
            window.dispatchEvent(new KeyboardEvent('keydown', { key: e.key, shiftKey: e.shiftKey }))
          })
          // Find (Ctrl+F) marks matches in here too; the frame needs its own copy of the marker styles.
          const st = d?.createElement('style')
          if (st) (st.textContent = FIND_CSS, d!.head.append(st))
          d?.addEventListener('mouseover', e => {
            const a = (e.target as Element | null)?.closest?.('a[href]')
            setHover(a?.getAttribute('href')?.trim() ?? '')
          })
        }}
      />
      {hover && <LinkPeek href={hover} />}
    </>
  )
}

const FIND_CSS = '::highlight(qm-find){background:#fde293;color:#202124}::highlight(qm-find-cur){background:#f9a825;color:#202124}'

/** Every place the words appear in the conversation, the message frames included, as ranges in their own documents. */
function findRanges(root: HTMLElement, q: string): Range[] {
  const out: Range[] = []
  const needle = q.toLowerCase()
  const scan = (doc: Document, from: Node) => {
    const walker = doc.createTreeWalker(from, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement
      if (!el || el.closest('script, style, title, .findbar')) continue
      const text = (n.textContent ?? '').toLowerCase()
      for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
        const r = doc.createRange()
        r.setStart(n, at)
        r.setEnd(n, at + needle.length)
        out.push(r)
      }
    }
  }
  // Walk in reading order, stepping into each message frame where it sits.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n instanceof HTMLIFrameElement) { const d = n.contentDocument; if (d?.body) scan(d, d.body); continue }
    if (n.nodeType !== Node.TEXT_NODE) continue
    const el = n.parentElement
    if (!el || el.closest('.findbar')) continue
    const text = (n.textContent ?? '').toLowerCase()
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
      const r = document.createRange()
      r.setStart(n, at)
      r.setEnd(n, at + needle.length)
      out.push(r)
    }
  }
  return out
}

/** Paints the matches, the current one brighter, in every document they belong to. */
function paint(ranges: Range[], cur: number, docs: Document[]) {
  for (const d of docs) {
    const w = d.defaultView as any
    if (!w?.CSS?.highlights) continue
    const mine = ranges.filter(r => r.startContainer.ownerDocument === d)
    w.CSS.highlights.set('qm-find', new w.Highlight(...mine.filter(r => r !== ranges[cur])))
    w.CSS.highlights.set('qm-find-cur', new w.Highlight(...mine.filter(r => r === ranges[cur])))
  }
}
const unpaint = (docs: Document[]) => docs.forEach(d => { const w = d.defaultView as any; w?.CSS?.highlights?.delete('qm-find'); w?.CSS?.highlights?.delete('qm-find-cur') })

/** Ctrl+F inside the open conversation: highlights every match and steps through them. */
function FindBar({ root, onClose }: { root: React.RefObject<HTMLDivElement | null>; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<Range[]>([])
  const [cur, setCur] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const docs = () => [document, ...[...(root.current?.querySelectorAll('iframe') ?? [])].map(f => f.contentDocument).filter((d): d is Document => !!d)]
  useEffect(() => {
    const focus = () => (input.current?.focus(), input.current?.select())
    focus()
    window.addEventListener('qm-find', focus)
    return () => (window.removeEventListener('qm-find', focus), unpaint(docs()))
  }, [])
  useEffect(() => {
    // Messages still loading add text after a moment, so look again shortly.
    const run = () => {
      const found = q.trim() && root.current ? findRanges(root.current, q.trim()) : []
      setHits(found)
      setCur(c => (c < found.length ? c : 0))
    }
    run()
    const again = setTimeout(run, 600)
    return () => clearTimeout(again)
  }, [q])
  useEffect(() => {
    paint(hits, cur, docs())
    const r = hits[cur]
    const el = r?.startContainer.parentElement
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [hits, cur])
  const step = (d: number) => hits.length && setCur(c => (c + d + hits.length) % hits.length)
  return (
    <div className="findbar" onKeyDown={e => {
      if (e.key === 'Escape') (e.stopPropagation(), e.preventDefault(), onClose())
      else if (e.key === 'Enter') (e.preventDefault(), step(e.shiftKey ? -1 : 1))
    }}>
      <input ref={input} value={q} onChange={e => setQ(e.target.value)} placeholder="Find in this email" spellCheck={false} aria-label="Find in this email" />
      <span className="muted">{q.trim() ? (hits.length ? `${cur + 1} of ${hits.length}` : 'No matches') : ''}</span>
      <IconButton icon="up" size={18} label="Previous match (Shift+Enter)" onClick={() => step(-1)} />
      <IconButton icon="down" size={18} label="Next match (Enter)" onClick={() => step(1)} />
      <IconButton icon="close" size={18} label="Close (Esc)" onClick={onClose} />
    </div>
  )
}

const URL_IN_TEXT = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi

/** The address without punctuation that ends the sentence around it (a closing bracket is kept when it has an opening one). */
function trimUrl(url: string) {
  for (;;) {
    const before = url
    url = url.replace(/[.,;:!?'"*]+$/, '')
    if (url.endsWith(')') && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) url = url.slice(0, -1)
    if (url.endsWith(']') && !url.includes('[')) url = url.slice(0, -1)
    if (url === before) return url
  }
}

/** Turns web addresses written as plain text into links (built as elements, never as HTML). */
function linkify(d: Document) {
  const walker = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT)
  const hits: Text[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.parentElement?.closest('a, script, style, textarea, title')) continue
    if (/\b(?:https?:\/\/|www\.)/i.test(n.textContent ?? '')) hits.push(n as Text)
  }
  for (const node of hits) {
    const text = node.textContent ?? ''
    const frag = d.createDocumentFragment()
    let last = 0
    for (const m of text.matchAll(URL_IN_TEXT)) {
      const url = trimUrl(m[0])
      const at = m.index ?? 0
      if (url.length < 8) continue
      frag.append(text.slice(last, at))
      const a = d.createElement('a')
      a.href = /^www\./i.test(url) ? `https://${url}` : url
      a.textContent = url
      frag.append(a)
      last = at + url.length
    }
    frag.append(text.slice(last))
    node.replaceWith(frag)
  }
}

/** A link's real address in the bottom-left corner, with its site in bold. */
function LinkPeek({ href }: { href: string }) {
  let url: URL | null = null
  try { url = new URL(href) } catch { /* not a full address; shown as written */ }
  const style: React.CSSProperties = {
    position: 'fixed', left: 8, bottom: 8, zIndex: 1000, maxWidth: '70vw', padding: '4px 10px', borderRadius: 6,
    font: '12px/1.5 "Segoe UI", Roboto, Arial, sans-serif', color: '#e8eaed', background: '#202124',
    border: '1px solid rgba(255,255,255,.18)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', pointerEvents: 'none'
  }
  if (!url || !/^https?:$/.test(url.protocol)) return <div style={style}>{href}</div>
  const rest = url.href.slice(url.origin.length)
  return <div style={style}>{url.protocol}//<b>{url.host}</b>{rest}</div>
}

/** Copies text to the clipboard; `copied` holds the last value copied for two seconds, to show a tick. */
function useCopy() {
  const [copied, setCopied] = useState('')
  const copy = (value: string) => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(value)
      setTimeout(() => setCopied(c => (c === value ? '' : c)), 2000)
    }, () => { /* clipboard refused; nothing to show */ })
  }
  return [copied, copy] as const
}

/** The sender's name and address with a copy button each, opened by clicking the sender. */
function ContactCard({ name, address, color, onClose }: { name: string; address: string; color: string; onClose: () => void }) {
  const [copied, copy] = useCopy()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // Clicks on the sender line itself are left to its own toggle, so a second click closes the card.
    const away = (e: MouseEvent) => { if (!ref.current?.parentElement?.contains(e.target as Node)) onClose() }
    // Escape closes the card, not the conversation behind it.
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') (e.stopPropagation(), onClose()) }
    window.addEventListener('mousedown', away)
    window.addEventListener('keydown', key, true)
    return () => { window.removeEventListener('mousedown', away); window.removeEventListener('keydown', key, true) }
  }, [])
  const line = (label: string, value: string) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', userSelect: 'text' }} title={value}>{value}</span>
      <IconButton icon={copied === value ? 'check' : 'copy'} size={18} label={copied === value ? 'Copied' : `Copy ${label}`} onClick={() => copy(value)} />
    </div>
  )
  return (
    <div
      ref={ref} onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}
      style={{
        position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 20, width: 340, maxWidth: '80vw', padding: '14px 10px 10px 16px',
        borderRadius: 12, background: 'var(--surface)', border: '1px solid var(--line)', boxShadow: 'var(--shadow)', cursor: 'default', fontWeight: 400
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <span className="avatar" style={{ background: color }}>{(name || address)[0]?.toUpperCase() ?? '?'}</span>
        <b style={{ fontSize: 15, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name || address}</b>
      </div>
      {name && line('name', name)}
      <div className="muted">{line('email address', address)}</div>
    </div>
  )
}

/** Copy buttons for a one-time code or sign-in link found in the message. */
function CopyBar({ html, text }: { html: string; text: string }) {
  const found = useMemo(() => findCodes(html, text), [html, text])
  const [copied, copy] = useCopy()
  if (!found.codes.length && !found.links.length) return null
  const row = { display: 'flex', gap: 8, flexWrap: 'wrap' as const, margin: '0 0 8px' }
  return (
    <div style={row}>
      {found.codes.map(c => (
        <button key={c} className="tonal" title="Copy this code" onClick={() => copy(c)}>{copied === c ? 'Copied' : `Copy code ${c}`}</button>
      ))}
      {found.links.map(l => (
        <button key={l.href} className="tonal" title={l.href} onClick={() => copy(l.href)}>{copied === l.href ? 'Copied' : `Copy ${l.label.toLowerCase()} link`}</button>
      ))}
    </div>
  )
}

const ANSWERS = [['ACCEPTED', 'Yes'], ['TENTATIVE', 'Maybe'], ['DECLINED', 'No']] as const
const SAID: Record<string, string> = { ACCEPTED: 'You said yes', TENTATIVE: 'You said maybe', DECLINED: 'You said no' }

/** Summary of a calendar invitation with one-click answers, shown above the message. */
function InviteCard({ id, invite }: { id: number; invite: NonNullable<Message['invite']> }) {
  const key = `qm.rsvp.${invite.uid}`
  const [said, setSaid] = useState(() => { try { return localStorage.getItem(key) ?? '' } catch { return '' } })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const start = new Date(invite.start)
  const end = new Date(invite.end)
  const day = (d: Date) => d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })
  const time = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const sameDay = start.toDateString() === end.toDateString()
  const whenText = invite.allDay
    ? day(start)
    : `${day(start)} • ${time(start)} – ${sameDay ? '' : `${day(end)} `}${time(end)}`
  const cancelled = invite.method === 'CANCEL'

  const answer = async (a: (typeof ANSWERS)[number][0]) => {
    setBusy(true)
    setError('')
    try {
      await call('respondInvite', id, a)
      setSaid(a)
      try { localStorage.setItem(key, a) } catch { /* the answer was sent; it just won't be remembered here */ }
    } catch (e: any) {
      setError(String(e?.message ?? e).replace(/^Error invoking remote method '\w+': (Error: )?/, ''))
    }
    setBusy(false)
  }

  return (
    <section className="invite">
      <div className="invite-when">{whenText}{cancelled && ' • Cancelled'}</div>
      <div className="invite-title">{invite.summary}</div>
      <div className="invite-meta">
        {invite.organizer && <span><Icon name="person" size={18} /> {invite.organizer.name || invite.organizer.email} <i>- Organizer</i></span>}
        {invite.location && <span><Icon name="place" size={18} /> {invite.location}</span>}
        {invite.attendees.length > 1 && <span title={invite.attendees.map(a => a.name || a.email).join(', ')}><Icon name="people" size={18} /> {invite.attendees.length} invited</span>}
      </div>
      {invite.method === 'REQUEST' && invite.organizer && (
        <div className="invite-actions">
          {ANSWERS.map(([a, label]) => (
            <button key={a} className={said === a ? 'primary' : 'tonal'} disabled={busy} title={`Answer "${label}" and tell the organizer`} onClick={() => answer(a)}>{label}</button>
          ))}
          <span className="muted">{busy ? 'Sending your answer…' : said ? `${SAID[said]}. The organizer has been told.` : ''}</span>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  )
}

function Card(p: { meta: Meta; open: boolean; toggle: () => void; onCompose: (c: ComposeState) => void; onStar: () => void; registerLatest?: (m: Message) => void }) {
  const { meta } = p
  const [msg, setMsg] = useState<Message | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!p.open || msg) return
    call('getMessage', meta.id, true).then(m => (setMsg(m), p.registerLatest?.(m)), e => setError(String(e.message)))
  }, [p.open, meta.id])

  const name = who(meta.from)
  const [contact, setContact] = useState(false)
  return (
    <article className={`card${p.open ? ' open' : ''}`}>
      <header onClick={p.toggle} title={p.open ? 'Click to collapse this message' : 'Click to show this message'}>
        <span className="avatar" title={meta.from.address} style={{ background: avatarColor(meta.from.address) }}>{name[0]?.toUpperCase() ?? '?'}</span>
        <div className="who" style={{ position: 'relative' }}>
          <div
            className={p.open ? 'sender' : undefined}
            title={p.open ? 'Show contact card' : undefined}
            // On an open message, clicking the sender opens (or closes) the contact card instead of collapsing the message.
            onClick={e => p.open && (e.stopPropagation(), setContact(c => !c))}
            onMouseDown={e => p.open && e.detail > 1 && e.preventDefault()} // a quick second click shouldn't select the text
          >
            <b title={meta.from.address}>{name}</b>
            {p.open && <span className="addr">&lt;{meta.from.address}&gt;</span>}
          </div>
          {contact && p.open && (
            <ContactCard name={meta.from.name} address={meta.from.address} color={avatarColor(meta.from.address)} onClose={() => setContact(false)} />
          )}
          <div className="sub" title={p.open ? [...meta.to, ...meta.cc].map(x => x.address).join(', ') : undefined}>{p.open ? `to ${[...meta.to, ...meta.cc].map(who).join(', ') || 'undisclosed recipients'}` : meta.snippet}</div>
        </div>
        <time title={longDate(meta.date)}>{p.open ? longDate(meta.date) : shortDate(meta.date)}</time>
        <span onClick={e => e.stopPropagation()} className="card-actions">
          <IconButton icon={meta.starred ? 'star' : 'starOff'} label={meta.starred ? 'Remove star (s)' : 'Star (s)'} active={meta.starred} onClick={p.onStar} />
          {p.open && msg && <IconButton icon="reply" label="Reply (r)" onClick={() => p.onCompose(replyDraft(msg, 'reply'))} />}
        </span>
      </header>
      {p.open && (
        <div className="card-body">
          {error ? <p className="error">Could not load this message: {error}</p> : !msg ? <p className="muted">Loading…</p> : (
            <>
              {msg.invite && <InviteCard id={msg.id} invite={msg.invite} />}
              <CopyBar html={msg.html} text={msg.text} />
              <div className="paper"><Body html={msg.html} text={msg.text} /></div>
              {msg.attachments.length > 0 && <Attachments id={msg.id} files={msg.attachments} />}
            </>
          )}
        </div>
      )}
    </article>
  )
}

export function ThreadView(p: {
  thread: Pick<Thread, 'id' | 'role' | 'folder'>
  /** full: replaces the list. split: beside the list. window: a window of its own. */
  mode?: 'full' | 'split' | 'window'
  onPopout?: () => void
  onBack: () => void
  onAct: (kind: 'archive' | 'trash' | 'junk' | 'inbox' | 'unread') => void
  onCompose: (c: ComposeState) => void
  /** Lets the app's keyboard shortcuts (r / a / f) reach the newest message. */
  latest: React.MutableRefObject<Message | null>
}) {
  const [metas, setMetas] = useState<Meta[] | null>(null)
  const [open, setOpen] = useState<Set<number>>(new Set())
  const hidden = ['trash', 'junk'].includes(p.thread.role)
  const [finding, setFinding] = useState(false)
  const threadRef = useRef<HTMLDivElement>(null)
  const metasRef = useRef<Meta[] | null>(null)
  metasRef.current = metas
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== 'f') return
      if ((e.target as HTMLElement)?.closest?.('.compose')) return
      e.preventDefault()
      e.stopImmediatePropagation()
      // Every message is opened, so the words are found in all of them, not only the newest.
      if (metasRef.current) setOpen(new Set(metasRef.current.map(m => m.id)))
      setFinding(true)
      window.dispatchEvent(new Event('qm-find')) // already open: focus it again
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [])
  useEffect(() => setFinding(false), [p.thread.id])

  useEffect(() => {
    let first = true
    p.latest.current = null
    const load = () =>
      call('getThread', p.thread.id, hidden).then(
        ms => {
          setMetas(ms)
          if (!first) return
          first = false
          const unread = ms.filter(m => m.unread).map(m => m.id)
          setOpen(new Set([...unread, ms[ms.length - 1].id]))
          if (unread.length) call('setFlags', unread, { seen: true }).catch(() => {})
        },
        () => p.onBack() // the conversation is gone (moved or deleted elsewhere)
      )
    load()
    return window.qm.on('changed', load)
  }, [p.thread.id])

  if (!metas) return <div className="pane" />
  const last = metas[metas.length - 1]
  const compose = async (mode: 'reply' | 'all' | 'forward') => p.onCompose(replyDraft(p.latest.current ?? (await call('getMessage', last.id, true)), mode))
  const many = last.to.length + last.cc.length > 1

  return (
    <div className="pane">
      <div className="toolbar">
        {p.mode === 'split'
          ? <IconButton icon="close" label="Close (u)" onClick={p.onBack} />
          : p.mode !== 'window' && <IconButton icon="back" label="Back (u)" onClick={p.onBack} />}
        {p.thread.role === 'inbox'
          ? <IconButton icon="archive" label="Archive (e)" onClick={() => p.onAct('archive')} />
          : <IconButton icon="inbox" label="Move to Inbox" onClick={() => p.onAct('inbox')} />}
        {p.thread.role !== 'junk' && <IconButton icon="junk" label="Report spam (!)" onClick={() => p.onAct('junk')} />}
        <IconButton icon="trash" label={p.thread.role === 'trash' ? 'Delete forever' : 'Delete (#)'} onClick={() => p.onAct('trash')} />
        <IconButton icon="unread" label="Mark as unread (Shift+u)" onClick={() => p.onAct('unread')} />
        {finding && <FindBar root={threadRef} onClose={() => setFinding(false)} />}
        {p.onPopout && <span className={finding ? undefined : 'pager'}><IconButton icon="popout" label="Open in new window (w)" onClick={p.onPopout} /></span>}
      </div>
      {/* keyed by conversation, so each one opened fades in */}
      <div className="thread" key={metas[0]?.id} ref={threadRef}>
        <h1>
          {last.subject || '(no subject)'} <span className="tag" title="The folder this conversation is in">{ROLE_LABEL[p.thread.role] ?? p.thread.folder}</span>
        </h1>
        {metas.map(m => (
          <Card
            key={m.id} meta={m} open={open.has(m.id)}
            toggle={() => setOpen(s => { const n = new Set(s); n.has(m.id) ? n.delete(m.id) : n.add(m.id); return n })}
            onCompose={p.onCompose}
            onStar={() => call('setFlags', [m.id], { flagged: !m.starred }).catch(() => {})}
            registerLatest={m.id === last.id ? msg => (p.latest.current = msg) : undefined}
          />
        ))}
        <div className="reply-row">
          <button className="pill" title="Reply to the sender (r)" onClick={() => compose('reply')}><Icon name="reply" size={18} /> Reply</button>
          {many && <button className="pill" title="Reply to everyone on the message (a)" onClick={() => compose('all')}><Icon name="replyAll" size={18} /> Reply all</button>}
          <button className="pill" title="Send this message on to someone else (f)" onClick={() => compose('forward')}><Icon name="forward" size={18} /> Forward</button>
        </div>
      </div>
    </div>
  )
}
