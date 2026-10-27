/**
 * Opening a public page's post (ADR 0066): the page carries no content key, so a member's tab
 * fetches the post's row by id and holds it as if it had synced it, with the titles the page
 * showed; the reader shows it loading meanwhile, never gone.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { MEMBER_HEADER } from '@tela/sync'
import { holdArticle } from '../src/lib/member'
import { memoryPersistence } from '../src/store/db'
import { LocalStore } from '../src/store/local'
import type { PublicArticle } from '../src/views/types'
import { article, NOW, profile, pull, sub } from './rows'

const saved = globalThis.fetch
afterAll(() => {
  globalThis.fetch = saved
})

/** What `/api/v1/articles/:id` was asked, and by whom; answered by `answer`. */
let asked: { path: string; member: string | null }[] = []
let answer: (path: string) => Promise<Response> = async () => new Response(null, { status: 500 })

beforeEach(() => {
  asked = []
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    asked.push({ path: input, member: new Headers(init?.headers).get(MEMBER_HEADER) })
    return answer(input)
  }) as typeof fetch
})

async function member() {
  const store = new LocalStore(memoryPersistence(), () => NOW)
  await store.open()
  await store.setUser('a')
  await store.applyPull(
    pull(5, { profile: [profile], subscriptions: [sub(1)], articles: [article(7)] }, true),
    store.epoch,
  )
  return store
}

/** Post 50 of blog 9 as a public page has it: no content key, its title in French. */
function fromPage(): PublicArticle {
  const { contentKey: _key, ...row } = article(50, { feedId: 9 })
  return { ...row, titles: { fr: 'Billet 50' } }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('holding a public post', () => {
  test('fetches its row by id for the member, shown loading until it lands', async () => {
    const store = await member()
    let release = () => {}
    answer = () =>
      new Promise((resolve) => {
        release = () => resolve(json({ article: article(50, { feedId: 9, contentKey: 'ckey50' }) }))
      })
    const before = store.getSnapshot().version
    const held = holdArticle(store, fromPage(), 'Elsewhere')
    expect(store.isFetching(50)).toBe(true)
    expect(store.article(store.getSnapshot().tables, 50)).toBeUndefined()
    expect(store.getSnapshot().version).toBeGreaterThan(before)
    release()
    await held
    expect(asked).toEqual([{ path: '/api/v1/articles/50', member: 'a' }])
    expect(store.isFetching(50)).toBe(false)
    const row = store.article(store.getSnapshot().tables, 50) as PublicArticle | undefined
    expect(row?.contentKey).toBe('ckey50')
    // The titles the page showed stay, for the reader's title in the member's language.
    expect(row?.titles).toEqual({ fr: 'Billet 50' })
    expect(store.sourceName(9)).toBe('Elsewhere')
  })

  test('asks nothing for a post the device holds with its key, or one the page keyed', async () => {
    const store = await member()
    const synced = article(7, { contentKey: 'ckey7' })
    await store.applyPull(pull(6, { articles: [synced] }), store.epoch)
    const { contentKey: _key, ...seven } = synced
    await holdArticle(store, seven, null)
    // A tela-api from before ADR 0066 still keyed its public posts.
    await holdArticle(store, { ...fromPage(), contentKey: 'old-key' }, 'Elsewhere')
    expect(asked).toEqual([])
    expect(store.article(store.getSnapshot().tables, 50)?.contentKey).toBe('old-key')
  })

  test('a post Tela no longer holds is gone; one that cannot be fetched keeps the page’s row', async () => {
    const store = await member()
    answer = async () => json({ error: 'not_found' }, 404)
    await holdArticle(store, fromPage(), null)
    expect(store.isFetching(50)).toBe(false)
    expect(store.article(store.getSnapshot().tables, 50)).toBeUndefined()

    answer = async () => {
      throw new TypeError('offline')
    }
    await holdArticle(store, fromPage(), null)
    const row = store.article(store.getSnapshot().tables, 50)
    expect([row?.title, row?.contentKey]).toEqual(['Post 50', null])
  })

  test('an answer for an account the tab no longer holds is dropped', async () => {
    const store = await member()
    let release = () => {}
    answer = () =>
      new Promise((resolve) => {
        release = () => resolve(json({ article: article(50, { feedId: 9, contentKey: 'ckey50' }) }))
      })
    const held = holdArticle(store, fromPage(), null)
    await store.setUser('b')
    release()
    await held
    expect(store.article(store.getSnapshot().tables, 50)).toBeUndefined()
    expect(store.isFetching(50)).toBe(false)
  })
})
