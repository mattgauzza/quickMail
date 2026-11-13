import { type RefObject, useLayoutEffect, useReducer, useRef } from 'react'

/** Motion for the conversation list: rows that leave fade out and fold away so the rows below slide up,
 *  rows that change place glide there, and new rows fade in. Rows carry `data-k` with their display key. */

export const calm = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
const EASE = 'cubic-bezier(.2, 0, 0, 1)'
const LEAVE_MS = 420
const MOVE_MS = 300
const ENTER_MS = 260

export interface Shown<T> { key: string; value: T; leaving: boolean }

/**
 * `items` is what should be on screen; the result also holds rows that just left, flagged `leaving`, at the
 * place they had, until their fade-out ends. `reset` changes when the whole list is swapped (another folder,
 * page or search): then nothing animates.
 */
export function useListMotion<T>(items: { key: string; value: T }[], reset: string, box: RefObject<HTMLElement | null>): Shown<T>[] {
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  const shown = useRef<Shown<T>[]>([]) // what the last commit put on screen
  const lastReset = useRef(reset)
  const finished = useRef(new Set<string>()) // leaving rows whose fade-out is over
  const before = useRef<Map<string, DOMRect> | null>(null)
  const order = useRef('')

  const swapped = lastReset.current !== reset
  const present = new Set(items.map(i => i.key))
  let next: Shown<T>[] = items.map(i => ({ ...i, leaving: false }))
  // A list that empties all at once is being swapped too: the app clears the old rows a moment after
  // the view changes, and they shouldn't fade out under the new folder's name.
  if (!swapped && items.length > 0) {
    // Each row that left goes back after the nearest row above it that is still shown.
    shown.current.forEach((old, i) => {
      if (present.has(old.key) || finished.current.has(old.key)) return
      let at = 0
      for (let j = i - 1; j >= 0; j--) {
        const k = next.findIndex(n => n.key === shown.current[j].key)
        if (k >= 0) { at = k + 1; break }
      }
      next.splice(at, 0, { ...old, leaving: true })
    })
  }

  // Note where every row is before React moves anything, but only when the order really changes.
  const sig = next.map(n => n.key + (n.leaving ? '~' : '')).join('|')
  if (sig !== order.current && !swapped && box.current && !calm()) {
    const m = new Map<string, DOMRect>()
    box.current.querySelectorAll<HTMLElement>('[data-k]').forEach(el => m.set(el.dataset.k!, el.getBoundingClientRect()))
    before.current = m
  }

  useLayoutEffect(() => {
    const was = shown.current
    const wasKeys = new Set(was.map(s => s.key))
    shown.current = next
    lastReset.current = reset
    for (const k of finished.current) if (!next.some(n => n.key === k)) finished.current.delete(k)
    if (sig === order.current) return
    order.current = sig
    const rects = before.current
    before.current = null
    const el = box.current
    if (!el || swapped || calm()) {
      // No motion: rows that left go at once.
      const gone = next.filter(n => n.leaving)
      if (gone.length) (gone.forEach(n => finished.current.add(n.key)), redraw())
      return
    }
    const view = el.getBoundingClientRect()
    const rows = new Map<string, HTMLElement>()
    el.querySelectorAll<HTMLElement>('[data-k]').forEach(r => rows.set(r.dataset.k!, r))
    const firstFill = was.length === 0
    let stagger = 0

    for (const n of next) {
      const row = rows.get(n.key)
      if (!row) {
        if (n.leaving) (finished.current.add(n.key), redraw()) // not on screen (the reader covers the list)
        continue
      }
      if (n.leaving) {
        if (row.dataset.leaving) continue
        row.dataset.leaving = '1'
        const h = row.offsetHeight
        const done = () => { finished.current.add(n.key); redraw() }
        if (!rects?.get(n.key) || h === 0) { done(); continue }
        row.style.overflow = 'hidden'
        row.style.pointerEvents = 'none'
        row.animate(
          [
            { opacity: 1, height: `${h}px`, minHeight: '0px', transform: 'translateX(0)' },
            { opacity: 0, height: `${h}px`, minHeight: '0px', transform: 'translateX(-14px)', offset: 0.4 },
            { opacity: 0, height: '0px', minHeight: '0px', paddingTop: '0px', paddingBottom: '0px', borderBottomWidth: '0px', transform: 'translateX(-14px)' }
          ],
          { duration: LEAVE_MS, easing: EASE, fill: 'forwards' }
        ).onfinish = done
        continue
      }
      if (row.dataset.leaving) {
        // It came back before it was gone (e.g. a move that failed): show it again.
        delete row.dataset.leaving
        row.getAnimations().forEach(a => a.cancel())
        row.style.overflow = row.style.pointerEvents = ''
        continue
      }
      const now = row.getBoundingClientRect()
      if (now.bottom < view.top || now.top > view.bottom) continue // off screen: nothing to see
      const then = rects?.get(n.key)
      if (!wasKeys.has(n.key) || !then) {
        // A new row. On a list's first fill the rows arrive one after another, top first.
        const delay = firstFill ? Math.min(stagger++, 14) * 18 : 0
        row.animate(
          [{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }],
          { duration: ENTER_MS, delay, easing: EASE, fill: 'backwards' }
        )
        continue
      }
      const dy = then.top - now.top
      if (Math.abs(dy) < 1) continue
      row.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: MOVE_MS, easing: EASE, composite: 'add' })
    }
  })

  return next
}
