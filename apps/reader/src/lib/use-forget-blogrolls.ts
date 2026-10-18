/**
 * Forget the public copies of the member's own blogrolls once the server has a change to one
 * (ADR 0050): its page, their profile and Discover, held this visit and cached by the browser,
 * still show what they showed. Called from `Routed`, as the profile's own watch is.
 *
 * It watches each blogroll's sequence numbers, its own row's and its blogs': a prediction keeps
 * the `seq` its row had, so only a pull that brought the server's rows moves them. A deletion is
 * the exception, since the view lets the row go as soon as it is predicted: its copies are
 * forgotten then, and again once the next pull has landed, so a copy fetched in between (the
 * server not having the deletion yet) is not kept. A new handle forgets the cards that name the
 * old one.
 */
import type { Tables } from '@tela/sync'
import { useEffect, useMemo, useRef } from 'react'
import { profilePath } from '../pages/profile'
import { useStore, useTables } from '../store/hooks'
import { BLOGROLLS_PATH, blogrollPath } from './blogroll-href'
import { forgetPublic } from './use-public'

/**
 * The newest sequence number of each of the member's blogrolls: its own row's, or its blogs'
 * (removed ones included), whichever is later.
 */
export function blogrollSeqs(t: Pick<Tables, 'blogrolls' | 'blogrollBlogs'>): Map<string, number> {
  const seqs = new Map<string, number>()
  for (const row of t.blogrolls.values()) seqs.set(row.id, row.seq)
  for (const row of t.blogrollBlogs.values()) {
    const held = seqs.get(row.blogrollId)
    if (held !== undefined && row.seq > held) seqs.set(row.blogrollId, row.seq)
  }
  return seqs
}

/**
 * Which blogrolls changed from `before` to `after`: a sequence number that moved, a blogroll that
 * came, and one that went.
 */
export function changedBlogrolls(
  before: ReadonlyMap<string, number>,
  after: ReadonlyMap<string, number>,
): { moved: string[]; gone: string[] } {
  const moved: string[] = []
  const gone: string[] = []
  for (const [id, seq] of after) if (before.get(id) !== seq) moved.push(id)
  for (const id of before.keys()) if (!after.has(id)) gone.push(id)
  return { moved, gone }
}

export function useForgetBlogrolls(): void {
  const { store } = useStore()
  const tables = useTables()
  const handle = tables.profile?.handle ?? null
  const cursor = store.cursor
  const seqs = useMemo(() => blogrollSeqs(tables), [tables])
  const key = useMemo(() => [...seqs].map(([id, seq]) => `${id}:${seq}`).join(','), [seqs])
  const last = useRef<{ seqs: Map<string, number>; handle: string | null } | null>(null)
  /** Deletions forgotten as predicted, to forget again once a pull lands after this cursor. */
  const again = useRef<{ ids: Set<string>; cursor: number } | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `seqs`
  useEffect(() => {
    const was = last.current
    last.current = { seqs, handle }
    // The first render is what the device loaded, not a change: nothing to forget yet.
    if (was === null) return
    const forget = (ids: Iterable<string>, profiles: (string | null)[]) => {
      let any = false
      for (const id of ids) {
        forgetPublic(blogrollPath(id))
        any = true
      }
      if (!any) return
      for (const h of new Set(profiles)) if (h) forgetPublic(profilePath(h))
      forgetPublic(BLOGROLLS_PATH)
    }
    const { moved, gone } = changedBlogrolls(was.seqs, seqs)
    forget([...moved, ...gone], [was.handle, handle])
    if (gone.length > 0) {
      again.current = { ids: new Set([...(again.current?.ids ?? []), ...gone]), cursor }
    }
    // A new handle: the cards on Discover and the copies of the old profile name the old one.
    if (was.handle !== handle && seqs.size > 0) forget(seqs.keys(), [was.handle, handle])
  }, [key, handle])

  useEffect(() => {
    const pending = again.current
    if (!pending || cursor === pending.cursor) return
    again.current = null
    for (const id of pending.ids) forgetPublic(blogrollPath(id))
    if (handle) forgetPublic(profilePath(handle))
    forgetPublic(BLOGROLLS_PATH)
  }, [cursor, handle])
}
