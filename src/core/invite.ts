// Calendar invitations that arrive by mail (iCalendar / iTIP): read the event, and build the reply
// that tells the organizer "yes", "no" or "maybe".

export type Answer = 'ACCEPTED' | 'DECLINED' | 'TENTATIVE'

export interface Invite {
  /** REQUEST (an invitation or update), CANCEL, REPLY, ... */
  method: string
  uid: string
  summary: string
  /** ms since epoch; for all-day events, local midnight. */
  start: number
  end: number
  allDay: boolean
  location: string
  organizer: { name: string; email: string } | null
  attendees: { name: string; email: string; status: string }[]
  /** Original lines the reply must echo back unchanged. */
  raw: Record<string, string>
}

interface Line { name: string; params: Record<string, string>; value: string; text: string }

function lines(ics: string): Line[] {
  return ics
    .replace(/\r?\n[ \t]/g, '') // long lines are folded with a leading space
    .split(/\r?\n/)
    .map(text => {
      const m = /^([A-Za-z0-9-]+)((?:;[^=;:]+=(?:"[^"]*"|[^;:]*))*):(.*)$/.exec(text)
      if (!m) return null
      const params: Record<string, string> = {}
      for (const p of m[2].match(/;[^=;:]+=(?:"[^"]*"|[^;:]*)/g) || []) {
        const i = p.indexOf('=')
        params[p.slice(1, i).toUpperCase()] = p.slice(i + 1).replace(/^"|"$/g, '')
      }
      return { name: m[1].toUpperCase(), params, value: m[3], text }
    })
    .filter((l): l is Line => !!l)
}

const unescape = (s: string) => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1')
const mail = (s: string) => s.replace(/^mailto:/i, '').trim().toLowerCase()

/** How far a time zone is from UTC at a given moment, in ms. */
function offset(ms: number, zone: string) {
  const p: Record<string, number> = {}
  for (const x of new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric'
  }).formatToParts(new Date(ms)))
    if (x.type !== 'literal') p[x.type] = Number(x.value)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms
}

function when(l?: Line) {
  const m = l && /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(l.value.trim())
  if (!m) return null
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(x => Number(x || 0))
  if (m[4] === undefined) return { ms: new Date(y, mo - 1, d).getTime(), allDay: true }
  if (m[7]) return { ms: Date.UTC(y, mo - 1, d, h, mi, s), allDay: false }
  if (l!.params.TZID) {
    try {
      const wall = Date.UTC(y, mo - 1, d, h, mi, s)
      return { ms: wall - offset(wall - offset(wall, l!.params.TZID), l!.params.TZID), allDay: false }
    } catch { /* a zone name this system does not know: read it as local time */ }
  }
  return { ms: new Date(y, mo - 1, d, h, mi, s).getTime(), allDay: false }
}

export function parseInvite(ics: string): Invite | null {
  const all = lines(ics)
  const from = all.findIndex(l => l.name === 'BEGIN' && l.value.toUpperCase() === 'VEVENT')
  if (from < 0) return null
  const to = all.findIndex((l, i) => i > from && l.name === 'END' && l.value.toUpperCase() === 'VEVENT')
  // Alarms nested in the event carry their own DESCRIPTION / TRIGGER lines; skip them.
  const ev: Line[] = []
  let nested = 0
  for (const l of all.slice(from + 1, to < 0 ? undefined : to)) {
    if (l.name === 'BEGIN') nested++
    else if (l.name === 'END') nested--
    else if (!nested) ev.push(l)
  }
  const one = (name: string) => ev.find(l => l.name === name)
  const start = when(one('DTSTART'))
  if (!start || !one('UID')) return null
  const end = when(one('DTEND'))
  const org = one('ORGANIZER')
  const raw: Record<string, string> = {}
  for (const name of ['UID', 'SEQUENCE', 'DTSTART', 'DTEND', 'SUMMARY', 'ORGANIZER', 'RECURRENCE-ID']) {
    const l = one(name)
    if (l) raw[name] = l.text
  }
  return {
    method: (all.find(l => l.name === 'METHOD')?.value || 'REQUEST').toUpperCase(),
    uid: one('UID')!.value,
    summary: unescape(one('SUMMARY')?.value || '(no title)'),
    start: start.ms, end: end?.ms ?? start.ms, allDay: start.allDay,
    location: unescape(one('LOCATION')?.value || ''),
    organizer: org ? { name: org.params.CN || '', email: mail(org.value) } : null,
    attendees: ev.filter(l => l.name === 'ATTENDEE').map(l => ({ name: l.params.CN || '', email: mail(l.value), status: (l.params.PARTSTAT || '').toUpperCase() })),
    raw
  }
}

/** Long lines must be folded at 75 bytes; 70 characters keeps us safely under for ordinary text. */
const fold = (s: string) => s.replace(/(.{70})(?=.)/g, '$1\r\n ')

/** The iCalendar REPLY that records one attendee's answer. */
export function buildReply(inv: Invite, me: { name: string; email: string }, answer: Answer) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')
  const cn = me.name ? `;CN="${me.name.replace(/"/g, '')}"` : ''
  return [
    'BEGIN:VCALENDAR', 'PRODID:-//quickMail//EN', 'VERSION:2.0', 'METHOD:REPLY', 'BEGIN:VEVENT',
    ...['UID', 'SEQUENCE', 'RECURRENCE-ID', 'DTSTART', 'DTEND', 'SUMMARY', 'ORGANIZER'].map(k => inv.raw[k]).filter(Boolean),
    `DTSTAMP:${stamp}`,
    `ATTENDEE;PARTSTAT=${answer}${cn}:mailto:${me.email}`,
    'END:VEVENT', 'END:VCALENDAR'
  ].map(fold).join('\r\n') + '\r\n'
}
