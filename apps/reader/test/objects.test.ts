/**
 * The object store's requests: what the idle prefetch asks for is marked as such, so the spec
 * that counts a render's requests (e2e/local-first.e2e.ts) can leave it out.
 */
import { afterAll, expect, test } from 'bun:test'
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
