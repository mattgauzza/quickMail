import { useEffect, useState } from 'react'
import { type Account, type FolderRow, Icon, IconButton, call } from './lib'

type Rule = Awaited<ReturnType<typeof listRules>>[number]
const listRules = () => call('listRules')
const clean = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const ACTIONS: [value: Rule['action'], label: string][] = [
  ['move', 'Move to folder'], ['archive', 'Archive'], ['trash', 'Delete'], ['read', 'Mark as read'], ['star', 'Star']
]
const BLANK = { id: 0, account: null as number | null, from: '', subject: '', to: '', action: 'move' as Rule['action'], folder: '', alsoRead: false, enabled: true }
type Draft = typeof BLANK

/** "From stripe.com → Move to Receipts" */
function describe(r: Rule, accounts: Account[]) {
  const when = [r.from && `from ${r.from}`, r.subject && `subject has “${r.subject}”`, r.to && `sent to ${r.to}`].filter(Boolean).join(' and ')
  const what = r.action === 'move' ? `move to ${r.folder}` : ACTIONS.find(a => a[0] === r.action)![1].toLowerCase()
  const where = r.account === null ? '' : ` (${accounts.find(a => a.id === r.account)?.email ?? 'removed mailbox'})`
  return { when: when[0].toUpperCase() + when.slice(1) + where, what: what + (r.alsoRead && r.action !== 'read' && r.action !== 'trash' ? ', mark read' : '') }
}

/** Settings: mailboxes and the sorting rules. The title, tabs, search and footer stay put; only the list scrolls. */
export function Settings(p: { accounts: Account[]; folders: FolderRow[]; onClose: () => void; say: (msg: string) => void; onRemoved: (id: number) => void }) {
  const [tab, setTab] = useState<'mailboxes' | 'rules'>('mailboxes')
  const [mailQuery, setMailQuery] = useState('')
  const [ruleQuery, setRuleQuery] = useState('')
  const [rules, setRules] = useState<Rule[]>([])
  const [edit, setEdit] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [version, setVersion] = useState('')
  const [removing, setRemoving] = useState<number | null>(null)
  const reload = () => listRules().then(setRules, e => setError(clean(e)))
  useEffect(() => {
    reload()
    window.qm.invoke('version').then(setVersion, () => {})
  }, [])

  const names = [...new Set(p.folders.filter(f => !f.role && (edit?.account == null || f.accountId === edit.account)).map(f => f.path))].sort()
  const guard = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(clean(e))
    }
    setBusy(false)
    reload()
  }
  const save = (e: React.FormEvent) => {
    e.preventDefault()
    guard(async () => {
      await call('saveRule', { ...edit!, id: edit!.id || undefined })
      setEdit(null)
    })
  }
  const runNow = (r: Rule) =>
    guard(async () => {
      const [res] = await call('applyRules', { rule: r.id })
      if (res.error) throw new Error(res.error)
      p.say(res.matched ? `${res.matched.toLocaleString()} message${res.matched === 1 ? '' : 's'} sorted` : 'Nothing in the inbox matches this rule')
    })
  const set = (patch: Partial<Draft>) => setEdit(d => ({ ...d!, ...patch }))
  const close = () => !busy && p.onClose()

  const mq = mailQuery.trim().toLowerCase()
  const shownAccounts = p.accounts.filter(a => !mq || a.email.toLowerCase().includes(mq))
  const rq = ruleQuery.trim().toLowerCase()
  const shownRules = rules.filter(r => {
    if (!rq) return true
    const d = describe(r, p.accounts)
    return `${d.when} ${d.what}`.toLowerCase().includes(rq)
  })

  return (
    <div className="scrim" onMouseDown={e => e.target === e.currentTarget && close()}>
      <div className="dialog settings">
        <div className="settings-head">
          <h2>{edit ? (edit.id ? 'Change rule' : 'New rule') : 'Settings'}</h2>
          <IconButton icon="close" label="Close settings" size={22} onClick={close} />
        </div>

        {!edit && (
          <div className="settings-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'mailboxes'} className={tab === 'mailboxes' ? 'on' : ''} onClick={() => setTab('mailboxes')}>Mailboxes</button>
            <button role="tab" aria-selected={tab === 'rules'} className={tab === 'rules' ? 'on' : ''} onClick={() => setTab('rules')}>Sorting rules</button>
          </div>
        )}

        {!edit && (
          <input
            type="search" className="settings-search"
            placeholder={tab === 'mailboxes' ? 'Search mailboxes' : 'Search sorting rules'}
            aria-label={tab === 'mailboxes' ? 'Search mailboxes' : 'Search sorting rules'}
            value={tab === 'mailboxes' ? mailQuery : ruleQuery}
            onChange={e => (tab === 'mailboxes' ? setMailQuery : setRuleQuery)(e.target.value)}
          />
        )}

        <div className="settings-scroll">
          {!edit && tab === 'mailboxes' && (
            <>
              <p className="help">
                Removing a mailbox deletes its copy of the mail from this PC. Nothing is deleted on the mail server, and you can add the mailbox again later.
              </p>
              {p.accounts.length === 0 && <p className="muted">No mailboxes yet.</p>}
              {p.accounts.length > 0 && shownAccounts.length === 0 && <p className="muted">No mailboxes match “{mailQuery.trim()}”.</p>}
              <ul className="rules">
                {shownAccounts.map(a => (
                  <li key={a.id}>
                    <span className="dot" style={{ background: a.color }} /> <span>{a.email}</span>
                    {removing === a.id ? (
                      <span className="remove-confirm">
                        Remove {a.email} from this PC?{' '}
                        <button className="primary small" disabled={busy} onClick={() => guard(async () => {
                          await call('removeAccount', a.id)
                          setRemoving(null)
                          p.onRemoved(a.id)
                          p.say(`${a.email} removed`)
                        })}>Remove</button>{' '}
                        <button className="text-btn" disabled={busy} onClick={() => setRemoving(null)}>Cancel</button>
                      </span>
                    ) : (
                      <button className="text-btn" title={`Remove ${a.email} from this PC`} disabled={busy} onClick={() => setRemoving(a.id)}>Remove</button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}

          {!edit && tab === 'rules' && (
            <>
              <p className="help">
                Rules sort mail as it arrives in an inbox, each time quickMail checks for new mail. The first rule that matches a message wins.
                Starred mail is never moved or deleted by a rule.
              </p>
              {rules.length === 0 && <p className="muted">No rules yet.</p>}
              {rules.length > 0 && shownRules.length === 0 && <p className="muted">No rules match “{ruleQuery.trim()}”.</p>}
              <ul className="rules">
                {shownRules.map(r => {
                  const d = describe(r, p.accounts)
                  return (
                    <li key={r.id} className={r.enabled ? '' : 'off'}>
                      <input
                        type="checkbox" checked={r.enabled} title={r.enabled ? 'Switch this rule off' : 'Switch this rule on'} aria-label="Rule is on"
                        onChange={e => guard(() => call('saveRule', { id: r.id, enabled: e.target.checked }))}
                      />
                      <span className="rule-text" title={`${d.when} → ${d.what}`}>
                        <b>{d.when}</b>
                        <small><Icon name="next" size={14} /> {d.what}{r.hits > 0 && ` · ${r.hits.toLocaleString()} sorted so far`}</small>
                      </span>
                      <IconButton icon="refresh" label="Apply this rule now to mail already in the inbox" size={18} onClick={() => !busy && runNow(r)} />
                      <IconButton icon="edit" label="Change this rule" size={18} onClick={() => setEdit({ ...r })} />
                      <IconButton icon="trash" label="Remove this rule" size={18} onClick={() => !busy && guard(() => call('removeRule', r.id))} />
                    </li>
                  )
                })}
              </ul>
            </>
          )}

          {!edit && error && <p className="error">{error}</p>}

          {edit && (
            <form className="rule-form" onSubmit={save} id="rule-form">
              <label className="tf">
                <span>Mailbox</span>
                <select title="Which mailbox this rule applies to" value={edit.account ?? ''} onChange={e => set({ account: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">Every mailbox</option>
                  {p.accounts.map(a => <option key={a.id} value={a.id}>{a.email}</option>)}
                </select>
              </label>
              <label className="tf">
                <span>From contains</span>
                <input autoFocus spellCheck={false} placeholder="stripe.com, receipts@" title="Part of the sender's name or address. Several, separated by commas, mean any of them." value={edit.from} onChange={e => set({ from: e.target.value })} />
              </label>
              <div className="pair">
                <label className="tf">
                  <span>Subject contains</span>
                  <input spellCheck={false} placeholder="invoice, receipt" title="Words in the subject. Several, separated by commas, mean any of them." value={edit.subject} onChange={e => set({ subject: e.target.value })} />
                </label>
                <label className="tf">
                  <span>Sent to contains</span>
                  <input spellCheck={false} placeholder="billing@" title="Part of a recipient's address, for mail sent to an alias" value={edit.to} onChange={e => set({ to: e.target.value })} />
                </label>
              </div>
              <div className="pair">
                <label className="tf">
                  <span>Then</span>
                  <select title="What to do with matching mail" value={edit.action} onChange={e => set({ action: e.target.value as Rule['action'] })}>
                    {ACTIONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                  </select>
                </label>
                {edit.action === 'move' && (
                  <label className="tf">
                    <span>Folder</span>
                    <input required spellCheck={false} list="rule-folders" placeholder="Money/Receipts" title="Pick a folder or type a new name; it is created when first needed" value={edit.folder} onChange={e => set({ folder: e.target.value })} />
                    <datalist id="rule-folders">{names.map(n => <option key={n} value={n} />)}</datalist>
                  </label>
                )}
              </div>
              {(edit.action === 'move' || edit.action === 'archive') && (
                <label className="check" title="Matching mail will not count as unread">
                  <input type="checkbox" checked={edit.alsoRead} onChange={e => set({ alsoRead: e.target.checked })} /> Also mark it as read
                </label>
              )}
              {error && <p className="error">{error}</p>}
            </form>
          )}
        </div>

        {!edit && (
          <footer>
            <span className="muted">{busy ? 'Working…' : version && `quickMail ${version}`}</span>
            {tab === 'rules' && (
              <button type="button" className="pill" title="Add a sorting rule" disabled={busy} onClick={() => setEdit({ ...BLANK })}><Icon name="add" size={18} /> New rule</button>
            )}
            <button type="button" className="text-btn" title="Close settings" disabled={busy} onClick={close}>Close</button>
          </footer>
        )}

        {edit && (
          <footer>
            <button type="button" className="text-btn" title="Back to the list without saving" disabled={busy} onClick={() => (setEdit(null), setError(''))}>Cancel</button>
            <button type="submit" form="rule-form" className="primary" title="Save this rule" disabled={busy}>Save rule</button>
          </footer>
        )}
      </div>
    </div>
  )
}
