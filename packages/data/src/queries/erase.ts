/**
 * Erasing a closed account (ADR 0058), the second phase after `closeAccount`: what only the
 * member's own devices held, removed by `member.erase` in tela-jobs once no signed copy of their
 * session can be read any more, so nothing the member's tabs still send lands after it.
 *
 * Each step takes at most `ERASE_CHUNK` rows of one table, and a step is repeated until it takes
 * fewer, each time in a fenced batch of its own (invariant 6): a run that loses its lease writes
 * nothing, and the next run carries on where the last batch left off. A count others see that
 * rests on the rows (a post's likes and recommendations, a blog's readers) is recounted without
 * the member before those rows go, in the same batch; at most a chunk of posts or blogs moves per
 * seq, so another member's pull never meets a seq too big for a page (ADR 0025).
 *
 * Rows held by other members' devices are never hard-deleted here: a follow of the member stays
 * deleted (soft), as `closeAccount` left it, since a device that has not pulled since would never
 * hear of a row that is gone. Every statement selects by the member's id, never by a list of ids.
 */
import { type SQL, sql } from 'drizzle-orm'
import type { TelaDb } from '../db'
import { currentSeq } from '../seq'
import { ERASE_AFTER_MS, releaseClaim } from './leaving'
import { recountReaders } from './sites'
import { CLOSED } from './translation'

type Statement = ReturnType<TelaDb['run']>

/** The most rows one step's batch takes from its table. */
export const ERASE_CHUNK = 500

/**
 * Closed accounts whose erasure is due: closed `ERASE_AFTER_MS` ago and not erased. One that ran
 * out of attempts waits while its dead letter is unresolved, or dismissed: the letter is the record
 * that it stopped, and an erasure cannot be marked done when it is not. A retry from the console
 * resolves the letter, which makes it due again.
 */
export const dueErasures = (now: number): SQL =>
  sql`select p.user_id as key, null as host, p.deleted_at as ord from profiles p
    where p.deleted_at is not null and p.erased_at is null
      and p.deleted_at <= ${now - ERASE_AFTER_MS}
      and not exists (select 1 from dead_letters d
        where d.kind = 'member.erase' and d.key = p.user_id
          and (d.resolved_at is null or d.resolution = 'dismissed'))`

/** One step's batch: its statements, and which of them returns the rows it took. */
export type EraseChunk = { name: string; statements: Statement[]; counted: number }

const limit = sql.raw(String(ERASE_CHUNK))

/**
 * The steps, in order. A later step may rely on an earlier one having run to the end: feed
 * filings go before folders (a folder's deletion would otherwise write to them), blogs in a
 * blogroll before the blogroll, and a member's old unsubscribed rows before the live ones, so
 * that a live chunk, once deleted as an unsubscribe is, is the only deleted rows left to recount.
 */
export const ERASE_STEPS: ((db: TelaDb, userId: string, now: number) => EraseChunk)[] = [
  // A blog verified for the member as the account closed (a check already past its fence), let
  // go again before the claims step takes the rows, which it does only once none is verified.
  (db, id, now) => ({
    name: 'release',
    counted: 0,
    statements: releaseClaim(db, { userId: id, by: 'closure', now }),
  }),
  // Read and like states. The likes others see on each post are counted again without the
  // member's first, and only where that changes them.
  (db, id) => {
    const chunk = sql`select article_id from user_article_states where user_id = ${id}
      order by article_id limit ${limit}`
    const likes = sql`(select count(*) from user_article_states s
      where s.article_id = articles.id and s.liked_at is not null and s.user_id <> ${id})`
    return {
      name: 'states',
      counted: 1,
      statements: [
        db.run(sql`
          update articles set like_count = ${likes}, seq = ${currentSeq}
          where id in (select article_id from user_article_states
              where user_id = ${id} and liked_at is not null and article_id in (${chunk}))
            and like_count <> ${likes}
        `),
        db.all(sql`
          delete from user_article_states where user_id = ${id} and article_id in (${chunk})
          returning article_id
        `),
      ],
    }
  },
  // Recommendations, already deleted (soft) and emptied by the closing; the count others see is
  // taken again, without any the member's tabs made after it.
  (db, id) => {
    const chunk = sql`select article_id from recommendations where user_id = ${id}
      order by article_id limit ${limit}`
    const recommended = sql`(select count(*) from recommendations r
      where r.article_id = articles.id and r.deleted_at is null and r.user_id <> ${id})`
    return {
      name: 'recommendations',
      counted: 1,
      statements: [
        db.run(sql`
          update articles set recommend_count = ${recommended}, seq = ${currentSeq}
          where id in (${chunk}) and recommend_count <> ${recommended}
        `),
        db.all(sql`
          delete from recommendations where user_id = ${id} and article_id in (${chunk})
          returning article_id
        `),
      ],
    }
  },
  (db, id) => ({
    name: 'highlights',
    counted: 0,
    statements: [
      db.all(sql`
        delete from highlights where id in (
          select id from highlights where user_id = ${id} limit ${limit})
        returning id
      `),
    ],
  }),
  (db, id) => ({
    name: 'feedFolders',
    counted: 0,
    statements: [
      db.all(sql`
        delete from feed_folders where user_id = ${id} and feed_id in (
          select feed_id from feed_folders where user_id = ${id} limit ${limit})
        returning feed_id
      `),
    ],
  }),
  (db, id) => ({
    name: 'folders',
    counted: 0,
    statements: [
      db.all(sql`
        delete from folders where id in (
          select id from folders where user_id = ${id} limit ${limit})
        returning id
      `),
    ],
  }),
  (db, id) => ({
    name: 'blogrollBlogs',
    counted: 0,
    statements: [
      db.all(sql`
        delete from blogroll_blogs where rowid in (
          select rowid from blogroll_blogs where user_id = ${id} limit ${limit})
        returning feed_id
      `),
    ],
  }),
  (db, id) => ({
    name: 'blogrolls',
    counted: 0,
    statements: [
      db.all(sql`
        delete from blogrolls where id in (
          select id from blogrolls where user_id = ${id} limit ${limit})
        returning id
      `),
    ],
  }),
  // Blogs the member had left already: no count rests on them.
  (db, id) => ({
    name: 'leftSubscriptions',
    counted: 0,
    statements: [
      db.all(sql`
        delete from subscriptions where user_id = ${id} and deleted_at is not null
          and feed_id in (select feed_id from subscriptions
            where user_id = ${id} and deleted_at is not null limit ${limit})
        returning feed_id
      `),
    ],
  }),
  // The blogs they read: a chunk unsubscribed as an unsubscribe is, the readers of those blogs
  // counted again as one is (`recountReaders`, which opens no door here: a count only falls), and
  // the chunk deleted. The deleted rows are exactly the chunk, since the step before took the rest.
  (db, id, now) => {
    const left = sql`select f.site_id from subscriptions s join feeds f on f.id = s.feed_id
      where s.user_id = ${id} and s.deleted_at is not null`
    return {
      name: 'subscriptions',
      counted: 3,
      statements: [
        db.run(sql`
          update subscriptions set deleted_at = ${now}, updated_at = ${now}, seq = ${currentSeq}
          where user_id = ${id} and deleted_at is null and feed_id in (
            select feed_id from subscriptions where user_id = ${id} and deleted_at is null
            order by feed_id limit ${limit})
        `),
        ...recountReaders(db, left, now),
        db.all(sql`
          delete from subscriptions where user_id = ${id} and deleted_at is not null
          returning feed_id
        `),
      ],
    }
  },
  (db, id) => ({
    name: 'prefs',
    counted: 0,
    statements: [
      db.all(sql`
        delete from user_prefs where user_id = ${id} and key in (
          select key from user_prefs where user_id = ${id} limit ${limit})
        returning key
      `),
    ],
  }),
  // The member's own follows, which only their devices held; follows of them stay deleted (soft).
  (db, id) => ({
    name: 'follows',
    counted: 0,
    statements: [
      db.all(sql`
        delete from follows where follower_id = ${id} and followee_id in (
          select followee_id from follows where follower_id = ${id} limit ${limit})
        returning followee_id
      `),
    ],
  }),
  (db, id) => ({
    name: 'mutations',
    counted: 0,
    statements: [
      db.all(sql`
        delete from applied_mutations where user_id = ${id} and mid in (
          select mid from applied_mutations where user_id = ${id} limit ${limit})
        returning mid
      `),
    ],
  }),
  (db, id) => ({
    name: 'tombstones',
    counted: 0,
    statements: [
      db.all(sql`
        delete from tombstones where rowid in (
          select rowid from tombstones where user_id = ${id} limit ${limit})
        returning seq
      `),
    ],
  }),
  (db, id) => ({
    name: 'pendingFeeds',
    counted: 0,
    statements: [
      db.all(sql`
        delete from pending_feeds where user_id = ${id} and feed_url in (
          select feed_url from pending_feeds where user_id = ${id} limit ${limit})
        returning feed_url
      `),
    ],
  }),
  // Its claims, every one released or failed by the closing: no device but the member's held one.
  (db, id) => ({
    name: 'claims',
    counted: 0,
    statements: [
      db.all(sql`
        delete from site_claims where id in (
          select id from site_claims where user_id = ${id} and status <> 'verified' limit ${limit})
        returning id
      `),
    ],
  }),
  // What names the member in Tela's own records stops naming them: the model calls made for
  // them, the feeds they added, the translations they asked for that have ended, the reports they
  // made or resolved. A translation still open keeps its member (`settleBodyUsage` charges them).
  (db, id) => ({
    name: 'calls',
    counted: 0,
    statements: [
      db.all(sql`
        update llm_calls set user_id = null where id in (
          select id from llm_calls where user_id = ${id} limit ${limit})
        returning id
      `),
    ],
  }),
  (db, id) => ({
    name: 'feeds',
    counted: 0,
    statements: [
      db.all(sql`
        update feeds set added_by = null where id in (
          select id from feeds where added_by = ${id} limit ${limit})
        returning id
      `),
    ],
  }),
  (db, id) => ({
    name: 'translations',
    counted: 0,
    statements: [
      db.all(sql`
        update body_translations set requested_by = null where rowid in (
          select rowid from body_translations where requested_by = ${id}
            and state not in ('requested', 'running') limit ${limit})
        returning content_key
      `),
    ],
  }),
  (db, id) => ({
    name: 'reports',
    counted: 0,
    statements: [
      db.all(sql`
        update reports set
          reporter_id = case when reporter_id = ${id} then null else reporter_id end,
          resolved_by = case when resolved_by = ${id} then null else resolved_by end
        where id in (
          select id from reports where reporter_id = ${id} or resolved_by = ${id} limit ${limit})
        returning id
      `),
    ],
  }),
]

/**
 * What a translation still running for the member is: it finishes and is settled to their ledger
 * as ever, so the erasure waits for it before it takes the ledger's rows.
 */
const inFlight = (id: string) => sql`exists (select 1 from body_translations
  where requested_by = ${id} and state in ('requested', 'running'))`

/**
 * The last batch, once every step has run to the end and the pictures are gone. Whatever was written
 * for the member as the account closed is undone again (a follow of them made live, a name set).
 * The usage ledger stops naming them once nothing is left to settle to it: each day's row is
 * folded into `CLOSED`'s, then deleted, so the site's total for the day (ADR 0057), a sum over
 * every subject, stays what it was and a closing never gives the day's budget back. The profile
 * is stamped erased only while nothing the steps take is left, so a run that finds something
 * carries on next time. The last statement's `RETURNING` says whether it stamped.
 */
export function finishErasure(db: TelaDb, id: string, now: number): Statement[] {
  const left = (table: string, column = 'user_id') =>
    sql`exists (select 1 from ${sql.raw(table)} where ${sql.raw(column)} = ${id})`
  const anything = sql.join(
    [
      left('user_article_states'),
      left('recommendations'),
      left('highlights'),
      left('subscriptions'),
      left('folders'),
      left('feed_folders'),
      left('blogrolls'),
      left('user_prefs'),
      left('follows', 'follower_id'),
      left('site_claims'),
      left('pending_feeds'),
      inFlight(id),
    ],
    sql` or `,
  )
  return [
    // A code whose request passed the standing check just before the closing, and was written
    // after it: revoked as the closing revokes the member's, its holds first, which could never
    // finish (its maker is out of standing, so none admitted anyone meanwhile).
    db.run(sql`
      delete from invite_redemptions where redeemed_at is null and code in (
        select code from invite_codes where created_by = ${id} and revoked_at is null)
    `),
    db.run(sql`
      update invite_codes set revoked_at = ${now} where created_by = ${id} and revoked_at is null
    `),
    db.run(sql`
      update follows set deleted_at = ${now}, updated_at = max(updated_at, ${now}),
        seq = ${currentSeq}
      where followee_id = ${id} and deleted_at is null
    `),
    // Folded and deleted under the same guard, in one batch: a run again finds no rows to fold.
    db.run(sql`
      insert into usage_daily (subject, day, reserved, used, requests)
      select ${CLOSED}, day, reserved, used, requests from usage_daily
      where subject = ${id} and not ${inFlight(id)}
      on conflict (subject, day) do update set
        reserved = usage_daily.reserved + excluded.reserved,
        used = usage_daily.used + excluded.used,
        requests = usage_daily.requests + excluded.requests
    `),
    db.run(sql`delete from usage_daily where subject = ${id} and not ${inFlight(id)}`),
    // Posts opened by a signed copy of the session still read after the closing (ADR 0066).
    db.run(sql`delete from post_opens where user_id = ${id}`),
    db.run(sql`
      update profiles set display_name = null, bio = null, avatar_key = null, is_admin = 0,
        public_subscriptions = 0, public_likes = 0, updated_at = ${now}, seq = ${currentSeq}
      where user_id = ${id} and (display_name is not null or bio is not null
        or avatar_key is not null or is_admin = 1 or public_subscriptions = 1 or public_likes = 1)
    `),
    db.all(sql`
      update profiles set erased_at = ${now}
      where user_id = ${id} and deleted_at is not null and erased_at is null and not (${anything})
      returning user_id
    `),
  ]
}

/** Where the member's own pictures are kept (`routes/picture.ts` in tela-api). */
export const avatarPrefix = (userId: string) => `avatars/${userId}/`
