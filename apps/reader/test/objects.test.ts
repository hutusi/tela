/**
 * The object store's requests: what the idle prefetch asks for is marked as such, so the spec
 * that counts a render's requests (e2e/local-first.e2e.ts) can leave it out; and each object is
 * downloaded once however many ask while it is on its way.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { memoryPersistence } from '../src/store/db'
import { Objects, PREFETCH_HEADER } from '../src/store/objects'

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
  globalThis.fetch = ((input: string, init?: RequestInit) => {
    const url = String(input)
    const prefetch = new Headers(init?.headers).get(PREFETCH_HEADER) === '1'
    sent.push(`${prefetch ? 'prefetch' : 'page'} ${url}`)
    return new Promise<Response>((resolve, reject) => {
      waiting.set(url, resolve)
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })
  }) as unknown as typeof fetch
  return {
    sent,
    answer(url: string, body: unknown, status = 200) {
      const resolve = waiting.get(url)
      if (!resolve) throw new Error(`nothing asked for ${url}; asked: ${sent.join(', ')}`)
      waiting.delete(url)
      resolve(Response.json(body, { status }))
    },
  }
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
})
