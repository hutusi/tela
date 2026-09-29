/**
 * One browser, one session cookie, several tabs: nothing a tab does for one account may land in
 * another's. Each case here was a reproduction of a way it did (review findings P1 and P2), with
 * its assertion turned round.
 *
 * The real `indexedDbPersistence` on fake-indexeddb (two connections to one name are two tabs),
 * the real LocalStore and SyncEngine, and, where the server's answer matters, a real tela-api on
 * libSQL reached through one cookie jar for every tab, as a browser's tabs share it.
 *
 * What this half guarantees on its own: nothing stale is stored, loaded or pushed. A case that
 * also needs tela-api to refuse a call naming another member (protocol 2) says so, and runs only
 * once `MIN_CLIENT` is 2.
 */
import { leaver } from '../src/leave'
import 'fake-indexeddb/auto'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { bumpSeq, currentSeq, type TelaDb } from '@tela/data'
import { MIN_CLIENT, type PushResponse } from '@tela/sync'
import { sql } from 'drizzle-orm'
import { createTestApi, ORIGIN, signedIn, type TestApi } from '../../api/test/helpers'
import { AccountChanged, apiJson, bindApi } from '../src/store/api'
import { indexedDbPersistence, memoryPersistence, type Persistence } from '../src/store/db'
import { type EngineEvents, SyncEngine } from '../src/store/engine'
import { LocalStore } from '../src/store/local'
import { seedEarlierBuild, storedOwner } from './earlier-build'
import { NOW, profile, pull, sub } from './rows'

const saved = { fetch: globalThis.fetch, document: globalThis.document, window: globalThis.window }
const listeners = { addEventListener() {}, removeEventListener() {} }
beforeAll(() => {
  Object.assign(globalThis, {
    document: { visibilityState: 'visible', ...listeners },
    window: listeners,
  })
})
afterAll(() => {
  Object.assign(globalThis, saved)
})

const engines: SyncEngine[] = []
afterEach(() => {
  for (const e of engines.splice(0)) e.stop()
  bindApi({ member: () => null, accountChanged() {}, upgrade() {} })
})
const quiet: EngineEvents = { onSignedOut() {}, onUpgrade() {}, onAccountChanged() {} }
const engineFor = (store: LocalStore, events: Partial<EngineEvents> = {}) => {
  const e = new SyncEngine(store, { ...quiet, ...events })
  engines.push(e)
  return e
}

/** main.tsx's leave: the real leaver, with the navigation recorded instead of made. */
function leaving(store: LocalStore) {
  const left: { forgotten: Promise<void> | null; went: string[] } = { forgotten: null, went: [] }
  const leave = leaver({ stop() {}, store, go: (path) => void left.went.push(path) })
  return {
    left,
    onAccountChanged: () => {
      left.forgotten ??= leave()
    },
  }
}

const fresh = () => `tela-isolation-${crypto.randomUUID()}`
const tick = () => new Promise((r) => setTimeout(r, 0))
const alice = pull(5, { profile: [{ ...profile, handle: 'alice' }], subscriptions: [sub(1)] }, true)
const bob = pull(6, { profile: [{ ...profile, handle: 'bob' }], subscriptions: [sub(2)] }, true)

type Call = { path: string; member: string | null; mids: string[] }

function record(input: unknown, init?: RequestInit): Call {
  const headers = new Headers(init?.headers)
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
  return {
    path: String(input).split('?')[0] ?? '',
    member: headers.get('x-tela-member'),
    mids: (body?.mutations ?? []).map((m: { mid: string }) => m.mid),
  }
}

/** A fake tela-api: answers every call with `answer(path)` and records what it was sent. */
function stub(answer: (path: string) => Response) {
  const calls: Call[] = []
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const call = record(input, init)
    calls.push(call)
    return answer(call.path)
  }) as typeof fetch
  return calls
}

/** A tab: its own connection to the device database, and a store opened on it. */
async function tab(name: string, now: () => number = () => NOW) {
  const store = new LocalStore(await indexedDbPersistence(name), now)
  await store.open()
  return store
}

describe('tabs of one browser, tela-api stubbed', () => {
  test("(a) a change the stale tab makes after the switch is never stored, loaded or sent as b's", async () => {
    const name = fresh()
    const tabA = await tab(name)
    await tabA.setUser('a')
    await tabA.applyPull(alice, tabA.epoch)

    // Tab B signs in as b: its claim wipes a's copy, and it writes b's.
    const tabB = await tab(name)
    expect(tabB.userId).toBe('a')
    await tabB.setUser('b')
    await tabB.applyPull(bob, tabB.epoch)

    // Stale tab A still thinks it is a. Its member makes a change: the database refuses it.
    const calls = stub(() => Response.json({ error: 'account_changed' }, { status: 409 }))
    const { left, onAccountChanged } = leaving(tabA)
    const engineA = engineFor(tabA, { onAccountChanged })
    tabA.mutate({ type: 'subscribe', feedId: 99 })
    await tick()
    expect(left.forgotten).not.toBeNull()
    await left.forgotten
    expect(tabA.hasData).toBe(false)
    expect(tabA.unsent()).toEqual([])
    // The engine stopped when the write was refused: the change never went out, not even as a.
    await engineA.push()
    expect(calls).toEqual([])

    // location.assign('/'): a new store on the same database, b's.
    const reloaded = await tab(name)
    expect(reloaded.userId).toBe('b')
    expect(reloaded.getSnapshot().tables.profile?.handle).toBe('bob')
    expect(reloaded.unsent()).toEqual([])
    const sent = stub((path) =>
      path === '/api/v1/sync'
        ? Response.json(pull(7, {}))
        : Response.json({ applied: [], rejected: [], seq: 7 } satisfies PushResponse),
    )
    await engineFor(reloaded).push()
    expect(sent).toEqual([])
  })

  test("(f) a tab that held no one, signing in as b over a's copy, keeps nothing of a's", async () => {
    const name = fresh()
    // Opened before anyone signed in (a guest on the landing page), so it holds no one.
    const guest = await tab(name)
    expect(guest.userId).toBeNull()
    const tabA = await tab(name)
    await tabA.setUser('a')
    await tabA.applyPull(alice, tabA.epoch)
    tabA.mutate({ type: 'subscribe', feedId: 99 })
    await tick()
    expect((await (await indexedDbPersistence(name)).load()).pending).toHaveLength(1)

    // The guest tab signs in as b.
    await guest.setUser('b')
    const stored = await (await indexedDbPersistence(name)).load()
    expect(stored.rows).toBeNull()
    expect(stored.pending).toEqual([])
    expect(stored.owner).toBe('b')

    // So a's change is not b's to send.
    const booted = await tab(name)
    const calls = stub(() => Response.json({ applied: [], rejected: [], seq: 7 }))
    await engineFor(booted).push()
    expect(calls).toEqual([])
  })

  test("(g) a sign-out's clear between setUser('a') and the first snapshot leaves nothing stored", async () => {
    const storage = memoryPersistence()
    // Tab 1 (a new tab, account a): whoAmI -> setUser('a') -> engine starts -> snapshot pull.
    const tab1 = new LocalStore(storage, () => NOW)
    await tab1.open()
    await tab1.setUser('a')
    // Tab 2 signs out meanwhile.
    const tab2 = new LocalStore(storage, () => NOW)
    await tab2.open()
    await tab2.clear()
    // Tab 1's snapshot lands afterwards: the copy is no one's now, so it is not written.
    let lost = 0
    engineFor(tab1, { onAccountChanged: () => void lost++ })
    await tab1.applyPull(alice, tab1.epoch)
    expect(lost).toBe(1)

    const stored = await storage.load()
    expect(stored.rows).toBeNull()
    expect(stored.owner).toBeNull()

    // The next boot holds nothing and no one: it asks who is signed in, and syncs nothing first.
    const booted = new LocalStore(storage, () => NOW)
    await booted.open()
    expect(booted.hasData).toBe(false)
    const calls = stub(() => Response.json(alice))
    engineFor(booted).start()
    await tick()
    expect(calls).toEqual([])
  })

  test("(h) forgetting a races another tab's sign-in as b, and b's copy survives either way", async () => {
    for (const order of ['release first', 'claim first'] as const) {
      const name = fresh()
      // Tab A's storage delivers each result late, once `delay` is set: until tab B has claimed.
      let delay: Promise<void> | null = null
      const slow = delayed(await indexedDbPersistence(name), () => delay)
      const tabA = new LocalStore(slow, () => NOW)
      await tabA.open()
      await tabA.setUser('a')
      await tabA.applyPull(alice, tabA.epoch)
      const tabB = await tab(name)

      let claimed = () => {}
      delay = new Promise<void>((r) => {
        claimed = r
      })
      let forgetting: Promise<void>
      if (order === 'release first') {
        forgetting = tabA.forgetAccount()
        await tabB.setUser('b')
      } else {
        const claiming = tabB.setUser('b')
        forgetting = tabA.forgetAccount()
        await claiming
      }
      claimed()
      await forgetting
      await tabB.applyPull(bob, tabB.epoch)

      const stored = await (await indexedDbPersistence(name)).load()
      expect({
        order,
        owner: await storedOwner(name),
        handle: stored.rows?.profile?.handle,
      }).toEqual({ order, owner: 'b', handle: 'bob' })
    }
  })

  test('(j) rows an earlier build left with no owner boot as nobody, every time, and send nothing', async () => {
    const name = fresh()
    await seedEarlierBuild(name, alice)
    for (let visit = 0; visit < 3; visit++) {
      const booted = await tab(name)
      // SessionProvider starts as 'member' only with rows and an owner: this is 'unknown'.
      expect(booted.hasData).toBe(false)
      expect(booted.userId).toBeNull()
      const calls = stub(() => Response.json({ error: 'account_changed' }, { status: 409 }))
      engineFor(booted).start()
      booted.mutate({ type: 'markRead', articleId: 1 })
      await engineFor(booted).push()
      await tick()
      expect(calls).toEqual([])
    }
  })

  test('(k) whoever signs in over a copy with no owner does not adopt it: it is wiped', async () => {
    const name = fresh()
    await seedEarlierBuild(name, alice) // someone's rows, whose recorded nowhere
    const booted = await tab(name)
    await booted.setUser('b')
    expect(booted.hasData).toBe(false)
    const stored = await (await indexedDbPersistence(name)).load()
    expect(stored.rows).toBeNull()
    expect(stored.owner).toBe('b')
  })
})

/** `inner`, with every result held back while `until()` gives a promise, and until it settles. */
function delayed(inner: Persistence, until: () => Promise<void> | null): Persistence {
  return new Proxy(inner, {
    get(target, key) {
      const value = Reflect.get(target, key)
      if (typeof value !== 'function') return value
      return async (...args: unknown[]) => {
        const gate = until()
        const result = await value.apply(target, args)
        if (gate) await gate
        return result
      }
    },
  })
}

// ---------------------------------------------------------------------------------------------
// Against a real tela-api on libSQL: one browser, one cookie jar shared by every tab.

async function write(db: TelaDb, ...statements: ReturnType<TelaDb['run']>[]) {
  await db.batch([bumpSeq(db), ...statements] as never)
}
async function addFeed(db: TelaDb, n: number) {
  await write(
    db,
    db.run(sql`insert into sites (id, home_url, title, created_at, updated_at, seq)
      values (${n}, ${`https://blog${n}.example`}, ${`Blog ${n}`}, 0, 0, ${currentSeq})`),
    db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, created_at, updated_at, seq)
      values (${n}, ${n}, ${`https://blog${n}.example/feed`}, ${`blog${n}.example`}, 0, 0, 0, ${currentSeq})`),
  )
}
let nextArticle = 1
async function addArticle(api: TestApi, feedId: number) {
  const id = nextArticle++
  const at = api.clock.now()
  await write(
    api.db,
    api.db.run(sql`insert into articles (id, feed_id, dedup_key, title, fetched_at, sort_at, content_key, seq)
      values (${id}, ${feedId}, ${`k${id}`}, ${`Post ${id}`}, ${at}, ${at}, ${`c${id}`}, ${currentSeq})`),
  )
  return id
}

/**
 * The browser: every tab's fetch goes to tela-api's app, with whatever session cookie the jar
 * holds as the request leaves. Straight to `app.request`, so it needs nothing of the api
 * harness but `createTestApi` and `signedIn`.
 */
function browser(api: TestApi) {
  const jar = { cookie: '' }
  const calls: Call[] = []
  let hold: { match: (c: Call) => boolean; until: Promise<void> } | null = null
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const call = record(input, init)
    calls.push(call)
    const headers = new Headers(init?.headers)
    headers.set('origin', ORIGIN)
    if (jar.cookie) headers.set('cookie', jar.cookie)
    const res = await api.app.request(`${ORIGIN}${String(input)}`, {
      method: init?.method ?? 'GET',
      headers,
      ...(init?.body ? { body: init.body } : {}),
    })
    const h = hold
    if (h?.match(call)) {
      hold = null
      await h.until // the answer is on the wire while the other tab signs in
    }
    return res
  }) as typeof fetch
  return {
    jar,
    calls,
    /** Delay delivering the next matching response until `until` resolves. */
    holdNext(match: (c: Call) => boolean, until: Promise<void>) {
      hold = { match, until }
    },
  }
}

/** A push straight to tela-api as `member`, from another device of theirs. */
function pushAs(api: TestApi, member: { cookie: string; userId: string }, mutations: object[]) {
  return api.app.request(`${ORIGIN}/api/v1/mutations`, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      cookie: member.cookie,
      'content-type': 'application/json',
      'x-tela-client': String(MIN_CLIENT),
      'x-tela-member': member.userId,
    },
    body: JSON.stringify({
      mutations: mutations.map((m, i) => ({
        mid: `srv-${crypto.randomUUID()}-${i}`,
        at: api.clock.now(),
        ...m,
      })),
    }),
  })
}

async function serverSubscriptions(api: TestApi, userId: string): Promise<number[]> {
  const rows = (await api.db.all(
    sql`select feed_id as feedId from subscriptions where user_id = ${userId} and deleted_at is null order by feed_id`,
  )) as { feedId: number }[]
  return rows.map((r) => r.feedId)
}

/** Tab A signed in as a and synced, then tab B signed in as b and synced, on one database. */
async function twoAccounts(api: TestApi) {
  const a = await signedIn(api, 'alice@x.test')
  const b = await signedIn(api, 'bob@x.test')
  const net = browser(api)
  const name = fresh()
  const now = () => api.clock.now()

  net.jar.cookie = a.cookie
  const tabA = await tab(name, now)
  await tabA.setUser(a.userId)
  const { left, onAccountChanged } = leaving(tabA)
  const engineA = engineFor(tabA, { onAccountChanged })
  await engineA.pull()
  expect(tabA.hasData).toBe(true)

  const signInB = async () => {
    net.jar.cookie = b.cookie
    const tabB = await tab(name, now)
    await tabB.setUser(b.userId)
    await engineFor(tabB).pull()
    return tabB
  }
  return { a, b, net, name, now, tabA, engineA, left, signInB }
}

describe('tabs of one browser, against a real tela-api', () => {
  test("(b) the stale tab's subscribe is not applied to b, before the reload or after it", async () => {
    const api = await createTestApi()
    await addFeed(api.db, 1)
    await addFeed(api.db, 2)
    const { a, b, net, name, now, tabA, engineA, left, signInB } = await twoAccounts(api)
    await signInB()
    expect(await serverSubscriptions(api, b.userId)).toEqual([])

    // Tab A, still showing a's reading, subscribes to feed 2.
    const before = net.calls.length
    tabA.mutate({ type: 'subscribe', feedId: 2 })
    await tick()
    await left.forgotten
    expect(left.forgotten).not.toBeNull()
    await engineA.push()
    expect(net.calls.length).toBe(before) // stopped before its debounce: nothing went out

    // The reload, then the engine's start-up push: there is nothing of a's to push.
    const reloaded = await tab(name, now)
    expect(reloaded.userId).toBe(b.userId)
    expect(reloaded.unsent()).toEqual([])
    await engineFor(reloaded).push()
    expect(net.calls.length).toBe(before)
    expect(await serverSubscriptions(api, b.userId)).toEqual([])
    expect(await serverSubscriptions(api, a.userId)).toEqual([])
  })

  test('(c) opening a post in the stale tab does not mark it read for b', async () => {
    const api = await createTestApi()
    nextArticle = 1
    await addFeed(api.db, 1)
    const post = await addArticle(api, 1)
    const { name, now, tabA, engineA, left, signInB } = await twoAccounts(api)
    await signInB()

    // reading.tsx: opening an article reads it.
    tabA.mutate({ type: 'markRead', articleId: post })
    await tick()
    await left.forgotten
    await engineA.push()

    const reloaded = await tab(name, now)
    await engineFor(reloaded).push()

    const states = await api.db.all(sql`select user_id, article_id from user_article_states`)
    expect(states).toEqual([])
  })

  test("(d) a's pull, answered after b signs in, leaves b's copy b's", async () => {
    const api = await createTestApi()
    nextArticle = 1
    for (const n of [1, 2, 3]) await addFeed(api.db, n)
    const a = await signedIn(api, 'alice@x.test')
    const b = await signedIn(api, 'bob@x.test')
    expect((await pushAs(api, a, [{ type: 'subscribe', feedId: 1 }])).status).toBe(200)
    expect((await pushAs(api, b, [{ type: 'subscribe', feedId: 2 }])).status).toBe(200)
    const aArticles = [await addArticle(api, 1), await addArticle(api, 1)]
    const bArticles = [await addArticle(api, 2), await addArticle(api, 2)]
    await addArticle(api, 3)

    const net = browser(api)
    const name = fresh()
    const now = () => api.clock.now()

    // Tab A: a, synced.
    net.jar.cookie = a.cookie
    const tabA = await tab(name, now)
    await tabA.setUser(a.userId)
    const { left, onAccountChanged } = leaving(tabA)
    const engineA = engineFor(tabA, { onAccountChanged })
    await engineA.pull()
    expect([...tabA.getSnapshot().tables.articles.keys()].sort()).toEqual(aArticles)
    const aHandle = tabA.getSnapshot().tables.profile?.handle

    // a, on another device, subscribes to feed 3 and changes reading language.
    const later = [
      { type: 'subscribe', feedId: 3 },
      { type: 'setProfile', readingLang: 'zh-Hans' },
    ]
    expect((await pushAs(api, a, later)).status).toBe(200)

    // Tab A's pull goes out as a (session a); its answer is still on the wire ...
    let release = () => {}
    net.holdNext(
      (c) => c.path === '/api/v1/sync' && c.member === a.userId,
      new Promise<void>((r) => {
        release = r
      }),
    )
    const inFlight = engineA.pull()
    await new Promise((r) => setTimeout(r, 20)) // the request has reached the server as a

    // ... while tab B signs in as b and syncs b's snapshot.
    net.jar.cookie = b.cookie
    const tabB = await tab(name, now)
    await tabB.setUser(b.userId)
    await engineFor(tabB).pull()
    const bHandle = tabB.getSnapshot().tables.profile?.handle
    expect(bHandle).not.toBe(aHandle)

    // a's answer lands in tab A, which cannot write it: the copy is b's. Tab A leaves.
    release()
    await inFlight
    expect(left.forgotten).not.toBeNull()
    await left.forgotten

    // The reload, as b: b's own rows, and a pull as b carries on from them.
    const reloaded = await tab(name, now)
    expect(reloaded.userId).toBe(b.userId)
    const t = () => reloaded.getSnapshot().tables
    const ids = () => [...t().articles.keys()].sort((x, y) => x - y)
    const subs = () => [...t().subscriptions.keys()].sort()
    expect(subs()).toEqual([2])
    expect(t().profile?.handle).toBe(bHandle)
    expect(t().profile?.readingLang).toBeNull()
    expect(ids()).toEqual(bArticles)
    await engineFor(reloaded).pull()
    expect(net.calls.at(-1)?.member).toBe(b.userId)
    expect(subs()).toEqual([2])
    expect(ids()).toEqual(bArticles)
  })

  test("(e) an acknowledgement for a that lands after b signs in leaves none of a's note in b's view", async () => {
    const api = await createTestApi()
    nextArticle = 1
    await addFeed(api.db, 1)
    const post = await addArticle(api, 1)
    const { a, net, name, now, tabA, engineA, left, signInB } = await twoAccounts(api)

    // Tab A recommends the post, while it is still a's: stored as a's, pushed as a, applied.
    tabA.mutate({ type: 'recommend', articleId: post, note: 'for alice' })
    await tick()
    let release = () => {}
    net.holdNext(
      (c) => c.path === '/api/v1/mutations' && c.member === a.userId,
      new Promise<void>((r) => {
        release = r
      }),
    )
    const pushing = engineA.push()
    await new Promise((r) => setTimeout(r, 20))

    // The answer is on the wire while tab B signs in as b.
    const tabB = await signInB()
    release()
    await pushing
    expect(left.forgotten).not.toBeNull()
    await left.forgotten

    const reloaded = await tab(name, now)
    expect(reloaded.getSnapshot().tables.recommendations.get(post)).toBeUndefined()
    expect(reloaded.getSnapshot().pendingCount).toBe(0)
    expect(tabB.getSnapshot().tables.recommendations.get(post)).toBeUndefined()
  })

  test("(i) a stale tab's call outside sync names its own account, not the session's", async () => {
    const api = await createTestApi()
    const { a, net, tabA, signInB } = await twoAccounts(api)
    await signInB()
    bindApi({ member: () => tabA.userId, accountChanged() {}, upgrade() {} })
    await apiJson('/api/v1/profile', { method: 'PUT', body: { handle: 'alice2' } }).catch(
      () => undefined,
    )
    expect(net.calls.at(-1)).toEqual({ path: '/api/v1/profile', member: a.userId, mids: [] })
  })

  // Needs tela-api's half: from protocol 2 every member call must name the session's member.
  test.if(MIN_CLIENT >= 2)(
    "(i') tela-api refuses the stale tab's Settings save, the tab leaves, and b's profile is untouched",
    async () => {
      const api = await createTestApi()
      const { b, tabA, signInB } = await twoAccounts(api)
      await signInB()
      const profileOf = (userId: string) =>
        api.db.all(sql`select handle, display_name, bio from profiles where user_id = ${userId}`)
      const before = await profileOf(b.userId)
      let left = 0
      bindApi({ member: () => tabA.userId, accountChanged: () => void left++, upgrade() {} })
      const saving = apiJson('/api/v1/profile', {
        method: 'PUT',
        body: { handle: 'alice2', displayName: 'Alice', bio: 'a', publicSubscriptions: true },
      })
      await expect(saving).rejects.toBeInstanceOf(AccountChanged)
      expect(left).toBe(1)
      expect(await profileOf(b.userId)).toEqual(before)
    },
  )
})
