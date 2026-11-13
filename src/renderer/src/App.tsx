import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { Compose, type ComposeState, blankDraft, replyDraft } from './Compose'
import { AddMailbox } from './AddMailbox'
import { Settings } from './Settings'
import { SearchBox } from './Search'
import { ThreadView } from './ThreadView'
import { useListMotion } from './motion'
import { type Account, type FolderRow, type Message, type Thread, Icon, IconButton, Logo, Menu, call, longDate, shortDate, who } from './lib'

const pref = (key: string, fallback: string) => {
  try { return localStorage.getItem(`qm.${key}`) ?? fallback } catch { return fallback }
}
const remember = (key: string, value: string) => {
  try { localStorage.setItem(`qm.${key}`, value) } catch { /* private mode: the choice just won't stick */ }
}

const NAV: [key: string, label: string, icon: string][] = [
  ['inbox', 'Inbox', 'inbox'], ['unread', 'Unread', 'unread'], ['starred', 'Starred', 'starOff'], ['sent', 'Sent', 'sent'], ['drafts', 'Drafts', 'drafts'],
  ['archive', 'Archive', 'archive'], ['junk', 'Spam', 'junk'], ['trash', 'Trash', 'trash']
]
const PAGE = 50
const LINGER = 1500 // ms a read conversation stays in the Unread section after you move on
// Hover text for the sidebar folders.
const NAV_TIP: Record<string, string> = {
  inbox: 'Inbox (g then i)', unread: 'Unread mail in every folder except Trash and Spam', starred: 'Starred conversations (g then s)', sent: 'Mail you sent (g then t)', drafts: 'Unfinished messages (g then d)',
  archive: 'Mail moved out of the inbox', junk: 'Mail marked as spam', trash: 'Deleted mail'
}
const SPONSOR = 'https://github.com/sponsors/mattgauzza'

interface ViewState { account: number | null; folder: string; query: string }
type Action = 'archive' | 'trash' | 'junk' | 'inbox' | 'read' | 'unread'

const keyOf = (t: Thread) => `${t.accountId}:${t.threadId}`
const clean = (e: any) => String(e?.message ?? e).replace(/^Error invoking remote method '\w+': (Error: )?/, '')
const typing = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement
  // Ticking a checkbox must not switch the shortcuts off, so only real text entry counts.
  return !!t?.isContentEditable || t?.tagName === 'TEXTAREA' || t?.tagName === 'SELECT' || (t?.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'checkbox')
}

const KEYS: [keys: string, what: string][] = [
  ['c', 'Compose'], ['/', 'Search'], ['j  or  ↓', 'Next conversation'], ['k  or  ↑', 'Previous conversation'],
  ['Enter  or  o', 'Open conversation'], ['u  or  Esc', 'Back to the list / close reader'], ['x', 'Select conversation'],
  ['* then a', 'Select all'], ['* then n', 'Select none'], ['e', 'Archive'], ['#  or  Delete', 'Delete'], ['!', 'Report spam'],
  ['s', 'Star / unstar'], ['Shift + i', 'Mark as read'], ['Shift + u', 'Mark as unread'],
  ['r', 'Reply'], ['a', 'Reply all'], ['f', 'Forward'], ['w', 'Open in a new window'], ['v', 'Reading pane on / off'],
  ['g then i', 'Go to Inbox'], ['g then s', 'Go to Starred'], ['g then t', 'Go to Sent'], ['g then d', 'Go to Drafts'],
  ['Ctrl + Enter', 'Send (while writing)'], ['?', 'Show this list']
]

function Shortcuts({ onClose }: { onClose: () => void }) {
  return (
    <div className="scrim" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="dialog keys">
        <h2>Keyboard shortcuts</h2>
        <dl>{KEYS.map(([k, what]) => <div key={k}><dt>{k}</dt><dd>{what}</dd></div>)}</dl>
        <footer><button className="text-btn" onClick={onClose}>Close</button></footer>
      </div>
    </div>
  )
}

function SignIn({ account, onDone }: { account: Account; onDone: () => void }) {
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const go = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      // Signed in: the banner can go now. The first sync of a big mailbox takes minutes, so it runs in the background.
      onDone()
      window.qm.invoke('refresh', account.id).catch(() => {})
    } catch (e) {
      setError(clean(e))
    }
    setBusy(false)
  }
  return (
    <div className="signin">
      <span className="dot" style={{ background: account.color }} />
      <b>{account.email}</b>
      {account.auth === 'oauth2' ? (
        <button className="primary small" disabled={busy} onClick={() => go(() => window.qm.invoke('signIn', account.id))}>Sign in with {account.provider}</button>
      ) : (
        <form onSubmit={e => (e.preventDefault(), pw && go(() => call('setPassword', account.id, pw)))}>
          <input type="password" placeholder="Password" value={pw} onChange={e => setPw(e.target.value)} />
          <button className="primary small" disabled={busy || !pw}>Sign in</button>
        </form>
      )}
      {busy && <span className="muted">Connecting…</span>}
      {error && <span className="error">{error}</span>}
    </div>
  )
}

/** A plain reading of a connection error, for people who don't speak IMAP. */
function explain(msg: string) {
  if (/ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|timed? ?out|socket hang up|unavailable|try again later|connection (closed|lost)/i.test(msg))
    return "The mail server isn't answering. It may be down for a while, or this PC may be offline."
  return 'The mail server returned an error while Qmail was checking for new mail.'
}

/** What the red "!" beside a mailbox is about, with a way to fix it: try again, or sign in. */
function MailboxProblem({ account, onClose, reload }: { account: Account; onClose: () => void; reload: () => void }) {
  const [busy, setBusy] = useState(false)
  const needsSignIn = !account.signedIn || account.status === 'auth'
  const detail = account.status.replace(/^error:\s*/, '')
  const fixed = account.signedIn && account.status === 'ok'
  const tryNow = async () => {
    setBusy(true)
    try { await window.qm.invoke('refresh', account.id) } catch { /* the new status says what happened */ }
    reload()
    setBusy(false)
  }
  return (
    <div className="scrim" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="dialog">
        <h2>{fixed ? `${account.email} is working again` : needsSignIn ? `Sign in to ${account.email}` : `Can't reach ${account.email}`}</h2>
        {fixed ? (
          <p>It connected and is checking for new mail.</p>
        ) : needsSignIn ? (
          <>
            <p>Its password or sign-in has expired, so Qmail can't check it for new mail.</p>
            <SignIn account={account} onDone={() => (reload(), onClose())} />
          </>
        ) : (
          <>
            <p>{explain(detail)}</p>
            <p className="muted">The server said: {detail || 'nothing'}</p>
            <p className="muted">
              {account.lastSync ? `Last tried ${longDate(account.lastSync)}. ` : ''}Qmail tries again on its own every minute.
            </p>
          </>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          {!fixed && !needsSignIn && <button className="pill" disabled={busy} onClick={tryNow}>{busy ? 'Checking…' : 'Try now'}</button>}
          <button className="primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

function Setup({ accounts, reload, onAdd }: { accounts: Account[]; reload: () => void; onAdd: () => void }) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const pending = accounts.filter(a => !a.signedIn || a.status === 'auth')

  const fromThunderbird = async (withPasswords: boolean) => {
    setBusy(true)
    setNote('')
    try {
      if (!accounts.length) {
        await call('importAccounts')
        await call('importContacts')
      }
      if (withPasswords) {
        const got = await call('importPasswords')
        setNote(got.length ? `Signed in: ${got.join(', ')}` : 'Thunderbird had no saved passwords for these accounts.')
      }
      await window.qm.invoke('refresh')
    } catch (e) {
      setNote(clean(e))
    }
    setBusy(false)
    reload()
  }

  if (!accounts.length)
    return (
      <div className="welcome">
        <h1>Welcome to Qmail</h1>
        <p>Bring your mailboxes and contacts over from Thunderbird to get started.</p>
        <button className="primary" disabled={busy} onClick={() => fromThunderbird(true)}>Import accounts and saved passwords</button>
        <button className="pill" disabled={busy} onClick={() => fromThunderbird(false)}>Import accounts only, I'll type the passwords</button>
        <button className="text-btn" disabled={busy} onClick={onAdd}>Add a mailbox by hand</button>
        {note && <p className="error">{note}</p>}
      </div>
    )
  if (!pending.length) return null
  return (
    <div className="setup">
      <div className="setup-head">
        <b>{pending.length === 1 ? 'One mailbox needs' : `${pending.length} mailboxes need`} to sign in</b>
        <button className="pill small" disabled={busy} onClick={() => fromThunderbird(true)}>Use the passwords saved in Thunderbird</button>
        {note && <span className="muted">{note}</span>}
      </div>
      {pending.map(a => <SignIn key={a.id} account={a} onDone={reload} />)}
    </div>
  )
}

export function App() {
  const [accounts, setAccounts] = useState<Account[] | null>(null)
  const [folders, setFolders] = useState<FolderRow[]>([])
  const [view, setView] = useState<ViewState>({ account: null, folder: 'inbox', query: '' })
  const [page, setPage] = useState(0)
  const [rows, setRows] = useState<Thread[]>([])
  // True while the list for the current mailbox/folder/search is still loading; shows placeholder rows.
  const [loading, setLoading] = useState(true)
  const shownKey = useRef('')
  const [open, setOpen] = useState<Thread | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [cursor, setCursor] = useState(0)
  const [compose, setCompose] = useState<{ key: number; state: ComposeState } | null>(null)
  const [adding, setAdding] = useState(false)
  const [help, setHelp] = useState(false)
  const [settings, setSettings] = useState(false)
  const [problem, setProblem] = useState<number | null>(null) // the mailbox whose "!" was clicked
  const [update, setUpdate] = useState('') // version downloaded and waiting for a restart
  useEffect(() => {
    window.qm.invoke('updateState').then(setUpdate, () => {})
    return window.qm.on('update', setUpdate)
  }, [])
  const prefix = useRef('') // first key of a two-key shortcut (g i, * a)
  const [tab, setTab] = useState<'mail' | 'messages'>('mail')
  const [status, setStatus] = useState('')
  const [toast, setToast] = useState('')
  const lastToast = useRef('')
  if (toast) lastToast.current = toast
  const [search, setSearch] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const paneRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const latest = useRef<Message | null>(null)
  const seq = useRef(0)

  const [unreadRows, setUnreadRows] = useState<Thread[]>([])
  const [totals, setTotals] = useState({ unread: 0, rest: 0 })
  const [unreadAll, setUnreadAll] = useState(0)
  // Unread conversations per mailbox (every folder except Trash and Spam, as the Unread item counts them).
  const [unreadPer, setUnreadPer] = useState<Record<number, number>>({})
  // Unread conversations opened here. The open one stays where its row was while it is read; once
  // another is opened it sits there a moment longer (LINGER), then fades out of the Unread section.
  const [kept, setKept] = useState<Thread[]>([])
  const linger = useRef(new Map<string, number>())
  const [layout, setLayout] = useState(() => pref('layout', 'list'))
  const [splitW, setSplitW] = useState(() => Number(pref('split', '460')))
  const [folded, setFolded] = useState({ unread: pref('fold.unread', '') === '1', rest: pref('fold.rest', '') === '1' })

  const split = layout === 'split'
  // Folder lists are shown as Gmail does: unread conversations first, then everything else.
  // Starred and Unread are already filtered lists, so they stay flat; a folder with no unread shows no header.
  const sectioned = !view.query && view.folder !== 'starred' && view.folder !== 'unread'
  // Opening an unread conversation marks it read at once, which would move its row out of the Unread
  // section mid-click. Kept rows go back in date order (the order the list is sorted in), shown as read.
  const keptKeys = new Set(kept.map(keyOf))
  const withKept = (list: Thread[]) => {
    const out = [...list]
    for (const t of kept) {
      if (out.some(x => keyOf(x) === keyOf(t))) continue
      const at = out.findIndex(x => x.date < t.date)
      out.splice(at < 0 ? out.length : at, 0, { ...t, unread: 0 })
    }
    return out
  }
  const topBase = sectioned ? withKept(unreadRows) : []
  const restBase = sectioned ? rows.filter(t => !keptKeys.has(keyOf(t))) : withKept(rows)
  const unreadShown = totals.unread + (topBase.length - unreadRows.length)
  const headed = sectioned && unreadShown > 0
  const top = headed && !folded.unread ? topBase : []
  const rest = headed && folded.rest ? [] : restBase
  const threads = [...top, ...rest]
  // Rows are keyed by section too, so a conversation that goes from Unread to Everything else fades out
  // of one and into the other.
  const shown = useListMotion(
    [...top.map((t, i) => ({ key: `u:${keyOf(t)}`, value: { t, i } })), ...rest.map((t, i) => ({ key: `r:${keyOf(t)}`, value: { t, i: top.length + i } }))],
    `${view.account}|${view.folder}|${view.query}|${page}|${folded.unread}|${folded.rest}|${layout}`,
    listRef
  )
  const firstRest = shown.findIndex(s => s.key.startsWith('r:'))
  useEffect(() => {
    const k = open ? keyOf(open) : null
    if (k && linger.current.has(k)) (clearTimeout(linger.current.get(k)), linger.current.delete(k))
    for (const t of kept) {
      const tk = keyOf(t)
      if (tk === k || linger.current.has(tk)) continue
      linger.current.set(tk, window.setTimeout(() => (linger.current.delete(tk), setKept(l => l.filter(x => keyOf(x) !== tk))), LINGER))
    }
    if (open && k && open.unread && !keptKeys.has(k)) setKept(l => [...l, open])
  }, [open])
  /** Lets kept rows go now: all of them, or just `keys`. */
  const forget = (keys?: Set<string>) => {
    for (const [k, id] of linger.current) if (!keys || keys.has(k)) (clearTimeout(id), linger.current.delete(k))
    setKept(l => (keys ? l.filter(t => !keys.has(keyOf(t))) : l.length ? [] : l))
  }
  useEffect(() => forget(), [view, page])
  const say = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(t => (t === msg ? '' : t)), 4000)
  }
  const scope = () =>
    view.query
      ? { account: view.account, query: view.query }
      : view.folder === 'starred' ? { account: view.account, starred: true }
      : view.folder === 'unread' ? { account: view.account, state: 'unread' as const }
      : { account: view.account, folder: view.folder }

  const load = useCallback(async () => {
    const mine = ++seq.current
    const current = () => mine === seq.current
    const q = scope()
    const main = sectioned ? { ...q, state: 'read' as const } : q
    const unread = { ...q, state: 'unread' as const }
    // Switching mailbox, folder, search or page clears the old rows at once, so the previous account's
    // mail never sits under the new account's name while the new list loads. A background refresh keeps them.
    const key = `${view.account}|${view.folder}|${view.query}|${page}`
    if (shownKey.current !== key) {
      shownKey.current = key
      setRows([])
      setUnreadRows([])
      setTotals({ unread: 0, rest: 0 })
      setUnreadAll(0) // the sidebar count belongs to the account on screen; don't show the last account's number
      setLoading(true)
    }
    // Each part is shown as soon as it arrives: the list first, the counts and folders after, so a
    // slow count never holds up the rows.
    const rowsP = call('listThreads', main, PAGE, page * PAGE).then(t => current() && (setRows(t), setLoading(false)))
    const unreadP = sectioned
      ? call('listThreads', unread, PAGE, 0).then(ut => current() && setUnreadRows(ut))
      : (setUnreadRows([]), Promise.resolve())
    const totalsP = Promise.all([call('countThreads', main), sectioned ? call('countThreads', unread) : Promise.resolve(0)])
      .then(([n, un]) => current() && setTotals({ unread: un, rest: n }))
    const metaP = Promise.all([call('listAccounts'), call('listFolders', null)])
      .then(([a, f]) => current() && (setAccounts(a), setFolders(f)))
    // Unread across every folder except Trash and Spam, counted as conversations (not per folder, so All Mail isn't counted twice).
    const allUnreadP = call('countThreads', { account: view.account, state: 'unread' as const }).then(n => current() && setUnreadAll(n))
    // The mailbox badges: one count per account, so the sidebar totals match the Unread item.
    const perP = call('listAccounts')
      .then(list => Promise.all(list.map(a => call('countThreads', { account: a.id, state: 'unread' as const }).then(n => [a.id, n] as const))))
      .then(pairs => current() && setUnreadPer(Object.fromEntries(pairs)))
    try {
      await Promise.all([rowsP, unreadP, totalsP, metaP, allUnreadP, perP])
    } catch (e) {
      say(clean(e))
    } finally {
      if (current()) setLoading(false)
    }
  }, [view, page])

  useEffect(() => { load() }, [load])
  // Keep the highlighted row on the open conversation when the list reshuffles (e.g. it just became read).
  useEffect(() => {
    if (!open) return
    const i = threads.findIndex(t => keyOf(t) === keyOf(open))
    if (i >= 0) setCursor(i)
  }, [rows, unreadRows, folded])
  useEffect(() => { remember('layout', layout); remember('split', String(splitW)) }, [layout, splitW])
  useEffect(() => { remember('fold.unread', folded.unread ? '1' : ''); remember('fold.rest', folded.rest ? '1' : '') }, [folded])
  useEffect(() => window.qm.on('changed', load), [load])
  useEffect(() => {
    let timer: number
    return window.qm.on('sync', (p: { folder: string; done: number; total: number }) => {
      // Bodies are saved to disk once; the number is what is still left, so it shrinks across restarts.
      setStatus(p.folder === 'message bodies'
        ? `Saving mail to this PC (one time) · ${(p.total - p.done).toLocaleString()} left`
        : `Syncing ${p.folder} · ${p.done}/${p.total}`)
      clearTimeout(timer)
      timer = window.setTimeout(() => setStatus(''), 3000)
    })
  }, [])

  const go = (patch: Partial<ViewState>) => {
    listRef.current?.scrollTo({ top: 0 }) // a different mailbox, folder or search starts at the top
    setView(v => ({ ...v, query: '', ...patch }))
    if (patch.query === undefined) setSearch('')
    setPage(0)
    setOpen(null)
    setChecked(new Set())
    setCursor(0)
    setTab('mail')
  }

  const act = async (kind: Action, ts: Thread[]) => {
    if (!ts.length) return
    const ids = ts.flatMap(t => t.ids)
    const gone = kind !== 'read' && kind !== 'unread'
    if (gone) {
      // Any reload already in flight was fetched before this change, so its rows would bring the
      // removed conversations back. Retire it; the reload below replaces it.
      seq.current++
      const keys = new Set(ts.map(keyOf))
      forget(keys)
      setRows(r => r.filter(t => !keys.has(keyOf(t))))
      setUnreadRows(r => r.filter(t => !keys.has(keyOf(t))))
      if (open && keys.has(keyOf(open))) {
        // Like Gmail: the reader moves on to the conversation below the removed one, if there is one.
        const below = threads.slice(threads.findIndex(t => keyOf(t) === keyOf(open)) + 1).find(t => !keys.has(keyOf(t)))
        setOpen(below ?? null)
      }
    } else if (kind === 'unread') setOpen(null)
    setChecked(new Set())
    const n = ts.length === 1 ? 'Conversation' : `${ts.length} conversations`
    try {
      if (kind === 'read' || kind === 'unread') await call('setFlags', ids, { seen: kind === 'read' })
      else if (kind === 'trash') (say(`${n} ${ts[0].role === 'trash' ? 'deleted forever' : 'moved to Trash'}`), await call('deleteMessages', ids))
      else {
        say(`${n} ${kind === 'archive' ? 'archived' : kind === 'junk' ? 'marked as spam' : 'moved to Inbox'}`)
        await call('moveMessages', ids, kind)
      }
      if (gone) load()
    } catch (e) {
      say(clean(e))
      load()
    }
  }

  const star = (t: Thread) => call('setFlags', t.starred ? t.ids : [t.id], { flagged: !t.starred }).catch(e => say(clean(e)))
  const newMail = (state: ComposeState) => setCompose({ key: Date.now(), state })
  const defaultFrom = () => view.account ?? accounts?.find(a => a.signedIn)?.id ?? accounts?.[0]?.id ?? 0
  const selected = () => {
    const ticked = threads.filter(t => checked.has(keyOf(t)))
    if (split && ticked.length) return ticked
    return open ? [open] : ticked.length ? ticked : threads[cursor] ? [threads[cursor]] : []
  }
  const popout = (t: Pick<Thread, 'id'>) => window.qm.invoke('openThread', t.id).catch(e => say(clean(e)))
  const markAllRead = async () => {
    try {
      const ms = await call('listMessages', { ...scope(), unread: true }, 5000)
      if (ms.length) await call('setFlags', ms.map(m => m.id), { seen: true })
      say(ms.length ? `${ms.length} message${ms.length === 1 ? '' : 's'} marked as read` : 'Nothing unread here')
    } catch (e) {
      say(clean(e))
    }
  }
  const pick = (test: (t: Thread) => boolean) => setChecked(new Set(threads.filter(test).map(keyOf)))
  const resize = (e: React.MouseEvent) => {
    e.preventDefault()
    const from = e.clientX
    const w0 = splitW
    // While dragging, only the pane's own width changes (once per frame); the app redraws once, on release.
    let w = w0
    let frame = 0
    const move = (ev: MouseEvent) => {
      w = Math.max(320, Math.min(w0 + ev.clientX - from, window.innerWidth - 248 - 380))
      frame ||= requestAnimationFrame(() => {
        frame = 0
        if (paneRef.current) paneRef.current.style.flex = `0 0 ${w}px`
      })
    }
    const up = () => {
      cancelAnimationFrame(frame)
      setSplitW(w)
      document.body.classList.remove('dragging')
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    document.body.classList.add('dragging') // keeps the message frame from swallowing the drag
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      if (typing(e) || e.ctrlKey || e.metaKey || e.altKey || tab !== 'mail' || adding || settings) return
      if (help) return void (['Escape', '?'].includes(e.key) && setHelp(false))
      const first = prefix.current
      prefix.current = ''
      if (first) {
        const second: Record<string, () => void> = {
          gi: () => go({ folder: 'inbox' }), gs: () => go({ folder: 'starred' }), gt: () => go({ folder: 'sent' }), gd: () => go({ folder: 'drafts' }),
          '*a': () => pick(() => true), '*n': () => pick(() => false)
        }
        const run = second[first + e.key]
        if (run) return void (e.preventDefault(), run())
      }
      if (e.key === 'g' || e.key === '*') return void (prefix.current = e.key)
      // A focused button already acts on Enter; don't also open a conversation.
      if (e.key === 'Enter' && (e.target as HTMLElement)?.tagName === 'BUTTON') return
      const reply = async (mode: 'reply' | 'all' | 'forward') => {
        const t = open ?? threads[cursor]
        if (!t) return
        newMail(replyDraft(open && latest.current ? latest.current : await call('getMessage', t.id, true), mode))
      }
      // In split view the reader follows the highlighted row.
      const step = (d: number) => {
        if (open && !split) return
        const i = Math.max(0, Math.min(cursor + d, threads.length - 1))
        setCursor(i)
        if (open && threads[i]) setOpen(threads[i])
      }
      const map: Record<string, () => void> = {
        c: () => newMail(blankDraft(defaultFrom())),
        '/': () => searchRef.current?.focus(),
        j: () => step(1),
        k: () => step(-1),
        ArrowDown: () => step(1),
        ArrowUp: () => step(-1),
        Delete: () => act('trash', selected()),
        '!': () => act('junk', selected()),
        w: () => { const t = open ?? threads[cursor]; if (t) (popout(t), setOpen(null)) },
        v: () => setLayout(split ? 'list' : 'split'),
        '?': () => setHelp(true),
        Enter: () => (split || !open) && threads[cursor] && setOpen(threads[cursor]),
        o: () => (split || !open) && threads[cursor] && setOpen(threads[cursor]),
        u: () => setOpen(null),
        Escape: () => setOpen(null),
        x: () => (split || !open) && threads[cursor] && toggle(threads[cursor]),
        e: () => act('archive', selected()),
        '#': () => act('trash', selected()),
        s: () => selected().forEach(star),
        I: () => act('read', selected()),
        U: () => act('unread', selected()),
        r: () => reply('reply'),
        a: () => reply('all'),
        f: () => reply('forward')
      }
      const fn = map[e.key]
      if (fn) (e.preventDefault(), fn())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const toggle = (t: Thread) =>
    setChecked(s => {
      const n = new Set(s)
      n.has(keyOf(t)) ? n.delete(keyOf(t)) : n.add(keyOf(t))
      return n
    })

  if (!accounts) return null
  // Conversations in different mailboxes are never the same conversation, so "All mailboxes" is just the sum.
  const unreadIn = (id: number | null) => (id === null ? Object.values(unreadPer).reduce((n, c) => n + c, 0) : unreadPer[id] ?? 0)
  const inScope = (f: FolderRow) => view.account === null || f.accountId === view.account
  const count = (role: string) => folders.filter(f => f.role === role && inScope(f)).reduce((n, f) => n + (role === 'drafts' ? f.total : f.unread), 0)
  const custom = [...new Map(folders.filter(f => !f.role && f.total > 0 && inScope(f)).map(f => [f.name.toLowerCase(), f])).values()]
  const picked = threads.filter(t => checked.has(keyOf(t)))
  // Ticks or unticks one section of the inbox, leaving the other section's ticks alone.
  const groupBox = (group: Thread[], hidden: boolean, name: string) => (
    <input
      type="checkbox" aria-label={`Select all ${name}`} title={`Select all ${name}`} style={hidden || !group.length ? { visibility: 'hidden' } : undefined}
      checked={group.length > 0 && group.every(t => checked.has(keyOf(t)))} onClick={e => e.stopPropagation()}
      onChange={e =>
        setChecked(s => {
          const n = new Set(s)
          group.forEach(t => (e.target.checked ? n.add(keyOf(t)) : n.delete(keyOf(t))))
          return n
        })
      }
    />
  )
  const section = (
    <div className="section" title={folded.rest ? 'Show everything else' : 'Hide everything else'} onClick={() => setFolded(f => ({ ...f, rest: !f.rest }))}>
      {groupBox(rest, folded.rest, 'everything else')}
      <Icon name={folded.rest ? 'down' : 'up'} /> <b>Everything else</b>
      <span title={`${totals.rest.toLocaleString()} conversations with nothing unread`}>{totals.rest.toLocaleString()}</span>
    </div>
  )
  const sentLike =view.folder === 'sent' || view.folder === 'drafts'
  const title = view.query ? `Results for “${view.query}”` : NAV.find(n => n[0] === view.folder)?.[1] ?? custom.find(f => f.name.toLowerCase() === view.folder)?.name ?? view.folder

  return (
    <div className="app">
      <header className="top">
        <div className="brand" title="Qmail"><Logo /> Qmail</div>
        <SearchBox
          value={search} onChange={setSearch} account={view.account} active={!!view.query} inputRef={searchRef}
          onSearch={query => go({ query })} onClear={() => go({})} onOpen={t => (setTab('mail'), setOpen(t))}
        />
        <span className="status" title={status}>{status}</span>
        <span className="top-btn">
          {update && (
            <span className="update-icon">
              <IconButton icon="download" label={`Update ready: click to restart into Qmail ${update}`} onClick={() => window.qm.invoke('installUpdate')} />
            </span>
          )}
          <span className="heart"><IconButton icon="heart" label="Support Qmail (opens in your browser)" size={18} onClick={() => window.open(SPONSOR)} /></span>
          <IconButton icon="keyboard" label="Keyboard shortcuts (?)" onClick={() => setHelp(true)} />
          <IconButton icon="settings" label="Settings and sorting rules" onClick={() => setSettings(true)} />
        </span>
      </header>

      <aside className="side">
        <button className="compose-btn" title="Write a new message (c)" onClick={() => newMail(blankDraft(defaultFrom()))}><Icon name="edit" /> Compose</button>
        <nav className="folders">
          {NAV.map(([key, label, icon]) => (
            <button key={key} title={NAV_TIP[key]} className={tab === 'mail' && !view.query && view.folder === key ? 'on' : ''} onClick={() => go({ folder: key })}>
              <Icon name={icon} /> <span>{label}</span>
              {key === 'unread' && unreadAll > 0 && <em title={`${unreadAll.toLocaleString()} unread conversations`}>{unreadAll.toLocaleString()}</em>}
              {['inbox', 'drafts', 'junk'].includes(key) && count(key) > 0 && <em title={`${count(key).toLocaleString()} ${key === 'drafts' ? 'drafts' : 'unread'}`}>{count(key)}</em>}
            </button>
          ))}
          {custom.map(f => (
            <button key={f.id} title={`Folder: ${f.name}`} className={tab === 'mail' && !view.query && view.folder === f.name.toLowerCase() ? 'on' : ''} onClick={() => go({ folder: f.name.toLowerCase() })}>
              <Icon name="folder" /> <span>{f.name}</span>
              {f.unread > 0 && <em title={`${f.unread.toLocaleString()} unread`}>{f.unread}</em>}
            </button>
          ))}
        </nav>
        <h2>Mailboxes <IconButton icon="add" label="Add a mailbox" size={18} onClick={() => setAdding(true)} /></h2>
        <nav>
          <button title="Show mail from every mailbox together" className={view.account === null ? 'on soft' : ''} onClick={() => go({ account: null, folder: view.folder })}>
            <span className="dot all" /> <span>All mailboxes</span>
            {unreadIn(null) > 0 && <em title={`${unreadIn(null).toLocaleString()} unread in all inboxes`}>{unreadIn(null)}</em>}
          </button>
          {accounts.map(a => (
            <button key={a.id} className={view.account === a.id ? 'on soft' : ''} title={a.status.startsWith('error') ? a.status : !a.signedIn || a.status !== 'ok' ? `${a.email} needs you to sign in` : `Show only ${a.email}`} onClick={() => go({ account: a.id, folder: 'inbox' })}>
              <span className="dot" style={{ background: a.color }} /> <span>{a.email}</span>
              {!a.signedIn || a.status !== 'ok' ? <em className="warn hit" title="What's wrong? Click to see" onClick={e => (e.stopPropagation(), setProblem(a.id))}>!</em> :unreadIn(a.id) > 0 && <em title={`${unreadIn(a.id).toLocaleString()} unread`}>{unreadIn(a.id)}</em>}
            </button>
          ))}
        </nav>
      </aside>

      <main className="main">
        {tab === 'mail' && <Setup accounts={accounts} reload={load} onAdd={() => setAdding(true)} />}
        {tab === 'mail' && accounts.length > 0 && (
          <div className="work">
          {(split || !open) && (
          <div ref={paneRef} className={`pane${split ? ' narrow' : ''}`} style={split ? { flex: `0 0 ${splitW}px` } : undefined}>
            <div className="toolbar">
              <input
                type="checkbox" aria-label="Select all" title="Select everything shown (* then a)" checked={threads.length > 0 && picked.length === threads.length}
                onChange={e => setChecked(e.target.checked ? new Set(threads.map(keyOf)) : new Set())}
              />
              <Menu
                icon="caret" label="Select" size={18}
                items={[
                  ['All', () => pick(() => true)], ['None', () => pick(() => false)], ['Read', () => pick(t => !t.unread)],
                  ['Unread', () => pick(t => t.unread > 0)], ['Starred', () => pick(t => t.starred)], ['Unstarred', () => pick(t => !t.starred)]
                ]}
              />
              {picked.length ? (
                <>
                  {view.folder === 'inbox' && !view.query
                    ? <IconButton icon="archive" label="Archive (e)" onClick={() => act('archive', picked)} />
                    : <IconButton icon="inbox" label="Move to Inbox" onClick={() => act('inbox', picked)} />}
                  <IconButton icon="junk" label="Report spam (!)" onClick={() => act('junk', picked)} />
                  <IconButton icon="trash" label="Delete (#)" onClick={() => act('trash', picked)} />
                  <IconButton icon="read" label="Mark as read (Shift+i)" onClick={() => act('read', picked)} />
                  <IconButton icon="unread" label="Mark as unread (Shift+u)" onClick={() => act('unread', picked)} />
                  <span className="muted">{picked.length} selected</span>
                </>
              ) : (
                <>
                  <IconButton icon="refresh" label="Check for new mail" onClick={() => window.qm.invoke('refresh').catch(e => say(clean(e)))} />
                  <Menu icon="more" label="More" items={[['Mark all as read', markAllRead]]} />
                  <span className="view-title" title={title}>{title}</span>
                </>
              )}
              <span className="pager" title={rows.length > 0 ? `Showing conversations ${page * PAGE + 1} to ${page * PAGE + rows.length} of ${totals.rest.toLocaleString()}` : undefined}>
                {rows.length > 0 && totals.rest > 0 && `${page * PAGE + 1}–${page * PAGE + rows.length} of ${totals.rest.toLocaleString()}`}
                <IconButton icon="prev" label="Newer conversations" onClick={() => page > 0 && setPage(page - 1)} />
                <IconButton icon="next" label="Older conversations" onClick={() => (page + 1) * PAGE < totals.rest && setPage(page + 1)} />
                <IconButton
                  icon={split ? 'rows' : 'split'} label={split ? 'Hide reading pane (v)' : 'Show reading pane beside the list (v)'}
                  onClick={() => setLayout(split ? 'list' : 'split')}
                />
              </span>
            </div>
            <div className="list" ref={listRef}>
              {loading && threads.length === 0 && Array.from({ length: 9 }, (_, i) => (
                <div className="row skeleton" key={`sk${i}`} aria-hidden="true">
                  <span className="lead"><span className="bar box" /></span>
                  <span className="from"><span className="bar" style={{ width: `${90 + (i % 3) * 30}px` }} /></span>
                  <span className="text"><span className="bar" style={{ width: `${45 + ((i * 37) % 40)}%` }} /></span>
                  <span className="bar date" />
                </div>
              ))}
              {/* Only say "Nothing here" once the list and its counts have both come back empty. */}
              {!loading && threads.length === 0 && rows.length === 0 && unreadRows.length === 0 && totals.unread + totals.rest === 0 && <p className="empty">{view.query ? 'No mail matches your search.' : 'Nothing here.'}</p>}
              {headed && (
                <div className="section" title={folded.unread ? 'Show unread' : 'Hide unread'} onClick={() => setFolded(f => ({ ...f, unread: !f.unread }))}>
                  {groupBox(top, folded.unread, 'unread')}
                  <Icon name={folded.unread ? 'down' : 'up'} /> <b>Unread</b>
                  <span title={`${unreadShown.toLocaleString()} unread conversations`}>{top.length < unreadShown ? `1–${top.length} of ${unreadShown.toLocaleString()}` : unreadShown}</span>
                </div>
              )}
              {shown.map(({ key, value: { t, i: at }, leaving }, n) => {
                const i = leaving ? -1 : at // a row on its way out can't be picked or highlighted
                return (
                <Fragment key={key}>
                {headed && n === firstRest && section}
                <div
                  data-k={key} aria-hidden={leaving || undefined}
                  onClick={() => (setCursor(i), setOpen(t))} onAuxClick={e => e.button === 1 && popout(t)}
                  className={`row${t.unread ? ' unread' : ''}${!leaving && checked.has(keyOf(t)) ? ' checked' : ''}${i === cursor ? ' cursor' : ''}${!leaving && open && keyOf(open) === keyOf(t) ? ' open' : ''}`}
                >
                  <span className="lead" onClick={e => e.stopPropagation()}>
                    <input type="checkbox" aria-label="Select conversation" title="Select (x)" checked={checked.has(keyOf(t))} onChange={() => toggle(t)} />
                    <IconButton icon={t.starred ? 'star' : 'starOff'} label={t.starred ? 'Remove star (s)' : 'Star (s)'} active={t.starred} onClick={() => star(t)} />
                  </span>
                  <span className="from">
                    {view.account === null && <span className="dot" title={t.account} style={{ background: accounts.find(a => a.id === t.accountId)?.color }} />}
                    <span className="names" title={sentLike ? t.to.map(x => x.address).join(', ') : `${t.participants.join(', ')} (${t.from.address})`}>{sentLike ? `To: ${t.to.map(who).join(', ') || '(no one)'}` : t.participants.join(', ')}</span>
                    {t.count > 1 && <small title={`${t.count} messages in this conversation`}>{t.count}</small>}
                  </span>
                  <span className="text" title={t.subject || '(no subject)'}>
                    <span className="subject">{t.subject || '(no subject)'}</span>
                    {t.snippet && <span className="dash"> - </span>}
                    <span className="snippet">{t.snippet}</span>
                  </span>
                  {t.attachments && <span className="clip" title="Has attachments"><Icon name="attach" size={16} /></span>}
                  <time title={longDate(t.date)}>{shortDate(t.date)}</time>
                  {t.files.length > 0 && (
                    <span className="row-chips" onClick={e => e.stopPropagation()}>
                      {t.files.slice(0, 3).map(f => (
                        <button className="chip file" key={`${f.id}:${f.index}`} title={`Open ${f.filename}`} onClick={() => window.qm.invoke('openAttachment', f.id, f.index).catch(e => say(clean(e)))}>
                          <Icon name="attach" size={14} /> <span>{f.filename}</span>
                        </button>
                      ))}
                      {t.files.length > 3 && <span className="chip count" title={t.files.slice(3).map(f => f.filename).join(', ')}>+{t.files.length - 3}</span>}
                    </span>
                  )}
                  <span className="hover" onClick={e => e.stopPropagation()}>
                    <IconButton icon="popout" label="Open in new window (w)" onClick={() => popout(t)} />
                    {t.role === 'inbox' && <IconButton icon="archive" label="Archive (e)" onClick={() => act('archive', [t])} />}
                    <IconButton icon="trash" label="Delete (#)" onClick={() => act('trash', [t])} />
                    <IconButton icon={t.unread ? 'read' : 'unread'} label={t.unread ? 'Mark as read' : 'Mark as unread'} onClick={() => act(t.unread ? 'read' : 'unread', [t])} />
                  </span>
                </div>
                </Fragment>
                )
              })}
              {headed && firstRest < 0 && section}
            </div>
          </div>
          )}
          {split && <div className="grip" onMouseDown={resize} title="Drag to resize the reading pane" />}
          {open ? (
            <ThreadView
              thread={open} latest={latest} mode={split ? 'split' : 'full'} onBack={() => setOpen(null)} onAct={k => act(k, [open])} onCompose={newMail}
              onPopout={() => (popout(open), setOpen(null))}
            />
          ) : split && <div className="pane blank"><p className="empty">Pick a conversation to read it here.</p></div>}
          </div>
        )}
      </main>

      {compose && (
        <Compose
          key={compose.key} initial={compose.state} accounts={accounts}
          onClose={() => setCompose(null)} onSent={msg => (setCompose(null), say(msg))}
        />
      )}
      {help && <Shortcuts onClose={() => setHelp(false)} />}
      {settings && (
        <Settings
          accounts={accounts} folders={folders} say={say} onClose={() => setSettings(false)}
          onRemoved={id => (view.account === id && go({ account: null, folder: view.folder }), load())}
        />
      )}
      {adding && <AddMailbox onClose={added => (setAdding(false), added && (say(`${added} added`), load()))} />}
      {problem !== null && accounts.some(a => a.id === problem) && (
        <MailboxProblem account={accounts.find(a => a.id === problem)!} onClose={() => setProblem(null)} reload={load} />
      )}
      {/* Always there, so it can slide away; it keeps the last words while it goes. */}
      <div className={`toast${toast ? ' show' : ''}`} role="status" aria-hidden={!toast}>{toast || lastToast.current}</div>
    </div>
  )
}
