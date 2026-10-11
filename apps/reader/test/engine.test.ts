/**
 * The sync engine and the device store across tabs: one browser, one session cookie, and a tab
 * that may still hold the account another tab has just signed out of.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { memoryPersistence } from '../src/store/db'
import { type EngineEvents, SyncEngine } from '../src/store/engine'
import { LocalStore, type Stamp, type Timers } from '../src/store/local'
import { NOW, profile, pull, sub } from './rows'

const saved = { fetch: globalThis.fetch, document: globalThis.document, window: globalThis.window }
const listeners = { addEventListener() {}, removeEventListener() {} }
const noop = { removeEventListener() {} }
beforeAll(() => {
  // Only the listener calls the engine makes when it starts and stops.
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
})
const quiet: EngineEvents = { onSignedOut() {}, onUpgrade() {}, onAccountChanged() {} }
const engineFor = (store: LocalStore, events: Partial<EngineEvents> = {}) => {
  const e = new SyncEngine(store, { ...quiet, ...events })
  engines.push(e)
  return e
}

/** A fake tela-api that answers every call with `answer` and records what it was sent. */
function server(answer: () => Response | Promise<Response>) {
  const calls: { path: string; member: string | null }[] = []
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    calls.push({ path: String(input), member: headers.get('x-tela-member') })
    return answer()
  }) as typeof fetch
  return calls
}

const tick = () => new Promise((r) => setTimeout(r, 0))
const snapshot = pull(5, { profile: [profile], subscriptions: [sub(1)] }, true)

async function member(storage = memoryPersistence(), id = 'a', timers?: Timers) {
  const store = new LocalStore(storage, () => NOW, timers)
  await store.open()
  await store.setUser(id)
  await store.applyPull(snapshot, store.epoch)
  return store
}

describe('another tab signing in as someone else', () => {
  test('every sync call names whose rows the device holds', async () => {
    const store = await member()
    const calls = server(() => Response.json({ applied: [], rejected: [], seq: 5 }))
    const engine = engineFor(store)
    store.mutate({ type: 'markRead', articleId: 1 })
    await engine.push()
    expect(calls.map((c) => c.member)).toEqual(['a', 'a'])
    expect(calls.map((c) => c.path.split('?')[0])).toEqual(['/api/v1/mutations', '/api/v1/sync'])
  })

  test('a refusal stops syncing and says so, and the change is not taken as sent', async () => {
    const store = await member()
    server(() => Response.json({ error: 'account_changed' }, { status: 409 }))
    let changed = 0
    const engine = engineFor(store, { onAccountChanged: () => void changed++ })
    store.mutate({ type: 'markRead', articleId: 1 })
    await engine.push()
    expect(changed).toBe(1)
    expect(store.unsent()).toHaveLength(1)
  })

  test("the stale tab forgets its account, and leaves the new account's stored copy alone", async () => {
    const storage = memoryPersistence()
    const stale = await member(storage)

    // The other tab signs in as b: its store replaces a's stored copy with b's.
    await member(storage, 'b')

    await stale.forgetAccount()
    expect(stale.hasData).toBe(false)
    expect(stale.userId).toBeNull()
    const kept = await storage.load()
    expect(kept.owner).toBe('b')
    expect(kept.rows).not.toBeNull()

    // Had nobody replaced it, a's stored copy goes as well.
    const alone = memoryPersistence()
    const only = await member(alone)
    await only.forgetAccount()
    const gone = await alone.load()
    expect(gone.owner).toBeNull()
    expect(gone.rows).toBeNull()
  })

  test('a pull sent as a and answered after this tab signs in as b is dropped', async () => {
    const storage = memoryPersistence()
    const store = new LocalStore(storage, () => NOW)
    await store.open()
    await store.setUser('a')
    let answer: (res: Response) => void = () => {}
    const calls = server(
      () =>
        new Promise<Response>((r) => {
          answer = r
        }),
    )
    const pulling = engineFor(store).pull()
    await tick()
    expect(calls.map((c) => c.member)).toEqual(['a'])

    // The mail's link for b, opened in this very tab.
    await store.setUser('b')
    answer(Response.json(snapshot)) // a's rows: a's subscription, a's cursor
    await pulling

    expect(store.getSnapshot().tables.subscriptions.has(1)).toBe(false)
    expect(store.getSnapshot().tables.profile).toBeNull()
    expect(store.cursor).toBe(0)
    const stored = await storage.load()
    expect(stored.owner).toBe('b')
    expect(stored.rows).toBeNull()
  })

  test('a write refused by the database stops the engine and asks to leave once', async () => {
    const storage = memoryPersistence()
    const store = await member(storage)
    const calls = server(() => Response.json({ applied: [], rejected: [], seq: 5 }))
    let changed = 0
    const engine = engineFor(store, { onAccountChanged: () => void changed++ })

    // Another tab claims the copy for b; this one does not know yet.
    await member(storage, 'b')
    store.mutate({ type: 'markRead', articleId: 1 })
    store.mutate({ type: 'markRead', articleId: 2 })
    await tick()
    expect(changed).toBe(1)

    // Stopped: nothing it holds goes out, now or after the push debounce.
    engine.schedulePush()
    await engine.push()
    await new Promise((r) => setTimeout(r, 300))
    expect(calls).toEqual([])
    expect(changed).toBe(1)
    expect((await storage.load()).pending).toEqual([])
  })

  test('an account_changed for an account this tab has since left is only late', async () => {
    const store = await member()
    let answer: (res: Response) => void = () => {}
    server(
      () =>
        new Promise<Response>((r) => {
          answer = r
        }),
    )
    let changed = 0
    const engine = engineFor(store, { onAccountChanged: () => void changed++ })
    const pulling = engine.pull()
    await tick()
    // This tab signs in as b while a's pull is out; the answer says the session is not a's.
    await store.setUser('b')
    answer(Response.json({ error: 'account_changed' }, { status: 409 }))
    await pulling
    expect(changed).toBe(0)

    // Still running, and now for b.
    const calls = server(() => Response.json(pull(8, {}, true)))
    await engine.pull()
    expect(calls.map((c) => c.member)).toEqual(['b'])
  })

  test('start() without an owner does nothing', async () => {
    const store = new LocalStore(memoryPersistence(), () => NOW)
    await store.open()
    const calls = server(() => Response.json(snapshot))
    engineFor(store).start()
    await tick()
    expect(calls).toEqual([])
  })
})

/** A change the store made: a test that holds an account always gets one. */
function made(stamp: Stamp | null): Stamp {
  if (!stamp) throw new Error('no change was made')
  return stamp
}

describe('a change held back for an Undo', () => {
  /** Timers that never run by themselves: only letting go ends a hold here. */
  const never: Timers = { set: () => 0, clear() {} }
  const hold = { holdMs: 5000 }

  test('leaving the page lets it go first, so the request that outlives the page carries it', async () => {
    const store = await member(memoryPersistence(), 'a', never)
    const sent: { path: string; keepalive: boolean; mids: string[] }[] = []
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
      const mids: string[] = (body?.mutations ?? []).map((m: { mid: string }) => m.mid)
      sent.push({ path: String(input).split('?')[0] ?? '', keepalive: !!init?.keepalive, mids })
      return mids.length > 0
        ? Response.json({ applied: mids, rejected: [], seq: 6 })
        : Response.json(pull(6, {}))
    }) as typeof fetch
    // The engine's own pagehide listener, as the browser would call it.
    const heard = new Map<string, () => void>()
    Object.assign(globalThis, {
      window: { addEventListener: (type: string, f: () => void) => heard.set(type, f), ...noop },
    })
    try {
      const engine = engineFor(store)
      engine.start()
      await tick()
      const before = made(store.mutate({ type: 'markRead', articleId: 1 }))
      const held = made(store.mutate({ type: 'markAllRead', upTo: 9 }, hold))
      const after = made(store.mutate({ type: 'subscribe', feedId: 2 }))
      expect(store.unsent().map((m) => m.mid)).toEqual([before.mid])

      heard.get('pagehide')?.()
      await tick()
      const pushes = sent.filter((c) => c.path === '/api/v1/mutations')
      expect(pushes).toEqual([
        {
          path: '/api/v1/mutations',
          keepalive: true,
          mids: [before.mid, held.mid, after.mid],
        },
      ])
      expect(store.retract(held.mid)).toBe(false)
    } finally {
      Object.assign(globalThis, { window: listeners })
    }
  })

  test('signing out sends it first, with what it held back, and waits for the answer', async () => {
    const storage = memoryPersistence()
    const store = await member(storage, 'a', never)
    const sent: string[][] = []
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      // The pull after the first push.
      if (!String(input).startsWith('/api/v1/mutations')) return Response.json(pull(6, {}))
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
      const mids: string[] = (body?.mutations ?? []).map((m: { mid: string }) => m.mid)
      sent.push(mids)
      await tick()
      return Response.json({ applied: mids, rejected: [], seq: 6 })
    }) as typeof fetch
    const engine = engineFor(store)
    const before = made(store.mutate({ type: 'markRead', articleId: 1 }))
    // One push already on its way when the member signs out: the flush waits for it, then sends
    // the rest.
    const pushing = engine.push()
    const held = made(store.mutate({ type: 'markAllRead', upTo: 9 }, hold))
    const after = made(store.mutate({ type: 'subscribe', feedId: 2 }))
    await engine.flush(3000)
    expect(sent).toEqual([[before.mid], [held.mid, after.mid]])
    expect(store.unsent()).toEqual([])
    expect(store.retract(held.mid)).toBe(false)
    await pushing
  })

  test('signing out sends the whole queue, a push of 50 at a time', async () => {
    const store = await member(memoryPersistence(), 'a', never)
    const sent: number[] = []
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (!String(input).startsWith('/api/v1/mutations')) return Response.json(pull(6, {}))
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
      const mids: string[] = (body?.mutations ?? []).map((m: { mid: string }) => m.mid)
      sent.push(mids.length)
      return Response.json({ applied: mids, rejected: [], seq: 6 })
    }) as typeof fetch
    const engine = engineFor(store)
    for (let id = 1; id <= 120; id++) store.mutate({ type: 'markRead', articleId: id })
    await engine.flush(3000)
    expect(sent).toEqual([50, 50, 20])
    expect(store.unsent(Number.POSITIVE_INFINITY)).toEqual([])
  })

  test('signing out offline waits no longer than it was given', async () => {
    const store = await member(memoryPersistence(), 'a', never)
    // A request that never comes back.
    server(() => new Promise<Response>(() => {}))
    const engine = engineFor(store)
    const held = made(store.mutate({ type: 'markAllRead', upTo: 9 }, hold))
    const started = Date.now()
    await engine.flush(50)
    expect(Date.now() - started).toBeLessThan(1000)
    // Let go, and stored: unsent, but nothing is lost before the account is forgotten.
    expect(store.unsent().map((m) => m.mid)).toEqual([held.mid])
  })

  test("signing out, a push told of another account's session leaves as it always did", async () => {
    const store = await member(memoryPersistence(), 'a', never)
    server(() => Response.json({ error: 'account_changed' }, { status: 409 }))
    let changed = 0
    const engine = engineFor(store, { onAccountChanged: () => void changed++ })
    store.mutate({ type: 'markAllRead', upTo: 9 }, hold)
    await engine.flush(3000)
    expect(changed).toBe(1)

    // Stopped already: a second flush sends nothing.
    const calls = server(() => Response.json({ applied: [], rejected: [], seq: 5 }))
    await engine.flush(3000)
    expect(calls).toEqual([])
  })

  test('stopping stores it, sends nothing, and leaves nothing on a timer', async () => {
    const storage = memoryPersistence()
    let timers = 0
    const counted: Timers = {
      set: () => ++timers,
      clear: () => void timers--,
    }
    const store = await member(storage, 'a', counted)
    const calls = server(() => Response.json({ applied: [], rejected: [], seq: 5 }))
    const engine = engineFor(store)
    const held = made(store.mutate({ type: 'markAllRead', upTo: 9 }, hold))
    expect(timers).toBe(1)
    engine.stop()
    await new Promise((r) => setTimeout(r, 300))
    expect(timers).toBe(0)
    expect(calls).toEqual([])
    expect((await storage.load()).pending.map((p) => p.mutation.mid)).toEqual([held.mid])
  })
})
