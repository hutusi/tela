/**
 * What a member's device adds to Discover's public pages (ADR 0044), as hooks: how they read, the
 * blogs and people to leave out, and who among a post's recommenders they follow. The first two
 * are taken once, when the page opens with the member's rows on the device, so a Subscribe or a
 * Follow from the page leaves its card where it is, showing Subscribed or Following, until the
 * member comes back; who they follow among the recommenders is read live.
 */
import type { Tables } from '@tela/sync'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useNavigationType } from 'react-router'
import { useSession } from '../session'
import { useReadingLang, useStore, useTables } from '../store/hooks'
import type { DiscoverPost, Person, Reading } from '../views/types'
import { followedAmong, type Hidden, hiddenOf, NOTHING_HIDDEN } from './discover-overlay'
import { readingPrefsOf } from './prefs'
import { type Mine, mineOf } from './suggest-readers'

/**
 * A value of the member's rows as the page opened: taken at the first render that has them (the
 * profile row is there once the first pull has landed), and again only for another account.
 * Null for a visitor, and until then.
 */
export function useOpenedWith<T>(take: (tables: Tables, owner: string) => T): T | null {
  const { status } = useSession()
  const { store } = useStore()
  const tables = useTables()
  const held = useRef<{ owner: string; value: T } | null>(null)
  const owner = status === 'member' && tables.profile !== null ? store.userId : null
  if (owner === null) return null
  // Taken once per account, during render, so the first render that can show the page shows it
  // already without what the member reads.
  if (held.current?.owner !== owner) held.current = { owner, value: take(tables, owner) }
  return held.current.value
}

/** The blogs the member reads as the page opened; nothing for a visitor. */
export function useHidden(): Hidden {
  return useOpenedWith(hiddenOf) ?? NOTHING_HIDDEN
}

/** The language the member reads in, and the ones they never translate, as one stable object. */
export function useReading(locale: string): Reading {
  const tables = useTables()
  const lang = useReadingLang(locale)
  const never = readingPrefsOf(tables).never
  return useMemo(() => ({ lang, never }), [lang, never])
}

const NOBODY: readonly Person[] = []

/** Whom the member follows among a post's recommenders, from the device's follows as they are. */
export function useFollowed(member: boolean): (post: DiscoverPost) => readonly Person[] {
  const follows = useTables().follows
  return useCallback(
    (post: DiscoverPost) => (member ? followedAmong(post, follows) : NOBODY),
    [member, follows],
  )
}

/**
 * The member's own side of the reader suggestions (`mineOf`): themselves and whom they followed
 * as the page opened are left out. Null for a visitor, who gets the public groups.
 */
export function useMine(reading: Reading): Mine | null {
  const tables = useTables()
  const excluded = useOpenedWith(
    (t, owner): ReadonlySet<string> => new Set([owner, ...t.follows.keys()]),
  )
  return useMemo(
    () => (excluded ? mineOf(tables, excluded, reading) : null),
    [tables, excluded, reading],
  )
}

/**
 * A page reached by a link opens at its top: one already held renders at once, and the browser
 * would keep the scroll of the page left. Back and Forward (`POP`) stay where the browser puts
 * them, as the info pages do. `key` names the page: a new one is a new arrival.
 */
export function useTopOnArrival(key: string): void {
  const navigation = useNavigationType()
  // biome-ignore lint/correctness/useExhaustiveDependencies: on each page, as it was reached
  useEffect(() => {
    if (navigation !== 'POP') window.scrollTo(0, 0)
  }, [key])
}
