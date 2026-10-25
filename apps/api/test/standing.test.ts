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

  test.each(['suspended_at', 'deleted_at'] as const)(
    'is named in no export or invite list once %s is set, and their place stays taken',
    async (column) => {
      // The reader follows Anna (the fixture), Anna joined by the reader's code, and the reader by
      // Bea's.
      await write(
        api.db,
        api.db.run(sql`insert into invite_codes (code, created_by, max_uses, created_at)
        values ('READERCODE01', ${reader.userId}, 1, 0), ('BEACODE00001', ${BEA}, 1, 0)`),
        api.db.run(sql`insert into invite_redemptions (code, email, expires_at, redeemed_at, user_id,
          settled_at, created_at)
        values ('READERCODE01', 'anna@x.test', 0, 5, ${ANNA}, 5, 0)`),
        api.db.run(sql`update invite_redemptions set code = 'BEACODE00001'
        where user_id = ${reader.userId}`),
      )
      type Export = {
        following: { handle: string }[]
        inviteCodes: { joined: { handle: string | null; joinedAt: number }[] }[]
        joinedBy: { invitedBy: string | null } | null
      }
      const named = async () => {
        const body = (await (await api.request('/api/v1/export', { as: reader })).json()) as Export
        const listed = (await (await api.request('/api/v1/invites', { as: reader })).json()) as {
          codes: { handle: string | null; joinedAt: number | null }[]
        }
        return {
          following: body.following.map((f) => f.handle),
          joined: body.inviteCodes.flatMap((c) => c.joined),
          invitedBy: body.joinedBy?.invitedBy ?? null,
          listed: listed.codes.map((c) => [c.handle, c.joinedAt]),
        }
      }
      expect(await named()).toEqual({
        following: ['anna'],
        joined: [{ handle: 'anna', joinedAt: 5 }],
        invitedBy: 'bea',
        listed: [['anna', 5]],
      })
      await leave(column, ANNA)
      await leave(column, BEA)
      expect(await named()).toEqual({
        following: [],
        joined: [{ handle: null, joinedAt: 5 }],
        invitedBy: null,
        listed: [[null, 5]],
      })
    },
  )

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
