import 'fake-indexeddb/auto'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { leaver } from '../src/leave'
import {
  distrust,
  distrusted,
  forgetOnSignOut,
  initialStatus,
  learnWho,
  openStore,
  retryDelay,
  whenReachable,
  whoAmI,
} from '../src/session'
import {
  type EarlierBuild,
  earlierBuild,
  indexedDbPersistence,
  memoryPersistence,
  type Persistence,
} from '../src/store/db'
import { LocalStore } from '../src/store/local'
import { noEarlierBuild, seedEarlierBuild, signOutEarlierBuild } from './earlier-build'
import { NOW, profile, pull, sub } from './rows'

const saved = {
  sessionStorage: globalThis.sessionStorage,
  fetch: globalThis.fetch,
  window: globalThis.window,
  document: globalThis.document,
}
beforeAll(() => {
  const held = new Map<string, string>()
  Object.assign(globalThis, {
    sessionStorage: {
      getItem: (k: string) => held.get(k) ?? null,
      setItem: (k: string, v: string) => void held.set(k, v),
      removeItem: (k: string) => void held.delete(k),
    },
  })
})
afterAll(() => {
  Object.assign(globalThis, saved)
})

describe('a tab that left an account it could not forget', () => {
  test('does not trust that copy on its next boot, and only on that one', () => {
    distrust('a')
    // Another account's copy is not what it left.
    expect(distrusted('b')).toBe(false)
    distrust('a')
    expect(distrusted('a')).toBe(true)
    // Asked once: the boot after that trusts a copy again, so a lost record cannot lock it out.
    expect(distrusted('a')).toBe(false)
  })
})

/** A member's copy, on storage that may refuse to be forgotten. */
async function held(storage: Persistence) {
  const store = new LocalStore(storage, () => NOW)
  await store.open()
  await store.setUser('a')
  await store.applyPull(pull(5, { profile: [profile], subscriptions: [sub(1)] }, true), store.epoch)
  return store
}
const reopened = async (storage: Persistence) => {
  const store = new LocalStore(storage, () => NOW)
  await store.open()
  return store
}
/** A device where no earlier build has run. */
const none: EarlierBuild = {
  wrote: async () => false,
  empty: async () => null,
  seen: async () => {},
}

describe('leaving an account', () => {
  test('a tab whose storage will not forget boots asking who is signed in, and only once', async () => {
    const inner = memoryPersistence()
    const refusing: Persistence = { ...inner, release: () => Promise.reject(new Error('disk')) }
    const store = await held(refusing)
    const went: string[] = []
    await leaver({ stop() {}, store, go: (path) => void went.push(path) })()
    expect(went).toEqual(['/'])
    // The copy is still a's, and it must not be trusted: showing it would be refused again.
    const next = await reopened(refusing)
    expect(next.hasData).toBe(true)
    expect(initialStatus(next)).toBe('unknown')
    // The boot after that trusts a copy again, so a record left behind cannot lock the tab out.
    expect(initialStatus(await reopened(refusing))).toBe('member')
  })

  test('a tab that did forget boots as nobody, and leaves once however often it is told', async () => {
    const storage = memoryPersistence()
    const store = await held(storage)
    let stopped = 0
    const went: string[] = []
    const leave = leaver({ stop: () => void stopped++, store, go: (path) => void went.push(path) })
    await Promise.all([leave(), leave()])
    expect([stopped, went]).toEqual([1, ['/']])
    const next = await reopened(storage)
    expect(next.hasData).toBe(false)
    expect(initialStatus(next)).toBe('unknown')
  })
})

describe('booting after an earlier build ran on this device', () => {
  // The earlier build's database has one name on every device; start each case without it.
  beforeEach(() => noEarlierBuild('tela'))
  const copy = async () => {
    const storage = await indexedDbPersistence(`tela-test-${crypto.randomUUID()}`)
    await held(storage)
    return storage
  }
  const earlierSignsIn = () =>
    seedEarlierBuild('tela', pull(5, { profile: [profile], subscriptions: [sub(9)] }, true), {
      userId: 'b',
    })

  test('an earlier build that wrote its copy makes every tab and every boot ask first, until a claim', async () => {
    const storage = await copy()
    await earlierSignsIn()
    const first = await openStore(storage)
    expect(initialStatus(first)).toBe('unknown')
    // Another tab, or the next boot, before /me has answered: still not trusted.
    expect(initialStatus(await openStore(storage))).toBe('unknown')
    // /me answered, and its claim confirms whose the copy is.
    await first.setUser('a')
    expect(initialStatus(await openStore(storage))).toBe('member')
  })

  test("an earlier build's sign-out, which empties its copy, is seen too", async () => {
    const storage = await copy()
    await earlierSignsIn()
    const seen = await openStore(storage)
    await seen.setUser('a')
    // Nothing since: trusted again.
    expect(initialStatus(await openStore(storage))).toBe('member')
    // Then the member signs out in a tab of the earlier build: it clears its copy.
    await signOutEarlierBuild('tela')
    expect(initialStatus(await openStore(storage))).toBe('unknown')
  })

  test('a device where no earlier build ran boots on its copy at once', async () => {
    expect(initialStatus(await openStore(await copy()))).toBe('member')
  })

  test('tabs booting together all ask first, the ones that find its copy already emptied too', async () => {
    // Found in review: a tab that loaded before another's mark, and looked after that one had
    // emptied the earlier build's copy, trusted the copy.
    for (const tabs of [2, 3]) {
      const name = `tela-test-${crypto.randomUUID()}`
      await held(await indexedDbPersistence(name))
      await earlierSignsIn()
      const booted = await Promise.all(
        Array.from({ length: tabs }, async () => openStore(await indexedDbPersistence(name))),
      )
      expect(booted.map(initialStatus)).toEqual(Array(tabs).fill('unknown'))
    }
  })

  test("a tab that finds the earlier build's copy emptied by another loads after that tab's mark", async () => {
    const name = `tela-test-${crypto.randomUUID()}`
    await held(await indexedDbPersistence(name))
    // One earlier build's copy, which every tab looks at: written, until a tab empties it.
    let written = true
    const tabs: LocalStore[] = []
    const shared: EarlierBuild = {
      wrote: async () => written,
      empty: async () => {
        const was = written
        written = false
        // Another tab boots the moment the evidence is gone, before this one does anything more.
        tabs.push(await openStore(await indexedDbPersistence(name), shared))
        return was ? 'emptied' : null
      },
      seen: async () => {},
    }
    tabs.unshift(await openStore(await indexedDbPersistence(name), shared))
    expect(tabs.map(initialStatus)).toEqual(['unknown', 'unknown'])
  })

  test('a tab that started booting before the marks loads after them, though its look finds nothing', async () => {
    // Found in review: the concurrent boots above never have a tab whose look ends after another
    // tab emptied the copy, so loading first, then looking, passed them all.
    const name = `tela-test-${crypto.randomUUID()}`
    await held(await indexedDbPersistence(name))
    let written = true
    let emptied = () => {}
    const gone = new Promise<void>((r) => {
      emptied = r
    })
    const first: EarlierBuild = {
      wrote: async () => written,
      empty: async () => {
        const was = written
        written = false
        emptied()
        return was ? 'emptied' : null
      },
      seen: async () => {},
    }
    // This tab starts first, and its look answers only once the other tab has emptied the copy.
    const late: EarlierBuild = { ...first, wrote: () => gone.then(() => written) }
    const booting = openStore(await indexedDbPersistence(name), late)
    await new Promise((r) => setTimeout(r, 20))
    const other = await openStore(await indexedDbPersistence(name), first)
    expect([initialStatus(await booting), initialStatus(other)]).toEqual(['unknown', 'unknown'])
  })

  test("a tab that looks between another's emptying and its seen mark marks the copy itself", async () => {
    // Found in review: the emptied copy read as seen before the second mark was down. Another
    // tab's claim, on a /me answered before the sign-in the emptying erased, had cleared the
    // current mark meanwhile, so a tab booting in between trusted the copy.
    for (const stall of ['after emptying', 'after the seen mark'] as const) {
      const name = `tela-test-${crypto.randomUUID()}`
      const tab = () => indexedDbPersistence(name)
      await held(await tab())
      await earlierSignsIn()
      const between: LocalStore[] = []
      let claim = async () => {}
      const meanwhile = async () => {
        await claim()
        between.push(await openStore(await tab()))
      }
      const stalls: EarlierBuild = {
        ...earlierBuild,
        empty: async () => {
          // Before this tab empties: another tab boots all the way and asks /me, which says a;
          // then the earlier build signs in as someone else.
          const claimer = await openStore(await tab())
          const seen = await claimer.mark()
          claim = async () => void (await claimer.setUser('a', seen))
          await earlierSignsIn()
          const token = await earlierBuild.empty()
          if (stall === 'after emptying') await meanwhile()
          return token
        },
        seen: async (token) => {
          await earlierBuild.seen(token)
          if (stall === 'after the seen mark') await meanwhile()
        },
      }
      const booted = await openStore(await tab(), stalls)
      expect([stall, ...between.map(initialStatus)]).toEqual([stall, 'unknown'])
      expect(initialStatus(booted)).toBe('unknown')
    }
  })

  test('a tab that dies between emptying the copy and its second mark leaves it touched', async () => {
    const name = `tela-test-${crypto.randomUUID()}`
    await held(await indexedDbPersistence(name))
    await earlierSignsIn()
    const dies: EarlierBuild = {
      ...earlierBuild,
      empty: async () => {
        await earlierBuild.empty()
        throw new Error('the tab closed')
      },
    }
    await expect(openStore(await indexedDbPersistence(name), dies)).rejects.toThrow('closed')
    expect(await earlierBuild.wrote()).toBe(true)
    const next = await openStore(await indexedDbPersistence(name))
    expect(initialStatus(next)).toBe('unknown')
    await next.setUser('a')
    // Its claim cleared the marks; the copy it emptied, never seen, is looked at again.
    expect(await earlierBuild.wrote()).toBe(false)
    expect(initialStatus(await openStore(await indexedDbPersistence(name)))).toBe('member')
  })

  test('a browser without crypto.randomUUID (plain http) still boots, and asks first', async () => {
    const name = `tela-test-${crypto.randomUUID()}`
    await held(await indexedDbPersistence(name))
    await earlierSignsIn()
    const uuid = crypto.randomUUID
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true })
    try {
      const booted = await openStore(await indexedDbPersistence(name))
      expect(initialStatus(booted)).toBe('unknown')
      const memory = memoryPersistence()
      await memory.distrust()
      expect(await memory.mark()).not.toBeNull()
    } finally {
      Object.defineProperty(crypto, 'randomUUID', { value: uuid, configurable: true })
    }
    // Found in review: the highlight button still called it, and threw there. Every id the
    // reader makes comes from lib/id.ts.
    const src = join(import.meta.dir, '../src')
    const callers = readdirSync(src, { recursive: true })
      .map(String)
      .filter((f) => /\.tsx?$/.test(f) && f !== join('lib', 'id.ts'))
      .filter((f) => readFileSync(join(src, f), 'utf8').includes('crypto.randomUUID'))
    expect(callers).toEqual([])
  })

  test("a claim made while this tab empties the earlier build's copy leaves it asking first", async () => {
    const name = `tela-test-${crypto.randomUUID()}`
    await held(await indexedDbPersistence(name))
    const tab = () => indexedDbPersistence(name)
    const others: LocalStore[] = []
    // Between this tab's look and its emptying, another tab loads the marked copy and claims it
    // on a /me asked before whatever the emptying is about to erase (a sign-out there).
    const earlier: EarlierBuild = {
      wrote: async () => true,
      empty: async () => {
        const other = await openStore(await tab(), none)
        others.push(other)
        await other.setUser('a')
        return 'emptied'
      },
      seen: async () => {},
    }
    const booted = await openStore(await tab(), earlier)
    expect(initialStatus(booted)).toBe('unknown')
    // The other tab's claim acted on the mark it loaded, not the one this tab put down since.
    for (const other of others) await other.setUser('a')
    expect(initialStatus(await openStore(await tab(), none))).toBe('unknown')
    // This tab's own claim, after its /me, is what confirms the copy.
    await booted.setUser('a')
    expect(initialStatus(await openStore(await tab(), none))).toBe('member')
  })
})

describe('the session ending', () => {
  test('a copy the tab could not forget is not trusted at the next boot', async () => {
    const inner = memoryPersistence()
    const refusing: Persistence = { ...inner, release: () => Promise.reject(new Error('disk')) }
    const store = await held(refusing)
    await forgetOnSignOut(store)
    expect(initialStatus(await reopened(refusing))).toBe('unknown')
  })
})

describe('asking /me who is signed in', () => {
  /** tela-api answering /me with `answer`. */
  const me = (answer: () => Response | Promise<Response>) => {
    globalThis.fetch = (async () => answer()) as unknown as typeof fetch
  }
  /** A member's copy with one unsent change, marked as an earlier build having run. */
  async function doubted() {
    const storage = memoryPersistence()
    const store = await held(storage)
    store.mutate({ type: 'markRead', articleId: 1 })
    await new Promise((r) => setTimeout(r, 0))
    await storage.distrust()
    const booted = await reopened(storage)
    expect(initialStatus(booted)).toBe('unknown')
    return { storage, store: booted }
  }
  const kept = async (storage: Persistence) => {
    const stored = await storage.load()
    expect(stored.owner).toBe('a')
    expect(stored.rows).not.toBeNull()
    expect(stored.pending).toHaveLength(1)
    expect(stored.unverified).not.toBeNull()
  }

  test('an answer that is not a 401 is no sign-out: the copy and its unsent change stay', async () => {
    // Found in review: a 5xx mid-deploy read as nobody wiped both, and sent the tab to /login.
    const answers: [string, () => Response | Promise<Response>][] = [
      ['a 503 mid-deploy', () => new Response('deploying', { status: 503 })],
      ['a WAF challenge', () => new Response('<html>', { status: 403 })],
      ['a captive portal', () => new Response('<html>sign in to the wifi</html>', { status: 511 })],
      ['a page that is not /me', () => new Response('<html>sign in to the wifi</html>')],
      ['no network', () => Promise.reject(new TypeError('Failed to fetch'))],
      ['no one named', () => Response.json({})],
      // A /me-shaped body behind a status that is not OK (a proxy replaying a cached answer): it
      // is the status that says nothing, whatever the body.
      ['an old answer at 503', () => Response.json({ id: 'b' }, { status: 503 })],
    ]
    for (const [, answer] of answers) {
      const { storage, store } = await doubted()
      me(answer)
      expect(await learnWho(store, () => true)).toBe('unreachable')
      expect(store.userId).toBe('a')
      await kept(storage)
    }
  })

  test('a 401 says nobody: the copy is forgotten', async () => {
    const { storage, store } = await doubted()
    me(() => Response.json({ error: 'unauthorized' }, { status: 401 }))
    expect(await learnWho(store, () => true)).toBe('guest')
    expect((await storage.load()).owner).toBeNull()
  })

  test("the member's id claims the copy, and the claim clears the mark", async () => {
    const { storage, store } = await doubted()
    me(() => Response.json({ id: 'a' }))
    expect(await learnWho(store, () => true)).toBe('member')
    expect(initialStatus(await reopened(storage))).toBe('member')
    expect((await storage.load()).pending).toHaveLength(1)
  })

  test('a claim clears a mark put down before its question left, and not one put down while it was out', async () => {
    // Found in review: a tab that loaded before any mark (a login tab left open) signed in, and
    // its claim left the mark another tab had put down since, so the next boot waited on /me.
    const storage = memoryPersistence()
    const store = await held(storage)
    await storage.distrust()
    let meanwhile = async () => {}
    me(async () => {
      await meanwhile()
      return Response.json({ id: 'a' })
    })
    expect(await learnWho(store, () => true)).toBe('member')
    expect(initialStatus(await reopened(storage))).toBe('member')
    // Another tab marks the copy while this question is out: its answer may predate whatever
    // that mark is about.
    await storage.distrust()
    meanwhile = () => storage.distrust()
    const later = await reopened(storage)
    expect(await learnWho(later, () => true)).toBe('member')
    expect(initialStatus(await reopened(storage))).toBe('unknown')
  })

  test('a /me that never answers counts as a miss once its deadline passes', async () => {
    // Found in review: a question held open for ever left nothing asking again.
    const { storage, store } = await doubted()
    globalThis.fetch = ((_: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })) as unknown as typeof fetch
    expect(
      await learnWho(
        store,
        () => true,
        () => whoAmI(20),
      ),
    ).toBe('unreachable')
    await kept(storage)
  })

  test('a claim the device refuses is asked again, not left hanging', async () => {
    const inner = memoryPersistence()
    const refusing: Persistence = { ...inner, claim: () => Promise.reject(new Error('disk')) }
    const store = await reopened(refusing)
    me(() => Response.json({ id: 'a' }))
    expect(await learnWho(store, () => true)).toBe('unreachable')
  })

  test('an answer a later question has overtaken changes nothing', async () => {
    const { storage, store } = await doubted()
    me(() => Response.json({ error: 'unauthorized' }, { status: 401 }))
    expect(await learnWho(store, () => false)).toBeNull()
    await kept(storage)
    me(() => new Response('deploying', { status: 503 }))
    expect(await learnWho(store, () => false)).toBeNull()
  })
})

describe('asking again once /me may answer', () => {
  /** The window and document a tab has, as far as the retry listens. */
  function tab() {
    const win = new EventTarget()
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' })
    Object.assign(globalThis, { window: win, document: doc })
    return { win, doc }
  }
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

  test('waits longer after each miss, up to two minutes', () => {
    expect([1, 2, 3, 4].map(retryDelay)).toEqual([2000, 4000, 8000, 16_000])
    expect(retryDelay(20)).toBe(120_000)
  })

  test('asks once, when the time is up', async () => {
    tab()
    let asked = 0
    whenReachable(() => void asked++, 5)
    await wait(20)
    expect(asked).toBe(1)
  })

  test('asks at once when the browser comes back online, and only once', async () => {
    const { win } = tab()
    let asked = 0
    whenReachable(() => void asked++, 60_000)
    win.dispatchEvent(new Event('online'))
    win.dispatchEvent(new Event('online'))
    expect(asked).toBe(1)
  })

  test('asks when the tab comes into view, not when it goes out of it', () => {
    const { doc } = tab()
    let asked = 0
    whenReachable(() => void asked++, 60_000)
    doc.visibilityState = 'hidden'
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(asked).toBe(0)
    doc.visibilityState = 'visible'
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(asked).toBe(1)
  })

  test('cancelled, it never asks', async () => {
    const { win } = tab()
    let asked = 0
    const stop = whenReachable(() => void asked++, 5)
    stop()
    win.dispatchEvent(new Event('online'))
    await wait(20)
    expect(asked).toBe(0)
  })
})
