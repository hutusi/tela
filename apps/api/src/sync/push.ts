/**
 * Applying a push (ADR 0025): every mutation in one batch, so a push lands whole or not at all.
 *
 * - **Replays change nothing.** Each statement is guarded by the mutation's id not being in
 *   `applied_mutations`, and the id is recorded last.
 * - **A bad reference is a no-op, not an error.** Rows are written through `insert … select …
 *   where exists (…)`, so an article or feed that does not exist writes nothing instead of a
 *   foreign-key violation aborting everyone else's mutations in the batch.
 * - **Conflicts across devices go to the later `at`**, clamped to the server's clock so a device
 *   with a clock in the future cannot win every argument.
 */
import { bumpSeq, currentSeq, gravatarOn, recountReaders, type TelaDb } from '@tela/data'
import { type Mutation, mutationSchema, PREF_MAX_BYTES, type PushResponse } from '@tela/sync'
import { sql } from 'drizzle-orm'

type Statement = Parameters<TelaDb['batch']>[0][number]

function statementsFor(
  db: TelaDb,
  userId: string,
  m: Mutation,
  at: number,
  now: number,
): Statement[] {
  const fresh = sql`not exists (select 1 from applied_mutations where user_id = ${userId} and mid = ${m.mid})`
  const article = (id: number) => sql`exists (select 1 from articles where id = ${id})`
  const recount = (column: 'like_count' | 'recommend_count', articleId: number) => {
    const count =
      column === 'like_count'
        ? sql`(select count(*) from user_article_states where article_id = ${articleId} and liked_at is not null)`
        : sql`(select count(*) from recommendations where article_id = ${articleId} and deleted_at is null)`
    return db.run(sql`
      update articles set ${sql.raw(column)} = ${count}, seq = ${currentSeq}
      where id = ${articleId} and ${sql.raw(column)} <> ${count}
    `)
  }
  const siteOf = (feedId: number) => sql`(select site_id from feeds where id = ${feedId})`

  switch (m.type) {
    case 'markRead':
      // Read is set once, so a first read keeps its time and no clock: compaction may drop it
      // under the watermark, as ever. Over a post marked unread (ADR 0009) it is a hand-made
      // choice like the unread was: the later `at` decides, and the read keeps its clock, so an
      // older unread arriving after it loses, and compaction keeps the row that says so.
      return [
        db.run(sql`
          insert into user_article_states (user_id, article_id, read_at, seq)
          select ${userId}, ${m.articleId}, ${at}, ${currentSeq}
          where ${article(m.articleId)} and ${fresh}
          on conflict (user_id, article_id) do update set
            read_at = excluded.read_at,
            read_updated_at = case when user_article_states.read_updated_at is null then null
              else excluded.read_at end,
            seq = excluded.seq
          where user_article_states.read_at is null
            and (user_article_states.read_updated_at is null
              or excluded.read_at >= user_article_states.read_updated_at)
        `),
      ]
    case 'markUnread':
      // Unread by hand: no `read_at`, and the clock that says when (ADR 0009). It beats the
      // watermark and the horizon until a later read, and goes to the later `at` against any read
      // or unread already made, the first read's own time included.
      return [
        db.run(sql`
          insert into user_article_states (user_id, article_id, read_at, read_updated_at, seq)
          select ${userId}, ${m.articleId}, null, ${at}, ${currentSeq}
          where ${article(m.articleId)} and ${fresh}
          on conflict (user_id, article_id) do update set
            read_at = null, read_updated_at = excluded.read_updated_at, seq = excluded.seq
          where excluded.read_updated_at >= max(coalesce(user_article_states.read_updated_at, 0),
            coalesce(user_article_states.read_at, 0))
        `),
      ]
    case 'setLiked':
      return [
        // Liking also reads, unless the member has chosen read or unread by hand: a like never
        // moves that choice. The later of two devices' likes decides.
        db.run(sql`
          insert into user_article_states (user_id, article_id, read_at, liked_at, liked_updated_at, seq)
          select ${userId}, ${m.articleId}, ${at}, ${m.liked ? at : null}, ${at}, ${currentSeq}
          where ${article(m.articleId)} and ${fresh}
          on conflict (user_id, article_id) do update set
            liked_at = excluded.liked_at, liked_updated_at = excluded.liked_updated_at,
            read_at = case when user_article_states.read_updated_at is not null
              then user_article_states.read_at
              else coalesce(user_article_states.read_at, excluded.read_at) end,
            seq = excluded.seq
          where user_article_states.liked_updated_at is null
            or excluded.liked_updated_at > user_article_states.liked_updated_at
        `),
        recount('like_count', m.articleId),
      ]
    case 'markAllRead': {
      // Up to what the client displayed, and never past what exists: a watermark ahead of the
      // feed would mark posts read before they arrive.
      const feed = m.feedId === undefined ? sql`` : sql`and feed_id = ${m.feedId}`
      const target = sql`min(${m.upTo}, (select coalesce(max(id), 0) from articles where feed_id = subscriptions.feed_id))`
      const feedOf = m.feedId === undefined ? sql`` : sql`and s.feed_id = ${m.feedId}`
      return [
        db.run(sql`
          update subscriptions set watermark_id = ${target}, updated_at = ${now}, seq = ${currentSeq}
          where user_id = ${userId} and deleted_at is null ${feed}
            and watermark_id < ${target} and ${fresh}
        `),
        // A post marked unread beats the watermark (ADR 0009), so the ones this covers are read
        // by hand, with the mark-all's clock: those marked before it, not one marked since.
        db.run(sql`
          update user_article_states set read_at = ${at}, read_updated_at = ${at}, seq = ${currentSeq}
          where user_id = ${userId} and read_at is null and read_updated_at is not null
            and read_updated_at <= ${at} and ${fresh}
            and article_id in (
              select a.id from articles a join subscriptions s on s.feed_id = a.feed_id
              where s.user_id = ${userId} and s.deleted_at is null ${feedOf} and a.id <= ${m.upTo}
            )
        `),
      ]
    }
    case 'subscribe':
      return [
        db.run(sql`
          insert into subscriptions (user_id, feed_id, watermark_id, created_at, updated_at, seq)
          select ${userId}, coalesce(merged_into, id), 0, ${now}, ${now}, ${currentSeq}
          from feeds where id = ${m.feedId} and ${fresh}
          on conflict (user_id, feed_id) do update set
            deleted_at = null, updated_at = excluded.updated_at, seq = excluded.seq
          where subscriptions.deleted_at is not null
        `),
        ...recountReaders(db, siteOf(m.feedId), now),
      ]
    case 'unsubscribe':
      return [
        db.run(sql`
          update subscriptions set deleted_at = ${now}, updated_at = ${now}, seq = ${currentSeq}
          where user_id = ${userId} and deleted_at is null and ${fresh}
            and feed_id = (select coalesce(merged_into, id) from feeds where id = ${m.feedId})
        `),
        ...recountReaders(db, siteOf(m.feedId), now),
      ]
    case 'setPref':
      return [
        db.run(sql`
          insert into user_prefs (user_id, key, value_json, updated_at, seq)
          select ${userId}, ${m.key}, ${JSON.stringify(m.value)}, ${at}, ${currentSeq} where ${fresh}
          on conflict (user_id, key) do update set
            value_json = excluded.value_json, updated_at = excluded.updated_at, seq = excluded.seq
          where excluded.updated_at >= user_prefs.updated_at
        `),
      ]
    case 'setProfile': {
      // Each language to the later `at`, on a clock of its own, as a privacy switch goes (ADR
      // 0040): the header and Settings change them from every device, and the last push to arrive
      // is not the last choice. A reading language of null is a value, following the interface;
      // one left out is left alone, its clock included. Stamped whether or not it won, so the
      // next pull hands the device the row that beat it.
      const field = (column: 'ui_locale' | 'reading_lang', v: string | null | undefined) => {
        if (v === undefined) return sql``
        const clock = sql.raw(`${column}_at`)
        const later = sql`${at} >= ${clock}`
        return sql`${sql.raw(column)} = case when ${later} then ${v} else ${sql.raw(column)} end,
          ${clock} = case when ${later} then ${at} else ${clock} end,`
      }
      return [
        db.run(sql`
          update profiles set
            ${field('ui_locale', m.uiLocale)}
            ${field('reading_lang', m.readingLang)}
            updated_at = ${now}, seq = ${currentSeq}
          where user_id = ${userId} and ${fresh}
        `),
      ]
    }
    case 'setPrivacy': {
      // Each switch on its own, so one switch's change never decides the other's (ADR 0031), and
      // a hide and a show are not ordered alike (issue #16):
      // - a hide always applies, whatever its `at`: an old hide arriving after a newer show turns
      //   the switch off, which fails closed, and the member can show it again;
      // - a show with a base applies only while the switch's version is still the one it was made
      //   against, so a show queued before a hide made elsewhere is refused, whatever the clocks
      //   say; a device's own hide-then-show both apply, since the show names the hide's version;
      // - a show without a base, from a shell before it, goes to the later `at` as it always did.
      // Every change counts the version up, and the clock only ever moves forward, since a show
      // without a base is still decided by it. SQLite reads the row as it was in every SET, so the
      // version and clock tested are the ones before this change. Bound as 1 or 0, since `false`
      // is a value; an absent switch is left alone, its clock and version included. Stamped
      // whether or not it applied, so the next pull hands the device the row that beat it.
      const flag = (
        column: 'public_subscriptions' | 'public_likes',
        v: boolean | undefined,
        base: number | undefined,
      ) => {
        if (v === undefined) return sql``
        const value = sql.raw(column)
        const clock = sql.raw(`${column}_at`)
        const version = sql.raw(`${column}_version`)
        if (!v) {
          return sql`${value} = 0, ${clock} = max(${clock}, ${at}), ${version} = ${version} + 1,`
        }
        const applies = base === undefined ? sql`${at} >= ${clock}` : sql`${version} = ${base}`
        return sql`${value} = case when ${applies} then 1 else ${value} end,
          ${clock} = case when ${applies} then max(${clock}, ${at}) else ${clock} end,
          ${version} = case when ${applies} then ${version} + 1 else ${version} end,`
      }
      return [
        db.run(sql`
          update profiles set
            ${flag('public_subscriptions', m.publicSubscriptions, m.base?.publicSubscriptions)}
            ${flag('public_likes', m.publicLikes, m.base?.publicLikes)}
            updated_at = ${now}, seq = ${currentSeq}
          where user_id = ${userId} and ${fresh}
        `),
      ]
    }
    case 'setAvatar': {
      // The switch goes to the later `at`, on its clock alone, like a privacy switch. The picture's
      // version is a counter beside it (ADR 0032): every "on" the switch accepts counts it up, so
      // Refresh is a new address past every cache, whatever its `at` (two clicks in a millisecond,
      // a device whose clock is behind). Kept apart, so a version never outruns a later "off". An
      // older "on" that arrives after an "off" is no choice at all, and leaves both alone. An "on"
      // also asks Gravatar again (ADR 0033): the check is due at once, and the push claims it.
      // SQLite reads the row as it was in every SET, so the switch tested is the one before this
      // change, and a switch never set counts as on.
      const later = sql`${at} >= gravatar_at`
      const counts = m.gravatar ? sql`(${later} or ${gravatarOn('profiles')})` : sql`false`
      return [
        db.run(sql`
          update profiles set
            gravatar = case when ${later} then ${m.gravatar ? 1 : 0} else gravatar end,
            gravatar_at = case when ${later} then ${at} else gravatar_at end,
            avatar_version = case when ${counts} then avatar_version + 1 else avatar_version end,
            gravatar_checked_at = case when ${counts} then null else gravatar_checked_at end,
            updated_at = ${now}, seq = ${currentSeq}
          where user_id = ${userId} and ${fresh}
        `),
      ]
    }
    case 'recommend':
      return [
        db.run(sql`
          insert into recommendations (user_id, article_id, note, created_at, updated_at, seq)
          select ${userId}, ${m.articleId}, ${m.note?.trim() || null}, ${at}, ${at}, ${currentSeq}
          where ${article(m.articleId)} and ${fresh}
          on conflict (user_id, article_id) do update set
            note = excluded.note, deleted_at = null, updated_at = excluded.updated_at, seq = excluded.seq
          where excluded.updated_at >= recommendations.updated_at
        `),
        recount('recommend_count', m.articleId),
      ]
    case 'unrecommend':
      return [
        db.run(sql`
          update recommendations set deleted_at = ${at}, updated_at = ${at}, seq = ${currentSeq}
          where user_id = ${userId} and article_id = ${m.articleId} and deleted_at is null
            and updated_at <= ${at} and ${fresh}
        `),
        recount('recommend_count', m.articleId),
      ]
    case 'putHighlight':
      // The id is the client's, so the update is held to this member's own live highlight: an id
      // guessed from someone else's cannot rewrite theirs, and a deleted one stays deleted.
      return [
        db.run(sql`
          insert into highlights (id, user_id, article_id, content_key, side, lang, leaf_id, start,
            "end", quote, prefix, suffix, note, created_at, updated_at, seq)
          select ${m.id}, ${userId}, ${m.articleId}, ${m.contentKey}, ${m.side}, ${m.lang},
            ${m.leafId}, ${m.start}, ${m.end}, ${m.quote}, ${m.prefix}, ${m.suffix},
            ${m.note?.trim() || null}, ${at}, ${at}, ${currentSeq}
          where ${article(m.articleId)} and ${fresh}
          on conflict (id) do update set
            content_key = excluded.content_key, side = excluded.side, lang = excluded.lang,
            leaf_id = excluded.leaf_id, start = excluded.start, "end" = excluded."end",
            quote = excluded.quote, prefix = excluded.prefix, suffix = excluded.suffix,
            note = excluded.note, updated_at = excluded.updated_at, seq = excluded.seq
          where highlights.user_id = excluded.user_id and highlights.deleted_at is null
            and excluded.updated_at >= highlights.updated_at
        `),
      ]
    case 'deleteHighlight':
      return [
        db.run(sql`
          update highlights set deleted_at = ${at}, updated_at = ${at}, seq = ${currentSeq}
          where id = ${m.id} and user_id = ${userId} and deleted_at is null and ${fresh}
        `),
      ]
    case 'follow':
      // Through the followee's profile, so nobody to follow writes nothing; and never yourself,
      // excluded here because the table's check would sink the whole push (ADR 0031). A follow
      // after an unfollow is a new follow, from now.
      return [
        db.run(sql`
          insert into follows (follower_id, followee_id, created_at, updated_at, seq)
          select ${userId}, p.user_id, ${at}, ${at}, ${currentSeq} from profiles p
          where p.user_id = ${m.userId} and p.user_id <> ${userId} and ${fresh}
          on conflict (follower_id, followee_id) do update set
            created_at = case when follows.deleted_at is null then follows.created_at
              else excluded.created_at end,
            deleted_at = null, updated_at = excluded.updated_at, seq = excluded.seq
          where excluded.updated_at >= follows.updated_at
        `),
      ]
    case 'unfollow':
      // Recorded whatever it finds, as follow is: a tombstone where there was no row, and the
      // later clock on one already deleted. Otherwise an older follow arriving after it would see
      // only the clock of an earlier unfollow, or none, and bring the follow back. On a row
      // already deleted the seq moves whatever the clocks say, so unfollowing again sends the
      // deletion again to a device that dropped it, even from a device whose clock is behind.
      return [
        db.run(sql`
          insert into follows (follower_id, followee_id, created_at, updated_at, deleted_at, seq)
          select ${userId}, p.user_id, ${at}, ${at}, ${at}, ${currentSeq} from profiles p
          where p.user_id = ${m.userId} and p.user_id <> ${userId} and ${fresh}
          on conflict (follower_id, followee_id) do update set
            deleted_at = coalesce(follows.deleted_at, excluded.deleted_at),
            updated_at = max(follows.updated_at, excluded.updated_at), seq = excluded.seq
          where excluded.updated_at >= follows.updated_at or follows.deleted_at is not null
        `),
      ]
  }
}

/**
 * Refuse what the schema cannot say: a preference value too large to sync cheaply, and a highlight
 * whose range is empty or whose quote is not as long as it.
 */
function refusal(m: Mutation): string | null {
  if (m.type === 'setPref' && JSON.stringify(m.value).length > PREF_MAX_BYTES)
    return 'pref_too_large'
  if (m.type === 'putHighlight' && (m.end <= m.start || m.quote.length !== m.end - m.start))
    return 'invalid_range'
  return null
}

/** Whether an applied mutation turned the member's Gravatar on, or asked again (Refresh). */
export function asksGravatar(raw: unknown[], applied: readonly string[]): boolean {
  return raw.some((item) => {
    const parsed = mutationSchema.safeParse(item)
    return (
      parsed.success &&
      parsed.data.type === 'setAvatar' &&
      parsed.data.gravatar &&
      applied.includes(parsed.data.mid)
    )
  })
}

export async function applyPush(
  db: TelaDb,
  userId: string,
  raw: unknown[],
  now: number,
): Promise<PushResponse> {
  const accepted: Mutation[] = []
  const rejected: PushResponse['rejected'] = []
  for (const item of raw) {
    const parsed = mutationSchema.safeParse(item)
    const mid =
      typeof (item as { mid?: unknown })?.mid === 'string' ? (item as { mid: string }).mid : null
    if (!parsed.success) {
      rejected.push({ mid, error: 'invalid' })
      continue
    }
    const refused = refusal(parsed.data)
    if (refused) rejected.push({ mid, error: refused })
    else accepted.push(parsed.data)
  }
  const statements: Statement[] = [bumpSeq(db)]
  for (const m of accepted) {
    statements.push(...statementsFor(db, userId, m, Math.min(Math.max(m.at, 0), now), now))
    statements.push(
      db.run(sql`
        insert into applied_mutations (user_id, mid, applied_at) values (${userId}, ${m.mid}, ${now})
        on conflict do nothing
      `),
    )
  }
  statements.push(
    db.all(sql`select v as seq from counters where k = 'seq'`) as unknown as Statement,
  )
  const results = (await db.batch(
    statements as unknown as Parameters<TelaDb['batch']>[0],
  )) as unknown as unknown[]
  const last = results.at(-1) as { seq: number }[] | undefined
  return { applied: accepted.map((m) => m.mid), rejected, seq: Number(last?.[0]?.seq ?? 0) }
}
