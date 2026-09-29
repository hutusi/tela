/** The device database itself, on an in-memory IndexedDB: what two tabs and an upgrade do to it. */
import 'fake-indexeddb/auto'
import { describe, expect, test } from 'bun:test'
import type { Pending } from '@tela/sync'
import { openDB } from 'idb'
import { indexedDbPersistence } from '../src/store/db'

const change = (mid: string, at: number, articleId: number) =>
  ({ mutation: { mid, at, type: 'markRead', articleId } }) as Pending
const mids = (pending: Pending[]) => pending.map((p) => p.mutation.mid)
const fresh = () => `tela-test-${crypto.randomUUID()}`

describe('the device database', () => {
  test('each unsent change is a record of its own, so two tabs never erase each other', async () => {
    const name = fresh()
    const one = await indexedDbPersistence(name)
    const two = await indexedDbPersistence(name)
    await one.savePending([change('mid-one-0001', 1, 7)])
    await two.savePending([change('mid-two-0001', 2, 8)])
    expect(mids((await one.load()).pending)).toEqual(['mid-one-0001', 'mid-two-0001'])
    await two.dropPending(['mid-two-0001'])
    expect(mids((await one.load()).pending)).toEqual(['mid-one-0001'])
  })

  test('a device the last build wrote keeps the changes it had queued', async () => {
    const name = fresh()
    // The last build's layout: the whole list in one `pending` record.
    const old = await openDB(name, 1, {
      upgrade(d) {
        d.createObjectStore('meta')
        d.createObjectStore('tables')
        d.createObjectStore('bodies', { keyPath: 'key' }).createIndex('lastOpened', 'lastOpened')
        d.createObjectStore('objects', { keyPath: 'key' })
      },
    })
    await old.put('meta', [change('mid-old-0002', 2, 8), change('mid-old-0001', 1, 7)], 'pending')
    old.close()

    const now = await indexedDbPersistence(name)
    expect(mids((await now.load()).pending)).toEqual(['mid-old-0001', 'mid-old-0002'])
    // Moved into records of their own, not copied: dropping one drops it for good.
    await now.dropPending(['mid-old-0001'])
    expect(mids((await now.load()).pending)).toEqual(['mid-old-0002'])
  })
})
