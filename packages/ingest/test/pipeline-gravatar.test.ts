/**
 * Whether a member has a Gravatar (ADR 0033), asked of a server that stands in for gravatar.com:
 * the answer, when it is asked again, and what it does to the picture's address.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { sha256Hex } from '@tela/content/hash'
import {
  bumpSeq,
  claimDue,
  currentSeq,
  dueGravatarChecks,
  first,
  type Lease,
  type TelaDb,
} from '@tela/data'
import { addTestUser, createTestDb } from '@tela/data/testing'
import { fakeClock, memoryBlobs } from '@tela/platform/portable'
import { sql } from 'drizzle-orm'
import { createHttpClient } from '../src/http'
import { gravatarCheckJob, type IngestContext } from '../src/pipeline'
import { FixtureServer } from './fixture-server'

const NOW = Date.UTC(2026, 9, 1, 12)
const DAY = 24 * 60 * 60 * 1000
const ID = 'member-anna-0000001'
const http = createHttpClient({
  userAgent: 'TelaTest/1.0',
  politenessMs: 0,
  allowPrivateHosts: true,
  timeoutMs: 300,
})
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

let server: FixtureServer
let db: TelaDb
let clock: ReturnType<typeof fakeClock>
let path: string

beforeAll(async () => {
  server = await FixtureServer.start()
})
afterAll(async () => {
  await server.stop()
})
beforeEach(async () => {
  server.reset()
  db = (await createTestDb()).db
  clock = fakeClock(NOW)
  // Gravatar hashes the address trimmed and lower-cased, whatever the row holds.
  await addTestUser(db, ID, ' Anna@X.test ')
  await db.batch([
    bumpSeq(db),
    db.run(sql`insert into profiles (user_id, handle, created_at, updated_at, seq)
      values (${ID}, 'anna', 0, 0, ${currentSeq})`),
  ] as never)
  path = `/avatar/${await sha256Hex('anna@x.test')}`
})

const ctx = (): IngestContext => ({
  db,
  blobs: memoryBlobs(),
  http,
  clock,
  gravatarUrl: server.url('/avatar'),
  allowPrivateHosts: true,
})

const picture = (status: number) =>
  server.set(path, (_req, res) => {
    res.writeHead(status, { 'content-type': status === 200 ? 'image/png' : 'text/plain' })
    res.end(status === 200 ? PNG : 'nope')
  })

async function claim(): Promise<Lease> {
  const got = await claimDue(db, {
    kind: 'member.gravatar',
    owner: 'w1',
    now: clock.now(),
    ttlMs: 2 * 60_000,
    limit: 1,
    due: dueGravatarChecks(clock.now()),
  })
  if (got.length !== 1) throw new Error('nothing due')
  return { kind: 'member.gravatar', key: ID, owner: 'w1' }
}

const row = () =>
  first<{
    gravatar_found: number | null
    gravatar_checked_at: number | null
    avatar_version: number
    seq: number
  }>(
    db,
    sql`select gravatar_found, gravatar_checked_at, avatar_version, seq from profiles where user_id = ${ID}`,
  )

const isDue = async () =>
  (await db.all(sql`select key from (${dueGravatarChecks(clock.now())})`)).length > 0

describe('member.gravatar', () => {
  test('a picture is found, by the hash of the normalized address, and the version moves', async () => {
    picture(200)
    expect(await gravatarCheckJob(ctx(), await claim())).toEqual({ status: 'done', found: true })
    expect(await row()).toMatchObject({
      gravatar_found: 1,
      gravatar_checked_at: NOW,
      avatar_version: 1,
    })
    expect(server.requests.map((r) => r.path)).toEqual([path])
    // Asked again after 30 days, not before.
    clock.advance(29 * DAY)
    expect(await isDue()).toBe(false)
    clock.advance(2 * DAY)
    expect(await isDue()).toBe(true)
  })

  test('none is recorded, the version stays, and it is asked again after a week', async () => {
    picture(404)
    expect(await gravatarCheckJob(ctx(), await claim())).toEqual({ status: 'done', found: false })
    expect(await row()).toMatchObject({ gravatar_found: 0, avatar_version: 0 })
    clock.advance(6 * DAY)
    expect(await isDue()).toBe(false)
    clock.advance(2 * DAY)
    expect(await isDue()).toBe(true)
  })

  test('an answer that did not change does not send the row again', async () => {
    picture(200)
    await gravatarCheckJob(ctx(), await claim())
    const before = await row()
    clock.advance(31 * DAY)
    await gravatarCheckJob(ctx(), await claim())
    const after = await row()
    expect(after?.seq).toBe(before?.seq)
    expect(after).toMatchObject({ avatar_version: 1, gravatar_checked_at: NOW + 31 * DAY })
  })

  test('a picture made after a miss moves the version, so no cached "none" stands', async () => {
    picture(404)
    await gravatarCheckJob(ctx(), await claim())
    clock.advance(8 * DAY)
    picture(200)
    await gravatarCheckJob(ctx(), await claim())
    expect(await row()).toMatchObject({ gravatar_found: 1, avatar_version: 1 })
  })

  test('an error from Gravatar is asked again later, and records nothing', async () => {
    picture(503)
    expect(await gravatarCheckJob(ctx(), await claim())).toEqual({
      status: 'retry',
      error: 'http 503',
    })
    expect(await row()).toMatchObject({ gravatar_found: null, gravatar_checked_at: null })
  })

  test('a member who turned their Gravatar off is not asked about', async () => {
    await db.run(sql`update profiles set gravatar = 0, gravatar_at = 5 where user_id = ${ID}`)
    expect(await isDue()).toBe(false)
  })
})
