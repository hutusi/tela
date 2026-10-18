/**
 * Blogrolls as others see them (ADR 0050), on D1: the page, the profile's cards and Discover's
 * keyset lean on what libSQL could take differently. A blogroll card's blogs are ordered in a
 * subquery and aggregated with `json_group_array(json_object(…))`, which must keep that order
 * and nest objects, not strings; the name of a blog is a correlated `exists` two levels deep; and
 * Discover pages by a row value over a text id.
 */
import { env } from 'cloudflare:test'
import { bumpSeq, currentSeq, type JobQueues, schema } from '@tela/data'
import type { Ingest } from '@tela/ingest/pipeline'
import { type Blobs, type Jobs, memoryMail } from '@tela/platform'
import { d1Db } from '@tela/platform/cloudflare'
import { sql } from 'drizzle-orm'
import { expect, it } from 'vitest'
import { createApp } from '../../src/app'

const ORIGIN = 'http://tela.test'
const OWNER = 'member-roll-owner01'
const unused = () => {
  throw new Error('not used here')
}

type Card = {
  id: string
  blogCount: number
  blogs: { feedId: number; siteId: number; name: string | null; homeUrl: string }[]
  publicSince: number
  updatedAt: number
}

it('answers a blogroll page, its profile cards and Discover on D1', async () => {
  const db = d1Db(env.DB, schema)
  const jobs: Jobs<JobQueues> = { send: async () => {}, sendBatch: async () => {} }
  const now = Date.now()
  const { app } = createApp({
    db,
    blobs: {
      get: unused,
      put: unused,
      head: unused,
      delete: unused,
      list: unused,
    } as unknown as Blobs,
    jobs,
    clock: { now: () => now },
    mail: memoryMail(),
    ingest: {} as Ingest,
    config: {
      publicUrl: ORIGIN,
      authSecret: 'a-test-secret-that-is-long-enough-for-hmac',
      adminToken: 'admin',
      mailFrom: 'Tela <noreply@tela.test>',
    },
  })
  const get = async <T>(path: string) => {
    const res = await app.request(`${ORIGIN}${path}`, { headers: { origin: ORIGIN } })
    expect(res.status).toBe(200)
    return (await res.json()) as T
  }

  // Blogs 9001–9005; 9006 rejected by the operator; feed 9007 is a second feed of blog 9001.
  await db.batch([
    bumpSeq(db),
    db.run(sql`insert into user (id, name, email, email_verified, created_at, updated_at)
      values (${OWNER}, 'Owner', 'owner@x.test', 1, 0, 0)`),
    db.run(sql`insert into profiles (user_id, handle, display_name, created_at, updated_at, seq)
      values (${OWNER}, 'rollowner', 'Roll Owner', 0, 0, ${currentSeq})`),
    db.run(sql`insert into sites (id, home_url, title, description, listing, reader_count,
        created_at, updated_at, seq)
      select value, 'https://b' || value || '.example', 'Blog ' || value,
        'About ' || value, case when value = 9006 then 'rejected' else 'listed' end,
        case when value = 9002 then 4 else 1 end, 0, 0, ${currentSeq}
      from json_each('[9001,9002,9003,9004,9005,9006]') where true`),
    db.run(sql`insert into feeds (id, site_id, feed_url, host, title, next_fetch_at, created_at,
        updated_at, seq)
      select value, case when value = 9007 then 9001 else value end,
        'https://b' || value || '.example/feed', 'b' || value || '.example', 'Feed ' || value,
        0, 0, 0, ${currentSeq}
      from json_each('[9001,9002,9003,9004,9005,9006,9007]') where true`),
    // A blogroll with blogs in an order that is not their ids', and two feeds of one blog.
    db.run(sql`insert into blogrolls (id, user_id, name, is_public, public_version, public_since,
        created_at, updated_at, seq)
      values ('d1RollFirst1', ${OWNER}, 'First', 1, 1, 100, 10, 10, ${currentSeq}),
        ('d1RollSecnd1', ${OWNER}, 'Second', 1, 1, 200, 20, 20, ${currentSeq}),
        ('d1RollThird1', ${OWNER}, 'Third', 1, 1, 200, 30, 30, ${currentSeq}),
        ('d1RollPriv01', ${OWNER}, 'Private', 0, 0, null, 40, 40, ${currentSeq})`),
    db.run(sql`insert into blogroll_blogs (blogroll_id, feed_id, user_id, note, note_at, added_at,
        updated_at, seq)
      select 'd1RollFirst1', j.value, ${OWNER}, case when j.value = 9002 then 'Noted' end,
        case when j.value = 9002 then 500 else 0 end, j.key, j.key, ${currentSeq}
      from json_each('[9006,9005,9002,9001,9007,9003]') j where true`),
    db.run(sql`insert into blogroll_blogs (blogroll_id, feed_id, user_id, added_at, updated_at, seq)
      select r.value, f.value, ${OWNER}, f.key, f.key, ${currentSeq}
      from json_each('["d1RollSecnd1","d1RollThird1","d1RollPriv01"]') r
      join json_each('[9003,9004,9005]') f where true`),
  ])

  const page = await get<{
    blogroll: { id: string; updatedAt: number }
    owner: { id: string; handle: string }
    blogs: {
      feedId: number
      name: string | null
      readerCount: number | null
      note: string | null
    }[]
  }>('/api/v1/public/blogrolls/d1RollFirst1')
  expect(page.blogroll).toMatchObject({ id: 'd1RollFirst1', updatedAt: 500 })
  expect(page.owner).toMatchObject({ id: OWNER, handle: 'rollowner' })
  expect(page.blogs.map((b) => [b.feedId, b.name])).toEqual([
    [9005, 'Blog 9005'],
    [9002, 'Blog 9002'],
    [9001, 'Feed 9001'],
    [9007, 'Feed 9007'],
    [9003, 'Blog 9003'],
  ])
  expect(page.blogs[1]).toMatchObject({ readerCount: 4, note: 'Noted' })
  expect(page.blogs[0]?.readerCount).toBeNull()
  const missing = await app.request(`${ORIGIN}/api/v1/public/blogrolls/d1RollPriv01`)
  expect(missing.status).toBe(404)

  const profile = await get<{ blogrolls: Card[] }>('/api/v1/public/profiles/rollowner')
  expect(profile.blogrolls.map((c) => c.id)).toEqual([
    'd1RollThird1',
    'd1RollSecnd1',
    'd1RollFirst1',
  ])
  const first = profile.blogrolls[2]
  expect(first?.blogCount).toBe(5)
  expect(first?.blogs).toEqual([
    { feedId: 9005, siteId: 9005, name: 'Blog 9005', homeUrl: 'https://b9005.example' },
    { feedId: 9002, siteId: 9002, name: 'Blog 9002', homeUrl: 'https://b9002.example' },
    { feedId: 9001, siteId: 9001, name: 'Feed 9001', homeUrl: 'https://b9001.example' },
  ])

  // Two share a moment: the id orders them, and the cursor names both parts.
  const all = await get<{ blogrolls: Card[]; next: string | null }>(
    '/api/v1/public/discover/blogrolls',
  )
  expect(all.blogrolls.map((c) => c.id)).toEqual(['d1RollThird1', 'd1RollSecnd1', 'd1RollFirst1'])
  expect(all.blogrolls[2]?.blogs.map((b) => b.feedId)).toEqual([9005, 9002, 9001, 9007, 9003])
  const after = await get<{ blogrolls: Card[] }>(
    `/api/v1/public/discover/blogrolls?cursor=${encodeURIComponent('200:d1RollThird1')}`,
  )
  expect(after.blogrolls.map((c) => c.id)).toEqual(['d1RollSecnd1', 'd1RollFirst1'])
})
