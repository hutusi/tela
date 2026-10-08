/**
 * Leaving an account while a sign-in in this tab holds the tab's leaving (ADR 0043): the
 * account_changed its own new cookie draws is kept until it has settled the tab, then made or
 * dropped (`holdLeaving` in `src/leave.ts`).
 */
import { describe, expect, test } from 'bun:test'
import { holdLeaving, leaver } from '../src/leave'

function tab() {
  const went: string[] = []
  const forgot: string[] = []
  const store = {
    userId: 'old-member' as string | null,
    forgetAccount: async () => {
      forgot.push('old-member')
    },
  }
  const leave = leaver({ stop() {}, store, go: (path) => void went.push(path) })
  return { leave, went, forgot }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('a leave while a sign-in holds the tab', () => {
  test('is not made; released to replay, it is made then', async () => {
    const { leave, went, forgot } = tab()
    const release = holdLeaving()
    await leave()
    await settle()
    expect(went).toEqual([])
    expect(forgot).toEqual([])

    release(true)
    await settle()
    expect(forgot).toEqual(['old-member'])
    expect(went).toEqual(['/'])
  })

  test('is dropped when the sign-in loaded a fresh page itself, and the next one is made', async () => {
    const { leave, went } = tab()
    const release = holdLeaving()
    await leave()
    release(false)
    await settle()
    expect(went).toEqual([])

    // Another tab's sign-in, later, is news again.
    await leave()
    await settle()
    expect(went).toEqual(['/'])
  })

  test('waits for the last of two holds, and a second release changes nothing', async () => {
    const { leave, went } = tab()
    const first = holdLeaving()
    const second = holdLeaving()
    await leave()
    first(true)
    first(true)
    await settle()
    expect(went).toEqual([])
    second(true)
    await settle()
    expect(went).toEqual(['/'])
  })

  test('with nothing held, is made at once', async () => {
    const { leave, went } = tab()
    holdLeaving()(true)
    await leave()
    expect(went).toEqual(['/'])
  })
})
