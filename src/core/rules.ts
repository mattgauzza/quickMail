import { account, all, changed, get, placeholders, run } from './db'
import { deleteMessages, moveMessages, setFlags } from './imap'

/**
 * Sorting rules: what to do with mail as it arrives in an inbox ("from Stripe -> move to Money/Receipts").
 * They run after each check for new mail, in order; the first rule that matches a message wins.
 * `from`, `subject` and `to` are "contains" tests, not case sensitive; several comma-separated words mean "any of these".
 */
export interface Rule {
  id: number
  /** Account id the rule is limited to; null for every mailbox. */
  account: number | null
  from: string
  subject: string
  to: string
  action: 'move' | 'archive' | 'trash' | 'read' | 'star'
  /** Destination for action "move" (a folder name or path; created if missing). */
  folder: string
  /** Also mark the message read (for move / archive). */
  alsoRead: boolean
  enabled: boolean
  /** How many messages this rule has sorted so far. */
  hits: number
}

export const RULE_ACTIONS = ['move', 'archive', 'trash', 'read', 'star'] as const

const fromRow = (r: any): Rule => ({
  id: r.id, account: r.account_id, from: r.from_text, subject: r.subject_text, to: r.to_text, action: r.action,
  folder: r.folder, alsoRead: !!r.also_read, enabled: !!r.enabled, hits: r.hits
})

export const listRules = () => all<any>('SELECT * FROM rules ORDER BY position, id').map(fromRow)

const getRule = (id: number) => {
  const r = get<any>('SELECT * FROM rules WHERE id=?', id)
  if (!r) throw new Error(`No rule with id ${id}`)
  return fromRow(r)
}

/** Add a rule, or change one when `id` is given. `account` may be an id, an email, or empty for every mailbox. */
export function saveRule(o: Partial<Omit<Rule, 'account' | 'hits'>> & { account?: number | string | null }) {
  const old = o.id ? getRule(o.id) : null
  const acct = o.account === undefined ? old?.account ?? null : o.account === null || o.account === '' || o.account === 'all' ? null : account(o.account).id
  const r = {
    from: (o.from ?? old?.from ?? '').trim(), subject: (o.subject ?? old?.subject ?? '').trim(), to: (o.to ?? old?.to ?? '').trim(),
    action: o.action ?? old?.action ?? 'move', folder: (o.folder ?? old?.folder ?? '').trim(),
    alsoRead: o.alsoRead ?? old?.alsoRead ?? false, enabled: o.enabled ?? old?.enabled ?? true
  }
  if (!r.from && !r.subject && !r.to) throw new Error('A rule needs something to look for: a sender, a subject or a recipient')
  if (!RULE_ACTIONS.includes(r.action)) throw new Error(`Unknown action "${r.action}". Use one of: ${RULE_ACTIONS.join(', ')}`)
  if (r.action === 'move' && !r.folder) throw new Error('Say which folder to move the mail to')
  if (r.action !== 'move') r.folder = ''
  const vals = [acct, r.from, r.subject, r.to, r.action, r.folder, +r.alsoRead, +r.enabled]
  let id = old?.id
  if (id) run('UPDATE rules SET account_id=?, from_text=?, subject_text=?, to_text=?, action=?, folder=?, also_read=?, enabled=? WHERE id=?', ...vals, id)
  else
    id = Number(run(
      `INSERT INTO rules(account_id, from_text, subject_text, to_text, action, folder, also_read, enabled, position)
       VALUES(?,?,?,?,?,?,?,?, (SELECT COALESCE(MAX(position), 0) + 1 FROM rules))`, ...vals
    ).lastInsertRowid)
  changed()
  return getRule(id)
}

export function removeRule(id: number) {
  getRule(id)
  run('DELETE FROM rules WHERE id=?', id)
  changed()
}

const words = (s: string) => s.toLowerCase().split(',').map(x => x.trim()).filter(Boolean)

/** Inbox messages a rule matches: all of them, or only those among `ids`. Starred mail is never moved away. */
function matches(r: Rule, ids?: number[]): number[] {
  const w: string[] = []
  const p: any[] = []
  const any = (text: string, cols: string[]) => {
    const ws = words(text)
    if (!ws.length) return
    w.push(`(${ws.map(() => cols.map(c => `instr(lower(${c}), ?) > 0`).join(' OR ')).join(' OR ')})`)
    for (const x of ws) for (const _ of cols) p.push(x)
  }
  any(r.from, ['m.from_addr', 'm.from_name'])
  any(r.subject, ['m.subject'])
  any(r.to, ['m.to_json', 'm.cc_json'])
  if (!w.length) return []
  if (r.account !== null) { w.push('m.account_id=?'); p.push(r.account) }
  if (['move', 'archive', 'trash'].includes(r.action)) w.push('m.flagged=0')
  if (r.action === 'read') w.push('m.seen=0')
  if (r.action === 'star') w.push('m.flagged=0')
  const sql = `SELECT m.id FROM messages m WHERE m.folder_id IN (SELECT id FROM folders WHERE role='inbox') AND ${w.join(' AND ')}`
  if (!ids) return all<{ id: number }>(`${sql} ORDER BY m.date`, ...p).map(x => x.id)
  const out: number[] = []
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400)
    out.push(...all<{ id: number }>(`${sql} AND m.id IN (${placeholders(part.length)})`, ...p, ...part).map(x => x.id))
  }
  return out
}

async function carryOut(r: Rule, ids: number[]) {
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200)
    // Read state first: a message gets a new id once it has moved.
    if (r.alsoRead && r.action !== 'read' && r.action !== 'trash') await setFlags(part, { seen: true })
    if (r.action === 'move') await moveMessages(part, r.folder, true)
    else if (r.action === 'archive') await moveMessages(part, 'archive')
    else if (r.action === 'trash') await deleteMessages(part)
    else if (r.action === 'read') await setFlags(part, { seen: true })
    else await setFlags(part, { flagged: true })
  }
}

export interface RuleResult { rule: Rule; matched: number; error?: string }

/**
 * Run the rules. With `ids`, only on those messages (mail that just arrived); without, on everything in the inbox.
 * `rule` limits the run to one rule (even a switched-off one); `dryRun` only counts.
 */
export async function applyRules(o: { ids?: number[]; rule?: number; dryRun?: boolean } = {}): Promise<RuleResult[]> {
  if (o.ids && !o.ids.length) return []
  const rules = o.rule ? [getRule(o.rule)] : listRules().filter(r => r.enabled)
  const taken = new Set<number>()
  const results: RuleResult[] = []
  for (const r of rules) {
    const hit = matches(r, o.ids).filter(id => !taken.has(id))
    hit.forEach(id => taken.add(id))
    const res: RuleResult = { rule: r, matched: hit.length }
    if (!o.dryRun && hit.length) {
      try {
        await carryOut(r, hit)
        run('UPDATE rules SET hits=hits+? WHERE id=?', hit.length, r.id)
      } catch (e: any) {
        res.error = String(e?.message ?? e)
      }
    }
    results.push(res)
  }
  if (!o.dryRun && taken.size) changed()
  return results
}
