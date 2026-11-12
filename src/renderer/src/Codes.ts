// Finds one-time codes and sign-in links in a message, so the reader can offer to copy them.
// Heuristics only: a code must sit near a word like "code" or "token", and a link must have an action-like label.

export type Found = { codes: string[]; links: { label: string; href: string }[] }

const KEYWORD = /\b(verification|verify|one[- ]time|passcode|security code|login code|sign[- ]?in code|access code|otp|code|token)\b/gi
const ACTION = /log ?in|sign ?in|sign on|verify|confirm|activate|magic|one[- ]click|continue/i

/** Text of an HTML document, with a space between text nodes so words from different blocks don't merge. */
function textOf(html: string): { doc: Document; text: string } {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
  const parts: string[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) parts.push(n.textContent ?? '')
  return { doc, text: parts.join(' ').replace(/\s+/g, ' ') }
}

function codesIn(text: string): string[] {
  const keys = [...text.matchAll(KEYWORD)].map(m => m.index ?? 0)
  if (!keys.length) return []
  const out: string[] = []
  for (const m of text.matchAll(/\b[A-Za-z0-9]{4,10}\b/g)) {
    const v = m[0]
    const at = m.index ?? 0
    const numeric = /^\d{4,8}$/.test(v)
    const mixed = v.length >= 6 && /\d/.test(v) && /[A-Za-z]/.test(v)
    if (!numeric && !mixed) continue
    // A keyword up to 80 characters before the value, or up to 40 characters after it.
    if (!keys.some(k => (k <= at ? at - k <= 80 : k - at <= 40))) continue
    if (!out.includes(v)) out.push(v)
  }
  return out.slice(0, 3)
}

function linksIn(doc: Document): { label: string; href: string }[] {
  const out: { label: string; href: string }[] = []
  for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
    const href = a.getAttribute('href') ?? ''
    const label = (a.textContent ?? '').trim().replace(/\s+/g, ' ')
    if (!/^https?:\/\//i.test(href)) continue
    if (!ACTION.test(label) || /unsubscribe|preferences|privacy|terms/i.test(label)) continue
    if (!out.some(x => x.href === href)) out.push({ label, href })
  }
  return out.slice(0, 3)
}

export function findCodes(html: string, text: string): Found {
  if (!html) return { codes: codesIn(text ?? ''), links: [] }
  const { doc, text: htmlText } = textOf(html)
  // Plain-text parts are usually cleaner than the HTML text, so they win when present.
  const plain = (text ?? '').trim() ? text.replace(/\s+/g, ' ') : htmlText
  return { codes: codesIn(plain), links: linksIn(doc) }
}
