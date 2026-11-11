import { useEffect, useState } from 'react'
import { type Thread, Icon, IconButton, call, shortDate } from './lib'

type Contact = { email: string; name: string }
const CHIPS: [label: string, token: string][] = [['Has attachment', 'has:attachment'], ['Last 7 days', 'newer_than:7d'], ['From me', 'from:me']]
const NONE = { people: [] as Contact[], threads: [] as Thread[] }

/** Search field with as-you-type suggestions: matching people, the newest matching conversations, and quick filters. */
export function SearchBox(p: {
  value: string
  onChange: (s: string) => void
  account: number | null
  /** True while the list is showing search results. */
  active: boolean
  onSearch: (query: string) => void
  onClear: () => void
  onOpen: (t: Thread) => void
  inputRef: React.RefObject<HTMLInputElement | null>
}) {
  const [focus, setFocus] = useState(false)
  const [hits, setHits] = useState(NONE)
  const [sel, setSel] = useState(-1)
  const q = p.value.trim()

  useEffect(() => {
    if (!focus || !q) return setHits(NONE)
    let live = true
    const timer = setTimeout(async () => {
      try {
        const words = q.replace(/\b\w+:\S+/g, '').trim()
        const [people, threads] = await Promise.all([
          words ? call('searchContacts', words, 3) : Promise.resolve([]),
          call('listThreads', { account: p.account, query: q }, 6)
        ])
        if (live) (setHits({ people, threads }), setSel(-1))
      } catch {
        if (live) setHits(NONE) // half-typed input the index cannot parse yet
      }
    }, 120)
    return () => { live = false; clearTimeout(timer) }
  }, [q, focus, p.account])

  const done = () => p.inputRef.current?.blur()
  const search = (query: string) => (p.onChange(query), p.onSearch(query), done())
  // Suggestions in display order; the last entry is "all results".
  const actions: (() => void)[] = [
    ...hits.people.map(c => () => search(c.email)),
    ...hits.threads.map(t => () => (p.onOpen(t), done())),
    () => search(q)
  ]
  const has = (token: string) => p.value.split(/\s+/).includes(token)
  const flip = (token: string) =>
    p.onChange(has(token) ? p.value.split(/\s+/).filter(w => w !== token).join(' ') : `${p.value.trim()} ${token}`.trim() + ' ')

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') (e.currentTarget.blur(), p.active && p.onClear())
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const n = q ? actions.length : 0
      if (n) setSel(s => (e.key === 'ArrowDown' ? (s + 1) % n : (s <= 0 ? n : s) - 1))
    }
  }
  const item = (i: number, body: React.ReactNode, extra = '') => (
    <li key={i} className={`${extra}${i === sel ? ' sel' : ''}`} onMouseEnter={() => setSel(i)} onClick={actions[i]}>{body}</li>
  )

  return (
    <div className={`searchwrap${focus ? ' open' : ''}`} onFocus={() => setFocus(true)} onBlur={e => !e.currentTarget.contains(e.relatedTarget) && setFocus(false)}>
      <form className="search" onSubmit={e => (e.preventDefault(), q ? (sel >= 0 && actions[sel] ? actions[sel]() : search(q)) : p.onClear())}>
        <Icon name="search" />
        <input
          ref={p.inputRef} placeholder="Search mail" value={p.value} spellCheck={false}
          onChange={e => p.onChange(e.target.value)} onKeyDown={onKey}
        />
        {p.value && <IconButton icon="close" label="Clear search" size={18} onClick={() => (p.onClear(), p.inputRef.current?.focus())} />}
      </form>
      {focus && (
        // Clicking inside must not take focus from the field, or the panel would close before the click lands.
        <div className="suggestions" onMouseDown={e => e.preventDefault()}>
          <div className="filters">
            {CHIPS.map(([label, token]) => (
              <button key={token} type="button" tabIndex={-1} className={`filter${has(token) ? ' on' : ''}`} onClick={() => flip(token)}>{label}</button>
            ))}
          </div>
          {q && (
            <ul>
              {hits.people.map((c, i) =>
                item(i, <><span className="sg-icon person"><Icon name="person" size={20} /></span><span className="sg-main"><b>{c.name || c.email}</b><small>{c.email}</small></span></>, 'person-row')
              )}
              {hits.threads.map((t, j) =>
                item(hits.people.length + j, <>
                  <span className="sg-icon"><Icon name="unread" size={18} /></span>
                  <span className="sg-main"><b className={t.unread ? '' : 'plain'}>{t.subject || '(no subject)'}</b><small>{t.participants.join(', ')}</small></span>
                  {t.attachments && <Icon name="attach" size={16} />}
                  <time>{shortDate(t.date)}</time>
                </>)
              )}
              {item(actions.length - 1, <>
                <span className="sg-icon"><Icon name="search" size={20} /></span>
                <span className="sg-main">All search results for “{q}”</span>
                <time>Press ENTER</time>
              </>, 'all-row')}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
