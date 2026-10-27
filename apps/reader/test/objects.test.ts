/**
 * The object store's requests: what the idle prefetch asks for is marked as such, so the spec
 * that counts a render's requests (e2e/local-first.e2e.ts) can leave it out; and each object is
 * downloaded once however many ask while it is on its way.
 */
import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { memoryPersistence } from '../src/store/db'
import {
  Objects,
  ObjectUnavailable,
  PostRefused,
  PREFETCH_HEADER,
  REFUSAL_FLOOR_MS,
  readRefusal,
} from '../src/store/objects'

const saved = globalThis.fetch
afterAll(() => {
  globalThis.fetch = saved
})

test('what the idle prefetch asks for says so, and what a page opens does not', async () => {
  const sent: string[] = []
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = String(input)
    const prefetch = new Headers(init?.headers).get(PREFETCH_HEADER) === '1'
    sent.push(`${prefetch ? 'prefetch' : 'page'} ${url}`)
    if (url.startsWith('/o/bundle')) return Response.json({ c1: { blocks: [] } })
    return Response.json({ blocks: [] })
  }) as unknown as typeof fetch
  const objects = new Objects(memoryPersistence())
  await objects.prefetch(['c1'])
  await objects.object('t/c2/en/x.json', undefined, true)
  await objects.object('t/c3/en/y.json')
  await objects.body('c4')
  expect(sent).toEqual([
    'prefetch /o/bundle?k=c1',
    'prefetch /o/t/c2/en/x.json',
    'page /o/t/c3/en/y.json',
    'page /o/c/c4.json',
  ])
})

/** A network that answers only when told to, and drops a request whose signal aborts. */
function network() {
  const sent: string[] = []
  const waiting = new Map<string, (res: Response) => void>()
  const failing = new Map<string, (error: Error) => void>()
  globalThis.fetch = ((input: string, init?: RequestInit) => {
    const url = String(input)
    const prefetch = new Headers(init?.headers).get(PREFETCH_HEADER) === '1'
    sent.push(`${prefetch ? 'prefetch' : 'page'} ${url}`)
    return new Promise<Response>((resolve, reject) => {
      waiting.set(url, resolve)
      failing.set(url, reject)
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })
  }) as unknown as typeof fetch
  return {
    sent,
    fail(url: string) {
      const reject = failing.get(url)
      if (!reject) throw new Error(`nothing asked for ${url}; asked: ${sent.join(', ')}`)
      failing.delete(url)
      waiting.delete(url)
      reject(new TypeError('Failed to fetch'))
    },
    answer(url: string, body: unknown, status = 200, headers: Record<string, string> = {}) {
      const resolve = waiting.get(url)
      if (!resolve) throw new Error(`nothing asked for ${url}; asked: ${sent.join(', ')}`)
      waiting.delete(url)
      resolve(Response.json(body, { status, headers }))
    },
  }
}

/** The promise, or a failure after `ms`: a request that never gives up would hang the run. */
function within<T>(promise: Promise<T>, ms = 1000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms),
    ),
  ])
}

/** Let promise chains run until `check` holds. */
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 0))
  expect(check()).toBe(true)
}

/** A persistence whose writes wait until released, as IndexedDB's can on a busy device. */
function slowWrites() {
  const base = memoryPersistence()
  let release = () => {}
  const gate = new Promise<void>((r) => {
    release = r
  })
  const writing: string[] = []
  return {
    writing,
    release: () => release(),
    persistence: {
      ...base,
      async putBody(body: Parameters<typeof base.putBody>[0]) {
        writing.push(body.key)
        await gate
        await base.putBody(body)
      },
      async putObject(object: Parameters<typeof base.putObject>[0]) {
        writing.push(object.key)
        await gate
        await base.putObject(object)
      },
    },
  }
}

describe('one download per object, however many ask while it is on its way', () => {
  test('two opens of one body make one request', async () => {
    const net = network()
    const objects = new Objects(memoryPersistence())
    const a = objects.body('k1')
    const b = objects.body('k1')
    await until(() => net.sent.length > 0)
    net.answer('/o/c/k1.json', { blocks: [] })
    expect(await a).toEqual({ blocks: [] } as never)
    expect(await b).toEqual({ blocks: [] } as never)
    expect(net.sent).toEqual(['page /o/c/k1.json'])
  })

  test('a body a prefetch bundle has brought is not fetched again while it is written', async () => {
    const net = network()
    const slow = slowWrites()
    const objects = new Objects(slow.persistence)
    const prefetched = objects.prefetch(['k1', 'k2'])
    await until(() => net.sent.length > 0)
    net.answer('/o/bundle?k=k1,k2', { k1: { blocks: [1] }, k2: { blocks: [2] } })
    await until(() => slow.writing.length > 0)
    // The bundle is here and being written: opening its second body asks nothing.
    expect(await objects.body('k2')).toEqual({ blocks: [2] } as never)
    slow.release()
    expect(await prefetched).toBe(2)
    expect(net.sent).toEqual(['prefetch /o/bundle?k=k1,k2'])
  })

  test('a bundle leaves out a body a page is already fetching', async () => {
    const net = network()
    const objects = new Objects(memoryPersistence())
    const opened = objects.body('k1')
    await until(() => net.sent.length === 1)
    const prefetched = objects.prefetch(['k1', 'k2'])
    await until(() => net.sent.length === 2)
    expect(net.sent).toEqual(['page /o/c/k1.json', 'prefetch /o/bundle?k=k2'])
    net.answer('/o/c/k1.json', { blocks: [] })
    net.answer('/o/bundle?k=k2', { k2: { blocks: [] } })
    await opened
    expect(await prefetched).toBe(1)
  })

  test('a page that gives up fails nobody else waiting, and the body is kept', async () => {
    const net = network()
    const persistence = memoryPersistence()
    const objects = new Objects(persistence)
    const left = new AbortController()
    const first = objects.body('k1', left.signal)
    const second = objects.body('k1')
    await until(() => net.sent.length > 0)
    left.abort()
    await expect(first).rejects.toBeDefined()
    net.answer('/o/c/k1.json', { blocks: [] })
    expect(await second).toEqual({ blocks: [] } as never)
    expect(net.sent).toEqual(['page /o/c/k1.json'])
    expect(await persistence.getBody('k1')).toBeTruthy()
  })

  test('a translation still being written is not fetched again', async () => {
    const net = network()
    const slow = slowWrites()
    const objects = new Objects(slow.persistence)
    const first = objects.object('t/c1/en/x.json')
    await until(() => net.sent.length > 0)
    net.answer('/o/t/c1/en/x.json', { blocks: ['a'] })
    await until(() => slow.writing.length > 0)
    // Closed and opened again while the first copy is being written.
    const again = objects.object('t/c1/en/x.json')
    slow.release()
    expect(await first).toEqual({ blocks: ['a'] })
    expect(await again).toEqual({ blocks: ['a'] })
    expect(net.sent).toEqual(['page /o/t/c1/en/x.json'])
  })

  test('a missing body is null for everyone waiting, and asked for again next time', async () => {
    const net = network()
    const objects = new Objects(memoryPersistence())
    const a = objects.body('k1')
    const b = objects.body('k1')
    await until(() => net.sent.length > 0)
    net.answer('/o/c/k1.json', { error: 'not_found' }, 404)
    expect(await a).toBeNull()
    expect(await b).toBeNull()
    const c = objects.body('k1')
    await until(() => net.sent.length === 2)
    net.answer('/o/c/k1.json', { blocks: [] })
    expect(await c).toEqual({ blocks: [] } as never)
  })

  test('a bundle that fails leaves its bodies missing, and the next prefetch asks for them', async () => {
    const net = network()
    const objects = new Objects(memoryPersistence())
    const first = objects.prefetch(['k1', 'k2'])
    await until(() => net.sent.length === 1)
    net.fail('/o/bundle?k=k1,k2')
    expect(await first).toBe(0)
    expect(await objects.missing(['k1', 'k2'])).toEqual(['k1', 'k2'])
    const second = objects.prefetch(['k1', 'k2'])
    await until(() => net.sent.length === 2)
    net.answer('/o/bundle?k=k1,k2', { k1: { blocks: [] }, k2: { blocks: [] } })
    expect(await second).toBe(2)
    expect(await objects.missing(['k1', 'k2'])).toEqual([])
  })

  test('a request that stalls gives up, and the next ask tries again', async () => {
    const net = network()
    const objects = new Objects(memoryPersistence(), Date.now, 20)
    await expect(within(objects.body('k1'))).rejects.toMatchObject({ name: 'TimeoutError' })
    const again = objects.body('k1')
    await until(() => net.sent.length === 2)
    net.answer('/o/c/k1.json', { blocks: [] })
    expect(await again).toEqual({ blocks: [] } as never)
  })

  test('a bundle that stalls ends the prefetch, its bodies still missing', async () => {
    network()
    const objects = new Objects(memoryPersistence(), Date.now, 20)
    expect(await within(objects.prefetch(['k1', 'k2']))).toBe(0)
    expect(await objects.missing(['k1', 'k2'])).toEqual(['k1', 'k2'])
  })
})

describe('a device that will not keep what the network brought', () => {
  const warned = spyOn(console, 'warn').mockImplementation(() => {})
  afterAll(() => warned.mockRestore())

  /** A persistence whose every IndexedDB request fails, as a full disk or a closed database does. */
  function refusing() {
    const base = memoryPersistence()
    const quota = () => Promise.reject(new DOMException('full', 'QuotaExceededError'))
    return {
      ...base,
      getBody: quota,
      putBody: quota,
      touchBody: quota,
      getObject: quota,
      putObject: quota,
      bodyKeys: quota,
    }
  }

  test('a body is shown though it could not be stored, and asked for again next time', async () => {
    const net = network()
    const objects = new Objects(refusing())
    const opened = objects.body('k1')
    await until(() => net.sent.length === 1)
    net.answer('/o/c/k1.json', { blocks: [1] })
    expect(await opened).toEqual({ blocks: [1] } as never)
    // Held in memory for going back and forth, though not on the device.
    expect(await objects.body('k1')).toEqual({ blocks: [1] } as never)
    expect(await objects.missing(['k1'])).toEqual(['k1'])
  })

  test('so is a translation', async () => {
    const net = network()
    const objects = new Objects(refusing())
    const opened = objects.object('t/c1/en/x.json')
    await until(() => net.sent.length === 1)
    net.answer('/o/t/c1/en/x.json', { blocks: ['a'] })
    expect(await opened).toEqual({ blocks: ['a'] })
  })
})

describe('what the edge answers', () => {
  test('only a 404 says there is no such body; any other refusal is a failure to try again', async () => {
    const net = network()
    const objects = new Objects(memoryPersistence())
    const failed = objects.body('k1')
    await until(() => net.sent.length === 1)
    net.answer('/o/c/k1.json', { error: 'upstream' }, 502)
    await expect(failed).rejects.toBeInstanceOf(ObjectUnavailable)
    await expect(failed).rejects.toMatchObject({ status: 502 })
    const again = objects.body('k1')
    await until(() => net.sent.length === 2)
    net.answer('/o/c/k1.json', { error: 'not_found' }, 404)
    expect(await again).toBeNull()
  })

  test('the same for a translation', async () => {
    const net = network()
    const objects = new Objects(memoryPersistence())
    const failed = objects.object('t/c1/en/x.json')
    await until(() => net.sent.length === 1)
    net.answer('/o/t/c1/en/x.json', { error: 'sign in first' }, 401)
    await expect(failed).rejects.toMatchObject({ name: 'ObjectUnavailable', status: 401 })
  })
})

test('a body eviction drops is missing again, and its next open asks the network', async () => {
  const net = network()
  let now = 0
  const objects = new Objects(memoryPersistence(), () => now)
  const opened = objects.body('k1')
  await until(() => net.sent.length === 1)
  net.answer('/o/c/k1.json', { blocks: [] })
  await opened
  expect(await objects.missing(['k1'])).toEqual([])
  now = 8 * 24 * 60 * 60 * 1000
  await objects.evict()
  expect(await objects.missing(['k1'])).toEqual(['k1'])
  const again = objects.body('k1')
  await until(() => net.sent.length === 2)
  net.answer('/o/c/k1.json', { blocks: [] })
  expect(await again).toEqual({ blocks: [] } as never)
})

describe('a post refused for the day’s limit on blogs the member does not follow (ADR 0066)', () => {
  const DAY = 86_400_000
  const START = 400 * DAY + 3_600_000
  const RESETS = 401 * DAY
  const refusal = { error: 'post_limit', limit: 100, resetsAt: RESETS }

  /** An object store on a clock the test moves, holding `member`'s account. */
  function store(member: { id: string | null } = { id: 'a' }) {
    const clock = { now: START }
    const objects = new Objects(
      memoryPersistence(),
      () => clock.now,
      1000,
      () => member.id,
    )
    return { objects, clock, member }
  }

  test('a bundle lists its refusals apart, and nothing asks for them again before the day turns', async () => {
    const net = network()
    const { objects, clock } = store()
    const first = objects.prefetch(['k1', 'k2'])
    await until(() => net.sent.length === 1)
    net.answer('/o/bundle?k=k1,k2', { objects: { k1: { blocks: [1] } }, refused: { k2: refusal } })
    expect(await first).toBe(1)
    expect(objects.refusal('k2')).toEqual({ limit: 100, resetsAt: RESETS, retryAt: RESETS })
    // Not missing, so the reading page's ask-again loop has nothing to ask for.
    expect(await objects.missing(['k1', 'k2'])).toEqual([])
    expect(await objects.prefetch(['k1', 'k2'])).toBe(0)
    // Opening it is refused at once, with what the page says.
    await expect(objects.body('k2')).rejects.toBeInstanceOf(PostRefused)
    await expect(objects.body('k2')).rejects.toMatchObject({
      status: 429,
      refusal: { limit: 100, resetsAt: RESETS },
    })
    // So is its translation.
    await expect(objects.object('t/k2/en/x.json')).rejects.toBeInstanceOf(PostRefused)
    expect(net.sent).toEqual(['prefetch /o/bundle?k=k1,k2'])
    // The day turns: it is missing again, and asked for alone.
    clock.now = RESETS
    expect(await objects.missing(['k1', 'k2'])).toEqual(['k2'])
    const again = objects.prefetch(['k1', 'k2'])
    await until(() => net.sent.length === 2)
    net.answer('/o/bundle?k=k2', { objects: { k2: { blocks: [2] } }, refused: {} })
    expect(await again).toBe(1)
    expect(await objects.missing(['k1', 'k2'])).toEqual([])
  })

  test('one object refused with a 429 is remembered, the body and its translations alike', async () => {
    const net = network()
    const { objects, clock } = store()
    const opened = objects.body('k1')
    await until(() => net.sent.length === 1)
    net.answer('/o/c/k1.json', refusal, 429, { 'retry-after': '3600' })
    await expect(opened).rejects.toMatchObject({
      name: 'PostRefused',
      refusal: { limit: 100, resetsAt: RESETS },
    })
    await expect(objects.body('k1')).rejects.toBeInstanceOf(PostRefused)
    expect(await objects.missing(['k1'])).toEqual([])
    expect(net.sent).toEqual(['page /o/c/k1.json'])
    // A translation refused for the day refuses its post's body too.
    const translated = objects.object('tc/k3/en/r/0.json')
    await until(() => net.sent.length === 2)
    net.answer('/o/tc/k3/en/r/0.json', refusal, 429)
    await expect(translated).rejects.toBeInstanceOf(PostRefused)
    await expect(objects.body('k3')).rejects.toBeInstanceOf(PostRefused)
    expect(net.sent).toHaveLength(2)
    clock.now = RESETS + 1
    const later = objects.body('k1')
    await until(() => net.sent.length === 3)
    net.answer('/o/c/k1.json', { blocks: [] })
    expect(await later).toEqual({ blocks: [] } as never)
  })

  test('a 429 for any other reason is a failure to try again, and remembers nothing', async () => {
    const net = network()
    const { objects } = store()
    const failed = objects.body('k1')
    await until(() => net.sent.length === 1)
    net.answer('/o/c/k1.json', { error: 'rate_limited' }, 429)
    await expect(failed).rejects.toMatchObject({ name: 'ObjectUnavailable', status: 429 })
    expect(objects.refusal('k1')).toBeNull()
    const again = objects.body('k1')
    await until(() => net.sent.length === 2)
    net.answer('/o/c/k1.json', { blocks: [] })
    expect(await again).toEqual({ blocks: [] } as never)
  })

  test('without resetsAt, Retry-After says when; and a reset already past waits a minute', () => {
    expect(readRefusal({ error: 'post_limit' }, START, '120')).toEqual({
      limit: null,
      resetsAt: START + 120_000,
      retryAt: START + 120_000,
    })
    // Neither: the next UTC midnight.
    expect(readRefusal({ error: 'post_limit', limit: 5 }, START)).toMatchObject({
      limit: 5,
      resetsAt: RESETS,
    })
    // A device clock ahead of the edge's would otherwise ask again at once, and again.
    expect(readRefusal({ ...refusal, resetsAt: START - 5000 }, START)).toEqual({
      limit: 100,
      resetsAt: START - 5000,
      retryAt: START + REFUSAL_FLOOR_MS,
    })
    expect(readRefusal({ error: 'rate_limited' }, START)).toBeNull()
    expect(readRefusal(null, START)).toBeNull()
  })

  test('a change to the subscriptions forgets every refusal; the first telling forgets none', async () => {
    const net = network()
    const { objects } = store()
    objects.noteSubscriptions('1:5')
    const opened = objects.body('k1')
    await until(() => net.sent.length === 1)
    net.answer('/o/c/k1.json', refusal, 429)
    await expect(opened).rejects.toBeInstanceOf(PostRefused)
    objects.noteSubscriptions('1:5')
    expect(objects.refusal('k1')).not.toBeNull()
    // Subscribed to the post's blog: asked for again, and given.
    objects.noteSubscriptions('1:5,2:0')
    expect(objects.refusal('k1')).toBeNull()
    const again = objects.body('k1')
    await until(() => net.sent.length === 2)
    net.answer('/o/c/k1.json', { blocks: [] })
    expect(await again).toEqual({ blocks: [] } as never)
  })

  test('subscribing from the refused post forgets the refusal it saw', async () => {
    const net = network()
    const { objects } = store()
    const opened = objects.body('k1')
    await until(() => net.sent.length === 1)
    net.answer('/o/c/k1.json', refusal, 429)
    await expect(opened).rejects.toBeInstanceOf(PostRefused)
    objects.forgetRefusals()
    const again = objects.body('k1')
    await until(() => net.sent.length === 2)
    net.answer('/o/c/k1.json', { blocks: [] })
    expect(await again).toEqual({ blocks: [] } as never)
  })

  test('a refusal is the account’s that asked, never the next one’s the tab holds', async () => {
    const net = network()
    const { objects, member } = store()
    const opened = objects.body('k1')
    await until(() => net.sent.length === 1)
    net.answer('/o/c/k1.json', refusal, 429)
    await expect(opened).rejects.toBeInstanceOf(PostRefused)
    member.id = 'b'
    expect(objects.refusal('k1')).toBeNull()
    // One that comes back after the tab moved on is not the new account's either.
    member.id = 'a'
    const asked = objects.body('k2')
    await until(() => net.sent.length === 2)
    member.id = 'b'
    net.answer('/o/c/k2.json', refusal, 429)
    await expect(asked).rejects.toBeInstanceOf(PostRefused)
    expect(objects.refusal('k2')).toBeNull()
  })

  test('a body the device holds is given, and a refusal for a key not asked for is not kept', async () => {
    const net = network()
    const persistence = memoryPersistence()
    await persistence.putBody({ key: 'k1', object: { blocks: [1] }, bytes: 10, lastOpened: 0 })
    const objects = new Objects(
      persistence,
      () => START,
      1000,
      () => 'a',
    )
    const bundle = objects.prefetch(['k2'])
    await until(() => net.sent.length === 1)
    net.answer('/o/bundle?k=k2', { objects: {}, refused: { k1: refusal, k2: refusal } })
    await bundle
    expect(objects.refusal('k1')).toBeNull()
    expect(await objects.body('k1')).toEqual({ blocks: [1] } as never)
    expect(objects.refusal('k2')).not.toBeNull()
  })

  test('a bundle refused whole for the day leaves every post in it waiting', async () => {
    const net = network()
    const { objects } = store()
    const bundle = objects.prefetch(['k1', 'k2'])
    await until(() => net.sent.length === 1)
    net.answer('/o/bundle?k=k1,k2', refusal, 429)
    expect(await bundle).toBe(0)
    expect(await objects.missing(['k1', 'k2'])).toEqual([])
  })
})
