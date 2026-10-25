/**
 * An account in good standing is the only kind anything public shows (ADRs 0058, 0059): a
 * suspended member and a closed account leave the profile page, Discover's readers and blogrolls,
 * the notes beside a blog's posts and Discover's, a blog's claimant, the front page, the follower
 * counts, a picture's address, the Following feed and a follower's device, by one predicate
 * (`standingOk`). Their handle stays taken, and nobody can follow them.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { currentSeq } from '@tela/data'
import { sql } from 'drizzle-orm'
import { createTestApi, type SignedIn, signedIn, type TestApi } from './helpers'
import { ANNA, annaInPublic, BEA, HIDDEN, pullOf, SHOWN, seedAnna, write } from './standing-fixture'

let api: TestApi
let reader: SignedIn

beforeEach(async () => {
  api = await createTestApi()
  reader = await signedIn(api, 'reader@x.test')
  await seedAnna(api, reader)
})

const leave = (column: 'suspended_at' | 'deleted_at', userId = ANNA) =>
  write(
    api.db,
    api.db.run(sql`update profiles set ${sql.raw(column)} = ${api.clock.now()},
      seq = ${currentSeq} where user_id = ${userId}`),
  )

describe('a member not in good standing', () => {
  test.each(['suspended_at', 'deleted_at'] as const)(
    'is on no public answer once %s is set, and is back once it is cleared',
    async (column) => {
      expect(await annaInPublic(api)).toEqual(SHOWN)
      await leave(column)
      expect(await annaInPublic(api)).toEqual(HIDDEN)
      await write(api.db, api.db.run(sql`update profiles set ${sql.raw(column)} = null`))
      expect(await annaInPublic(api)).toEqual(SHOWN)
    },
  )

  test('is counted out of the follows of the people they followed and who followed them', async () => {
    const handle = (
      await api.db.all<{ handle: string }>(
        sql`select handle from profiles where user_id = ${reader.userId}`,
      )
    )[0]?.handle
    await write(
      api.db,
      api.db.run(sql`insert into follows (follower_id, followee_id, created_at, updated_at)
        values (${BEA}, ${reader.userId}, 0, 0)`),
    )
    const counts = async () => {
      const res = await api.request(`/api/v1/public/profiles/${handle}`)
      return ((await res.json()) as { counts: { following: number; followers: number } }).counts
    }
    expect(await counts()).toMatchObject({ following: 1, followers: 1 })
    await leave('suspended_at', ANNA)
    await leave('deleted_at', BEA)
    expect(await counts()).toMatchObject({ following: 0, followers: 0 })
  })

  test('drops from a follower’s device and their Following, and cannot be followed', async () => {
    const before = await pullOf(api, reader, 0)
    expect(before.rows.follows.map((f) => f.userId)).toEqual([ANNA])
    const following = async () => {
      const res = await api.request('/api/v1/following', { as: reader })
      return ((await res.json()) as { items: { person: { id: string } }[] }).items.map(
        (i) => i.person.id,
      )
    }
    expect(await following()).toContain(ANNA)

    await leave('suspended_at')
    // The follow row is untouched: sent as unfollowed, at the time they left.
    const delta = await pullOf(api, reader, before.cursor)
    expect(delta.rows.follows.map((f) => [f.userId, f.deletedAt])).toEqual([
      [ANNA, api.clock.now()],
    ])
    expect((await pullOf(api, reader, 0)).rows.follows).toEqual([])
    expect(await following()).not.toContain(ANNA)

    // A follow of someone gone is acknowledged, and writes nothing.
    await leave('deleted_at', BEA)
    const pushed = await api.request('/api/v1/mutations', {
      as: reader,
      body: {
        mutations: [{ mid: 'follow-bea-0001', at: api.clock.now(), type: 'follow', userId: BEA }],
      },
    })
    expect(pushed.status).toBe(200)
    expect(await api.db.all(sql`select 1 from follows where followee_id = ${BEA}`)).toEqual([])

    // Back in good standing, the follow comes back as it was, on the next pull.
    const cursor = (await pullOf(api, reader, 0)).cursor
    await write(
      api.db,
      api.db.run(sql`update profiles set suspended_at = null, seq = ${currentSeq}
        where user_id = ${ANNA}`),
    )
    expect(
      (await pullOf(api, reader, cursor)).rows.follows.map((f) => [f.userId, f.deletedAt]),
    ).toEqual([[ANNA, null]])
  })
})
