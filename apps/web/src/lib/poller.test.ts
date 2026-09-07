import { describe, expect, test } from 'bun:test'
import { createPoller, type PollerTimer } from './poller'

/** A clock and a timer queue the test drives by hand. */
function harness() {
  let now = 0
  let nextId = 1
  let pending: { id: number; at: number; fn: () => void }[] = []
  const timer: PollerTimer = {
    set: (fn, ms) => {
      const id = nextId++
      pending.push({ id, at: now + ms, fn })
      return id
    },
    clear: (id) => {
      pending = pending.filter((p) => p.id !== id)
    },
  }
  return {
    timer,
    now: () => now,
    scheduled: () => pending.length,
    /** Run the next due timer and let the microtasks it starts settle. */
    fire: async () => {
      const next = pending.sort((a, b) => a.at - b.at).shift()
      if (!next) return false
      now = Math.max(now, next.at)
      next.fn()
      for (let i = 0; i < 20; i++) await Promise.resolve()
      return true
    },
    advance: (ms: number) => {
      now += ms
    },
  }
}

const OPTS = { startMs: 2000, maxIntervalMs: 30_000, maxMs: 180_000 }

describe('createPoller', () => {
  test('reads on a backing-off schedule and hands back control once', async () => {
    const h = harness()
    const answers = ['same', 'same', 'moved']
    let reads = 0
    let changed = 0
    const poller = createPoller({
      ...OPTS,
      revision: 'same',
      hidden: () => false,
      now: h.now,
      timer: h.timer,
      read: async () => answers[reads++] ?? null,
      onChanged: () => {
        changed++
      },
    })
    poller.start()
    await h.fire()
    await h.fire()
    await h.fire()
    expect(reads).toBe(3)
    expect(changed).toBe(1)
    // It stops on the change: nothing is left scheduled, and a later firing does nothing.
    expect(h.scheduled()).toBe(0)
    await h.fire()
    expect(reads).toBe(3)
  })

  test('keeps its window while hidden, and reads at once on return', async () => {
    const h = harness()
    let hidden = false
    let reads = 0
    const poller = createPoller({
      ...OPTS,
      revision: 'same',
      hidden: () => hidden,
      now: h.now,
      timer: h.timer,
      read: async () => {
        reads++
        return 'same'
      },
      onChanged: () => {},
    })
    poller.start()
    await h.fire()
    expect(reads).toBe(1)

    hidden = true
    poller.visibilityChanged()
    expect(h.scheduled()).toBe(0)
    // Far longer than the whole window, spent where nobody could see it.
    h.advance(10 * OPTS.maxMs)

    hidden = false
    poller.visibilityChanged()
    await h.fire()
    expect(reads).toBe(2)
    expect(h.scheduled()).toBe(1)
  })

  test('does not start a second loop when the tab returns mid-read', async () => {
    const h = harness()
    let hidden = false
    let reads = 0
    let release: (value: string) => void = () => {}
    const poller = createPoller({
      ...OPTS,
      revision: 'same',
      hidden: () => hidden,
      now: h.now,
      timer: h.timer,
      read: () => {
        reads++
        return new Promise<string>((resolve) => {
          release = resolve
        })
      },
      onChanged: () => {},
    })
    poller.start()
    await h.fire()
    expect(reads).toBe(1)
    expect(h.scheduled()).toBe(0)

    // Hidden and back again while that read is still outstanding.
    hidden = true
    poller.visibilityChanged()
    hidden = false
    poller.visibilityChanged()
    expect(reads).toBe(1)
    expect(h.scheduled()).toBe(0)

    release('same')
    for (let i = 0; i < 20; i++) await Promise.resolve()
    // Exactly one loop carried on: one timer, and one read when it fires.
    expect(h.scheduled()).toBe(1)
    await h.fire()
    expect(reads).toBe(2)
  })

  test('gives up once the window is spent', async () => {
    const h = harness()
    let reads = 0
    const poller = createPoller({
      ...OPTS,
      revision: 'same',
      hidden: () => false,
      now: h.now,
      timer: h.timer,
      read: async () => {
        reads++
        return 'same'
      },
      onChanged: () => {},
    })
    poller.start()
    while (await h.fire()) {
      if (reads > 50) break
    }
    expect(h.scheduled()).toBe(0)
    expect(h.now()).toBeGreaterThanOrEqual(OPTS.maxMs)
    expect(reads).toBeLessThan(50)
  })

  test('a read it cannot make is not a change', async () => {
    const h = harness()
    let changed = 0
    const poller = createPoller({
      ...OPTS,
      revision: 'same',
      hidden: () => false,
      now: h.now,
      timer: h.timer,
      read: async () => {
        throw new Error('offline')
      },
      onChanged: () => {
        changed++
      },
    })
    poller.start()
    await h.fire()
    await h.fire()
    expect(changed).toBe(0)
    expect(h.scheduled()).toBe(1)
  })
})
