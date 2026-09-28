import { describe, expect, test } from 'bun:test'
import type { LookupAddress } from 'node:dns'
import { BlockedAddressError, createVettedLookup } from '../src/safe-fetch'

type Outcome = {
  err: NodeJS.ErrnoException | null
  address: string | LookupAddress[]
  family: number | undefined
}

function run(
  lookup: ReturnType<typeof createVettedLookup>,
  hostname: string,
  all = false,
): Promise<Outcome> {
  return new Promise((resolve) => {
    lookup(hostname, { all } as never, (err, address, family) =>
      resolve({ err, address: address as string | LookupAddress[], family }),
    )
  })
}

const table: Record<string, LookupAddress[]> = {
  'localtest.me': [{ address: '127.0.0.1', family: 4 }],
  'mixed.example': [
    { address: '93.184.216.34', family: 4 },
    { address: 'fdaa:0:1::3', family: 6 },
  ],
  'blog.example': [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:4700::1111', family: 6 },
  ],
  'mapped.example': [{ address: '::ffff:169.254.169.254', family: 6 }],
  'nowhere.example': [],
}
const resolve = async (hostname: string) => table[hostname] ?? []

describe('createVettedLookup', () => {
  test('refuses a name when any resolved address is private', async () => {
    const lookup = createVettedLookup({ resolve })
    for (const host of ['localtest.me', 'mixed.example', 'mapped.example']) {
      const out = await run(lookup, host)
      expect(out.err).toBeInstanceOf(BlockedAddressError)
      expect((out.err as NodeJS.ErrnoException).code).toBe('EBLOCKED')
    }
  })

  test('hands public addresses to the socket in both callback shapes', async () => {
    const lookup = createVettedLookup({ resolve })
    expect(await run(lookup, 'blog.example')).toEqual({
      err: null,
      address: '93.184.216.34',
      family: 4,
    })
    const all = await run(lookup, 'blog.example', true)
    expect(all.err).toBeNull()
    expect(all.address).toEqual(table['blog.example'] as LookupAddress[])
  })

  test('reports unknown names as ENOTFOUND and honours the test escape hatch', async () => {
    expect((await run(createVettedLookup({ resolve }), 'nowhere.example')).err?.code).toBe(
      'ENOTFOUND',
    )
    const permissive = createVettedLookup({ resolve, allowPrivateHosts: true })
    expect((await run(permissive, 'localtest.me')).address).toBe('127.0.0.1')
  })
})
