/**
 * What opening a post does before its body is on screen (ADR 0066): a subscribed blog's post is
 * read, and its translation asked for, as it opens, as always; any other's waits for its body,
 * so one refused for the day's limit is neither read nor paid to translate.
 */
import { describe, expect, test } from 'bun:test'
import { asksForTranslation, openMarker } from '../src/lib/open-post'
import { PREF_KEYS } from '../src/lib/prefs'
import { memoryPersistence } from '../src/store/db'
import { LocalStore } from '../src/store/local'
import { isRead } from '../src/store/selectors'
import { article, NOW, profile, pull, sub } from './rows'

/**
 * A store holding account `a`, who subscribes to feed 1 and holds post 7 from it. Fetched a moment
 * ago by the wall clock, which opening reads unread by: older than the horizon is read already.
 */
async function member() {
  const fetchedAt = Date.now() - 1000
  const store = new LocalStore(memoryPersistence(), () => NOW)
  await store.open()
  await store.setUser('a')
  await store.applyPull(
    pull(
      5,
      { profile: [profile], subscriptions: [sub(1)], articles: [article(7, { fetchedAt })] },
      true,
    ),
    store.epoch,
  )
  // A post from a blog the member does not subscribe to, held from a public page.
  store.remember([article(20, { feedId: 9, fetchedAt })])
  return store
}

const read = (store: LocalStore, id: number) => {
  const { tables } = store.getSnapshot()
  const post = store.article(tables, id)
  return post ? isRead(tables, post, Date.now()) : null
}

const post = (store: LocalStore, id: number) => {
  const found = store.article(store.getSnapshot().tables, id)
  if (!found) throw new Error(`no post ${id}`)
  return found
}

describe('asking for a translation as a post opens', () => {
  const base = { wanted: true, subscribed: false, answered: false, refused: false }

  test('a subscribed blog’s post asks at once, before its body has answered', () => {
    expect(asksForTranslation({ ...base, subscribed: true })).toBe(true)
  })

  test('any other’s waits for its body, and a refused one never asks', () => {
    expect(asksForTranslation(base)).toBe(false)
    expect(asksForTranslation({ ...base, answered: true })).toBe(true)
    expect(asksForTranslation({ ...base, answered: true, refused: true })).toBe(false)
    // Subscribed from the refused post: nothing until the body comes.
    expect(asksForTranslation({ ...base, subscribed: true, answered: true, refused: true })).toBe(
      false,
    )
  })

  test('nothing is asked for while translation is not wanted', () => {
    expect(asksForTranslation({ ...base, wanted: false, subscribed: true, answered: true })).toBe(
      false,
    )
  })
})

describe('marking a post read by opening it', () => {
  test('a subscribed blog’s post is read as it opens, once per open', async () => {
    const store = await member()
    const marker = openMarker(store)
    marker.opened(post(store, 7))
    expect(read(store, 7)).toBe(true)
    // Marked unread while open: the body landing after does not read it again.
    store.mutate({ type: 'markUnread', articleId: 7 })
    marker.readable(7)
    expect(read(store, 7)).toBe(false)
    // The next open does.
    marker.left()
    marker.opened(post(store, 7))
    expect(read(store, 7)).toBe(true)
  })

  test('any other’s waits for its body: refused, it stays unread', async () => {
    const store = await member()
    const marker = openMarker(store)
    marker.opened(post(store, 20))
    // Refused for the day: the Reader never says it is readable.
    expect(read(store, 20)).toBe(false)
    marker.readable(20)
    expect(read(store, 20)).toBe(true)
    // Marked unread, then the body asked for again (Try again): still once per open.
    store.mutate({ type: 'markUnread', articleId: 20 })
    marker.readable(20)
    expect(read(store, 20)).toBe(false)
  })

  test('nothing is marked when the member marks posts read themselves', async () => {
    const store = await member()
    store.mutate({ type: 'setPref', key: PREF_KEYS.markOnOpen, value: false })
    const marker = openMarker(store)
    marker.opened(post(store, 7))
    marker.readable(20)
    expect([read(store, 7), read(store, 20)]).toEqual([false, false])
  })
})
