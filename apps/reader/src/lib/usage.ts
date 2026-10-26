/**
 * What the member has used of their limits (ADR 0063): `GET /api/v1/account/usage`, a live answer,
 * kept in memory only. Settings reads it fresh each time it shows it; the subscribe paths read the
 * subscription cap from whichever answer came last, asked once per tab by the first page that
 * offers a Subscribe (`primeUsage`). Without an answer nothing is refused here: tela-api holds the
 * cap all the same, and this only lets the device say so before a refusal would go unheard.
 *
 * Each answer is kept for the account that asked, so a tab that has since signed in as someone
 * else never reads another account's cap.
 */
import type { AccountUsage } from '@tela/shared'
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { api } from '../store/api'

let known: { member: string; usage: AccountUsage } | null = null
let asked: string | null = null
const listeners = new Set<() => void>()

const isLimit = (v: unknown): v is number | null => v === null || typeof v === 'number'
const isCount = (v: unknown): v is number => typeof v === 'number'
const record = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null

/** The answer, or null for one of another shape: a count read under the wrong name refuses nothing. */
export function readUsage(body: unknown): AccountUsage | null {
  const b = record(body)
  const tr = record(b?.translations)
  const feeds = record(b?.feeds)
  const subs = record(b?.subscriptions)
  if (!b || !tr || !feeds || !subs || typeof b.exempt !== 'boolean') return null
  if (!isLimit(tr.perDay) || !isCount(tr.usedToday) || !isCount(tr.waiting)) return null
  if (!isCount(tr.resetsAt) || !isLimit(feeds.perDay) || !isCount(feeds.addedToday)) return null
  if (!isCount(feeds.pending) || !isLimit(subs.max) || !isCount(subs.count)) return null
  return {
    translations: {
      perDay: tr.perDay,
      usedToday: tr.usedToday,
      waiting: tr.waiting,
      resetsAt: tr.resetsAt,
    },
    feeds: { perDay: feeds.perDay, addedToday: feeds.addedToday, pending: feeds.pending },
    subscriptions: { max: subs.max, count: subs.count },
    exempt: b.exempt,
  }
}

function emit() {
  for (const listener of listeners) listener()
}

/** Ask for `member`'s usage now; null when the answer did not come. */
export async function fetchUsage(
  member: string,
  signal?: AbortSignal,
): Promise<AccountUsage | null> {
  try {
    const res = await api('/api/v1/account/usage', { member, ...(signal ? { signal } : {}) })
    if (!res.ok) return null
    const usage = readUsage(await res.json().catch(() => null))
    if (usage) {
      known = { member, usage }
      emit()
    }
    return usage
  } catch {
    // Offline, aborted, or the session moved on (api() has told the session).
    return null
  }
}

/** Ask once per tab for `member`, behind whatever the page is doing. */
export function primeUsage(member: string | null): void {
  if (member === null || asked === member || known?.member === member) return
  asked = member
  void fetchUsage(member).then((usage) => {
    if (!usage && asked === member) asked = null
  })
}

/** The most subscriptions `member` may hold, as their last answer said; null for none or unknown. */
export function subscriptionCap(member: string | null): number | null {
  return member !== null && known?.member === member ? known.usage.subscriptions.max : null
}

/** For tests: forget every answer. */
export function forgetUsage(): void {
  known = null
  asked = null
  emit()
}

/** The member's usage, asked when the page shows it and again on `reload`; null until it comes. */
export function useUsage(member: string | null): {
  usage: AccountUsage | null
  reload: () => void
} {
  const [asking, setAsking] = useState(0)
  const reload = useCallback(() => setAsking((n) => n + 1), [])
  useEffect(() => {
    if (member === null) return
    void asking
    const controller = new AbortController()
    void fetchUsage(member, controller.signal)
    return () => controller.abort()
  }, [member, asking])
  const usage = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => (member !== null && known?.member === member ? known.usage : null),
    () => null,
  )
  return { usage, reload }
}
