/**
 * A member with something on every public page, for the tests of standing (ADRs 0058, 0059):
 * Anna writes blog 1, recommends post 1 with a note, shows a picture and a public blogroll, and is
 * followed; then what each public answer says about her, to hold against what it says once she is
 * suspended or gone.
 */
import { expect } from 'bun:test'
import { bumpSeq, currentSeq, type TelaDb } from '@tela/data'
import type { PullResponse } from '@tela/sync'
import { sql } from 'drizzle-orm'
import type { SignedIn, TestApi } from './helpers'

/** Anna is the one whose standing changes; she never signs in. Bea is another member. */
export const ANNA = 'u-anna-000001'
export const BEA = 'u-bea-0000001'
export const ROLL = 'annasRoll001'

export async function write(db: TelaDb, ...statements: ReturnType<TelaDb['run']>[]) {
  await db.batch([bumpSeq(db), ...statements] as never)
}

/** A member who never signs in here, with an uploaded picture. */
async function person(db: TelaDb, id: string, handle: string) {
  await write(
    db,
    db.run(sql`insert into user (id, name, email, email_verified, created_at, updated_at)
      values (${id}, ${handle}, ${`${handle}@x.test`}, 1, 0, 0)`),
    db.run(sql`insert into profiles (user_id, handle, display_name, bio, public_subscriptions,
        avatar_key, avatar_version, created_at, updated_at, seq)
      values (${id}, ${handle}, ${`Name ${handle}`}, ${`Bio of ${handle}`}, 1,
        ${`avatars/${id}/1`}, 1, 0, 0, ${currentSeq})`),
  )
}

/**
 * Blog 1 is Anna's, listed; blog 2 listed; blog 3 nobody's and private. One post each, a day old;
 * Anna recommends post 1 with a note, Bea posts 1 and 2 without; Anna's public blogroll holds all
 * three; `follower` follows Anna.
 */
export async function seedAnna(api: TestApi, follower: SignedIn) {
  const { db } = api
  await person(db, ANNA, 'anna')
  await person(db, BEA, 'bea')
  await api.blobs.put(`avatars/${ANNA}/1`, 'png', { contentType: 'image/png' })
  const now = api.clock.now()
  await write(
    db,
    db.run(sql`insert into sites (id, home_url, title, listing, claimed_by, claimed_at, created_at,
        updated_at, seq)
      values (1, 'https://anna.example', 'Anna writes', 'listed', ${ANNA}, 0, 0, 0, ${currentSeq}),
        (2, 'https://two.example', 'Blog two', 'listed', null, null, 0, 0, ${currentSeq}),
        (3, 'https://three.example', 'Blog three', 'private', null, null, 0, 0, ${currentSeq})`),
    db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, created_at,
        updated_at, seq)
      values (1, 1, 'https://anna.example/feed', 'anna.example', 0, 0, 0, ${currentSeq}),
        (2, 2, 'https://two.example/feed', 'two.example', 0, 0, 0, ${currentSeq}),
        (3, 3, 'https://three.example/feed', 'three.example', 0, 0, 0, ${currentSeq})`),
    db.run(sql`insert into articles (id, feed_id, dedup_key, title, fetched_at, sort_at,
        source_lang, current_version, content_key, seq)
      values (1, 1, 'k1', 'Post one', 0, ${now - 86_400_000}, 'en', 1, 'c1', ${currentSeq}),
        (2, 2, 'k2', 'Post two', 0, ${now - 86_400_000}, 'en', 1, 'c2', ${currentSeq}),
        (3, 3, 'k3', 'Post three', 0, ${now - 86_400_000}, 'en', 1, 'c3', ${currentSeq})`),
    db.run(sql`insert into recommendations (user_id, article_id, note, created_at, updated_at, seq)
      values (${ANNA}, 1, 'Read this one', ${now - 3_600_000}, 0, ${currentSeq}),
        (${BEA}, 1, null, ${now - 3_600_000}, 0, ${currentSeq}),
        (${BEA}, 2, null, ${now - 3_600_000}, 0, ${currentSeq})`),
    db.run(sql`insert into blogrolls (id, user_id, name, description, is_public, public_version,
        public_since, created_at, updated_at, seq)
      values (${ROLL}, ${ANNA}, 'Anna reads', '', 1, 1, 1, 0, 0, ${currentSeq})`),
    db.run(sql`insert into blogroll_blogs (blogroll_id, feed_id, user_id, added_at, updated_at, seq)
      values (${ROLL}, 1, ${ANNA}, 1, 1, ${currentSeq}), (${ROLL}, 2, ${ANNA}, 2, 2, ${currentSeq}),
        (${ROLL}, 3, ${ANNA}, 3, 3, ${currentSeq})`),
    db.run(sql`insert into follows (follower_id, followee_id, created_at, updated_at, seq)
      values (${follower.userId}, ${ANNA}, 0, 0, ${currentSeq})`),
  )
}

/** Everything public about Anna, as anyone may read it. */
export async function annaInPublic(api: TestApi) {
  const pub = async <T>(path: string) => {
    const res = await api.request(`/api/v1/public${path}`)
    return { status: res.status, body: (await res.json()) as T }
  }
  type Site = {
    site: { claimedBy: string | null; claimant: unknown }
    notes: { person: { handle: string } }[]
  }
  type Week = {
    recommended: { recommenders: string[]; note: { person: { id: string } } | null }[]
    readers: { id: string }[]
  }
  type Front = { edition: { posts: { claimant: { handle: string } | null }[] } }
  const [profile, site, week, readers, roll, rolls, front, avatar, handle] = await Promise.all([
    pub<unknown>('/profiles/anna'),
    pub<Site>('/sites/1'),
    pub<Week>('/discover/week'),
    pub<{ readers: { id: string }[] }>('/discover/readers'),
    pub<unknown>(`/blogrolls/${ROLL}`),
    pub<{ blogrolls: { id: string }[] }>('/discover/blogrolls'),
    pub<Front>('/front'),
    api.request(`/api/v1/public/avatars/${ANNA}?v=1`),
    pub<{ status: string }>('/handles/anna'),
  ])
  // Post 1, which Bea recommends too, so it is listed whatever happens to Anna.
  const post1 = week.body.recommended.find((p) => p.recommenders.includes(BEA))
  return {
    profile: profile.status,
    claimant: site.body.site.claimedBy,
    siteNotes: site.body.notes.map((n) => n.person.handle),
    recommenders: post1?.recommenders.includes(ANNA) ?? false,
    note: post1?.note?.person.id ?? null,
    readers: readers.body.readers.some((r) => r.id === ANNA),
    weekReaders: week.body.readers.some((r) => r.id === ANNA),
    blogroll: roll.status,
    discoverBlogrolls: rolls.body.blogrolls.map((b) => b.id),
    frontClaimant: front.body.edition.posts.map((p) => p.claimant?.handle ?? null),
    avatar: avatar.status,
    handle: handle.body.status,
  }
}

export const SHOWN = {
  profile: 200,
  claimant: 'anna',
  siteNotes: ['anna'],
  recommenders: true,
  note: ANNA,
  readers: true,
  weekReaders: true,
  blogroll: 200,
  discoverBlogrolls: [ROLL],
  frontClaimant: expect.arrayContaining(['anna']),
  avatar: 200,
  handle: 'taken',
}

export const HIDDEN = {
  profile: 404,
  claimant: null,
  siteNotes: [],
  recommenders: false,
  note: null,
  readers: false,
  weekReaders: false,
  blogroll: 404,
  discoverBlogrolls: [],
  frontClaimant: expect.not.arrayContaining(['anna']),
  avatar: 404,
  // A handle nobody can see is still nobody else's.
  handle: 'taken',
}

export const pullOf = async (api: TestApi, as: SignedIn, cursor: number) =>
  (await (await api.request(`/api/v1/sync?cursor=${cursor}`, { as })).json()) as PullResponse
