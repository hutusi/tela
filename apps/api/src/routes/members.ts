/**
 * What a signed-in member reads or sets that is not a sync mutation: their public profile (a
 * handle must be unique, so the answer matters), their blogs' settings, their author dashboard,
 * search past what their device holds, and everything they have done, as one file.
 */
import {
  avatarOf,
  BLOG_NAME,
  bumpSeq,
  consumeLimit,
  currentSeq,
  emailAllowed,
  first,
  gravatarOn,
  restampTranslations,
  standingOk,
} from '@tela/data'
import { isTopic, isValidHandle } from '@tela/shared'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { ApiEnv } from '../app'
import { search } from '../core/public'
import type { ApiDeps } from '../deps'
import { DAY } from './public-sql'

export { likePattern } from '../core/public'

export function memberRoutes(deps: ApiDeps) {
  const { db } = deps
  const routes = new Hono<ApiEnv>()

  routes.put('/profile', async (c) => {
    const member = c.get('member')
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const sets: ReturnType<typeof sql>[] = []
    let handle: string | undefined
    if (body.handle !== undefined) {
      handle = String(body.handle).trim().toLowerCase()
      if (!isValidHandle(handle)) return c.json({ error: 'invalid_handle' }, 400)
      sets.push(sql`handle = ${handle}`)
    }
    if (body.displayName !== undefined) {
      const v = typeof body.displayName === 'string' ? body.displayName.trim().slice(0, 80) : ''
      sets.push(sql`display_name = ${v || null}`)
    }
    if (body.bio !== undefined) {
      const v = typeof body.bio === 'string' ? body.bio.trim().slice(0, 280) : ''
      sets.push(sql`bio = ${v || null}`)
    }
    const now = deps.clock.now()
    // The privacy switches are `setPrivacy` mutations now (ADR 0031). A shell from before them
    // still sends its form's `publicSubscriptions` with every save, as the form loaded it, so it
    // may only hide: a stale form never makes public what the member hid since. A hide here is a
    // hide like any other (issue #16): it counts the version up, so a show another device made
    // against the version before it is refused.
    if (body.publicSubscriptions === false) {
      sets.push(sql`public_subscriptions = 0,
        public_subscriptions_at = max(public_subscriptions_at, ${now}),
        public_subscriptions_version = public_subscriptions_version + 1`)
    }
    if (sets.length === 0) return c.json({ ok: true })
    // Taken handles are refused in the statement itself, so two members racing for one cannot
    // both win and neither sees a constraint error.
    const [, updated] = (await db.batch([
      bumpSeq(db),
      db.all(sql`
        update profiles set ${sql.join(sets, sql`, `)}, updated_at = ${now}, seq = ${currentSeq}
        where user_id = ${member.id}
          ${handle === undefined ? sql`` : sql`and not exists (select 1 from profiles p2 where p2.handle = ${handle} and p2.user_id <> ${member.id})`}
        returning handle
      `),
    ] as never)) as unknown as [unknown, { handle: string }[]]
    if (updated.length === 0) return c.json({ error: 'handle_taken' }, 409)
    return c.json({ ok: true, handle: updated[0]?.handle })
  })

  /** Settings only the member who claimed a blog may change. Both sync to every subscriber. */
  const ownSite = (siteId: number, userId: string) =>
    first<{ id: number }>(
      db,
      sql`select id from sites where id = ${siteId} and claimed_by = ${userId}`,
    )

  routes.put('/sites/:siteId/topics', async (c) => {
    const siteId = Number(c.req.param('siteId'))
    if (!Number.isInteger(siteId) || !(await ownSite(siteId, c.get('member').id))) {
      return c.json({ error: 'not_owner' }, 403)
    }
    const body = (await c.req.json().catch(() => ({}))) as { topics?: unknown }
    const topics = Array.isArray(body.topics) ? [...new Set(body.topics.filter(isTopic))] : []
    const now = deps.clock.now()
    await db.batch([
      bumpSeq(db),
      db.run(sql`delete from site_topics where site_id = ${siteId}`),
      ...(topics.length > 0
        ? [
            db.run(sql`
              insert into site_topics (site_id, topic)
              select ${siteId}, value from json_each(${JSON.stringify(topics)}) where true
            `),
          ]
        : []),
      db.run(sql`update sites set updated_at = ${now}, seq = ${currentSeq} where id = ${siteId}`),
    ] as never)
    return c.json({ topics })
  })

  routes.put('/sites/:siteId/translation', async (c) => {
    const siteId = Number(c.req.param('siteId'))
    if (!Number.isInteger(siteId) || !(await ownSite(siteId, c.get('member').id))) {
      return c.json({ error: 'not_owner' }, 403)
    }
    const body = (await c.req.json().catch(() => ({}))) as { optOut?: unknown }
    const optOut = body.optOut === true
    const [, before] = (await db.batch([
      bumpSeq(db),
      db.all(sql`select translation_opt_out as was from sites where id = ${siteId}`),
      db.run(sql`
        update sites set translation_opt_out = ${optOut ? 1 : 0}, updated_at = ${deps.clock.now()},
          seq = ${currentSeq}
        where id = ${siteId}
      `),
    ] as never)) as unknown as [unknown, { was: number }[]]
    // Turned back on: apps were sent none of its translations while it said no (ADR 0065), so
    // they are stamped again, now the switch has committed.
    if (!optOut && before[0]?.was === 1) await restampTranslations(db, [siteId])
    return c.json({ optOut })
  })

  /**
   * "Only use what my feed provides" (ADR 0061): Tela stops fetching the blog's pages, for full
   * text and for its favicon, and reads only its feeds. A post already waiting for its page waits
   * no more: it is the feed's, as a post from a full feed is. What was extracted before stays.
   */
  routes.put('/sites/:siteId/feed-only', async (c) => {
    const siteId = Number(c.req.param('siteId'))
    if (!Number.isInteger(siteId) || !(await ownSite(siteId, c.get('member').id))) {
      return c.json({ error: 'not_owner' }, 403)
    }
    const body = (await c.req.json().catch(() => ({}))) as { feedOnly?: unknown }
    const feedOnly = body.feedOnly === true
    await db.batch([
      bumpSeq(db),
      db.run(sql`
        update sites set feed_only = ${feedOnly ? 1 : 0}, updated_at = ${deps.clock.now()},
          seq = ${currentSeq}
        where id = ${siteId}
      `),
      ...(feedOnly
        ? [
            db.run(sql`
              update articles set extract_state = 'none', seq = ${currentSeq}
              where extract_state = 'due'
                and feed_id in (select id from feeds where site_id = ${siteId})
            `),
          ]
        : []),
    ] as never)
    return c.json({ feedOnly })
  })

  /**
   * A blogger's view of their blogs: readers, recent posts and how they landed, and notes. The
   * totals are the whole blog's, every post and every live like, recommendation and note, not the
   * twenty posts listed: the notes below them cover every post, and a total of the twenty could
   * say "0 with a note" over a note.
   */
  routes.get('/dashboard', async (c) => {
    const member = c.get('member')
    const since = deps.clock.now() - 30 * DAY
    // New readers are the same population as `reader_count` (`recountReaders`): distinct members
    // with a live subscription to any of the blog's feeds, merged ones included. A member is new
    // when none of their live subscriptions to it is older than 30 days, so subscribing to a
    // second feed of a blog they already read does not count them twice. A resubscribe keeps
    // its row's `created_at`, so leaving and coming back is not new either.
    const [sites, topics, posts, notes, totals] = (await db.batch([
      db.all(sql`
        select id, title, home_url as "homeUrl", favicon_key as "faviconKey", listing,
          primary_lang as "primaryLang", reader_count as "readerCount",
          translation_opt_out as "translationOptOut", feed_only as "feedOnly",
          (select count(distinct sub.user_id) from subscriptions sub
            join feeds f on f.id = sub.feed_id
            where f.site_id = sites.id and sub.deleted_at is null and sub.created_at > ${since}
              and not exists (
                select 1 from subscriptions sub2 join feeds f2 on f2.id = sub2.feed_id
                where f2.site_id = sites.id and sub2.user_id = sub.user_id
                  and sub2.deleted_at is null and sub2.created_at <= ${since}
              )
          ) as "newReaders30d"
        from sites where claimed_by = ${member.id} order by title
      `),
      db.all(sql`
        select t.site_id as "siteId", t.topic from site_topics t join sites s on s.id = t.site_id
        where s.claimed_by = ${member.id} order by t.topic
      `),
      db.all(sql`
        select * from (
          select a.id, f.site_id as "siteId", a.title, a.url, a.published_at as "publishedAt",
            a.like_count as "likeCount", a.recommend_count as "recommendCount",
            (select count(*) from recommendations r
              where r.article_id = a.id and r.deleted_at is null and r.note is not null
            ) as "noteCount",
            row_number() over (partition by f.site_id order by a.sort_at desc, a.id desc) as n
          from articles a join feeds f on f.id = a.feed_id join sites s on s.id = f.site_id
          where s.claimed_by = ${member.id}
        ) where n <= 20
      `),
      // The newest twenty of each blog, not of all of them together: a cap shared across blogs
      // let one busy blog's notes crowd out another's, whose section then said it had none
      // under a tile that counted some.
      db.all(sql`
        select * from (
          select r.note, r.created_at as "createdAt", f.site_id as "siteId", a.id as "articleId",
            a.title as "articleTitle", a.url as "articleUrl", p.handle,
            p.display_name as "displayName", ${avatarOf('p')} as "avatar",
            row_number() over (
              partition by f.site_id order by r.created_at desc, r.article_id desc
            ) as n
          from recommendations r join articles a on a.id = r.article_id
          join feeds f on f.id = a.feed_id join sites s on s.id = f.site_id
          join profiles p on p.user_id = r.user_id
          where s.claimed_by = ${member.id} and r.deleted_at is null and r.note is not null
            and ${standingOk('p')}
        ) where n <= 20 order by "createdAt" desc
      `),
      // The counters are live counts (`recount` in sync/push.ts), as the posts' columns are.
      db.all(sql`
        select f.site_id as "siteId", count(*) as "posts",
          coalesce(sum(a.like_count), 0) as "likes",
          coalesce(sum(a.recommend_count), 0) as "recommendations",
          (select count(*) from recommendations r join articles a2 on a2.id = r.article_id
            join feeds f2 on f2.id = a2.feed_id join profiles p2 on p2.user_id = r.user_id
            where f2.site_id = f.site_id and r.deleted_at is null and r.note is not null
              and ${standingOk('p2')}
          ) as "notes"
        from articles a join feeds f on f.id = a.feed_id join sites s on s.id = f.site_id
        where s.claimed_by = ${member.id}
        group by f.site_id
      `),
    ] as never)) as unknown as [
      Record<string, unknown>[],
      { siteId: number; topic: string }[],
      Record<string, unknown>[],
      Record<string, unknown>[],
      { siteId: number; posts: number; likes: number; recommendations: number; notes: number }[],
    ]
    // A blog with no posts yet has no row to group.
    const totalsOf = (siteId: unknown) => {
      const { siteId: _s, ...total } = totals.find((t) => t.siteId === siteId) ?? {
        siteId,
        posts: 0,
        likes: 0,
        recommendations: 0,
        notes: 0,
      }
      return total
    }
    return c.json({
      sites: sites.map((s) => ({
        ...s,
        translationOptOut: s.translationOptOut === 1,
        feedOnly: s.feedOnly === 1,
        topics: topics.filter((t) => t.siteId === s.id).map((t) => t.topic),
        totals: totalsOf(s.id),
        posts: posts.filter((p) => p.siteId === s.id).map(({ n: _n, siteId: _s, ...p }) => p),
      })),
      notes: notes.map(({ n: _n, ...note }) => note),
    })
  })

  /**
   * "Your data": what the member did, as one JSON file. Their own rows only; of anyone they
   * follow, only what a public profile already says. Since ADR 0058 also the blogs they claimed,
   * their invite codes and who joined by each (by handle, never an address), the invitation they
   * joined by, what they read, and their picture's address: what leaving would take with it.
   */
  routes.get('/export', async (c) => {
    const member = c.get('member')
    const now = deps.clock.now()
    if (!(await consumeLimit(db, 'export', member.id, now)).allowed) {
      return c.json({ error: 'rate_limited' }, 429)
    }
    const id = member.id
    const post = sql`a.url, a.title, s.home_url as "blog"`
    const on = (articleId: ReturnType<typeof sql>) => sql`join articles a on a.id = ${articleId}
      join feeds f on f.id = a.feed_id join sites s on s.id = f.site_id`
    const [
      profiles,
      prefs,
      subscriptions,
      folders,
      likes,
      recommendations,
      highlights,
      following,
      blogrolls,
      claims,
      codes,
      joinedBy,
      reads,
      apps,
      registered,
    ] = (await db.batch([
      db.all(sql`
        select p.handle, p.display_name as "displayName", p.bio, p.reading_lang as "readingLang",
          p.ui_locale as "uiLocale", p.public_subscriptions as "publicSubscriptions",
          p.public_likes as "publicLikes", ${gravatarOn('p')} as "showsGravatar",
          (p.avatar_key is not null) as "pictureUploaded", ${avatarOf('p')} as "picture",
          p.created_at as "memberSince"
        from profiles p where p.user_id = ${id}
      `),
      db.all(
        sql`select key, value_json as "valueJson" from user_prefs where user_id = ${id} order by key`,
      ),
      db.all(sql`
        select f.feed_url as "feedUrl", s.home_url as "blog", s.title, fo.name as "folder",
          sub.created_at as "since",
          (select a.url from articles a where a.id = sub.watermark_id) as "readUpTo"
        from subscriptions sub join feeds f on f.id = sub.feed_id join sites s on s.id = f.site_id
          left join feed_folders ff on ff.user_id = sub.user_id and ff.feed_id = sub.feed_id
          left join folders fo on fo.id = ff.folder_id and fo.deleted_at is null
        where sub.user_id = ${id} and sub.deleted_at is null order by s.title
      `),
      db.all(sql`
        select name, created_at as "createdAt" from folders
        where user_id = ${id} and deleted_at is null order by name
      `),
      db.all(sql`
        select ${post}, st.liked_at as "likedAt" from user_article_states st ${on(sql`st.article_id`)}
        where st.user_id = ${id} and st.liked_at is not null order by st.liked_at desc
      `),
      db.all(sql`
        select ${post}, r.note, r.created_at as "recommendedAt"
        from recommendations r ${on(sql`r.article_id`)}
        where r.user_id = ${id} and r.deleted_at is null order by r.created_at desc
      `),
      db.all(sql`
        select ${post}, h.quote, h.note, h.side, h.lang, h.created_at as "createdAt"
        from highlights h ${on(sql`h.article_id`)}
        where h.user_id = ${id} and h.deleted_at is null order by h.created_at desc
      `),
      // Only those in good standing (ADR 0059), as their Following and their device show them.
      db.all(sql`
        select p.handle, p.display_name as "displayName", fo.created_at as "since"
        from follows fo join profiles p on p.user_id = fo.followee_id
        where fo.follower_id = ${id} and fo.deleted_at is null and ${standingOk('p')}
        order by p.handle
      `),
      // Every blogroll they keep (ADR 0050), private ones too, with the blogs in it now and
      // their notes: blogs the operator hid from others are still theirs.
      db.all(sql`
        select r.id, r.name, r.description, r.is_public as "isPublic", r.created_at as "createdAt",
          (select json_group_array(json_object('title', x.title, 'homeUrl', x.home_url,
              'feedUrl', x.feed_url, 'note', x.note, 'addedAt', x.added_at))
            from (
              select ${BLOG_NAME} as title, s.home_url, f.feed_url, bb.note, bb.added_at
              from blogroll_blogs bb join feeds f on f.id = bb.feed_id
              join sites s on s.id = f.site_id
              where bb.blogroll_id = r.id and bb.removed_at is null
              order by bb.added_at, bb.feed_id
            ) x) as blogs
        from blogrolls r where r.user_id = ${id} and r.deleted_at is null
        order by r.created_at, r.id
      `),
      db.all(sql`
        select s.home_url as "blog", s.title, c.status, c.method, c.created_at as "askedAt",
          c.verified_at as "verifiedAt"
        from site_claims c join sites s on s.id = c.site_id
        where c.user_id = ${id} order by c.created_at, c.id
      `),
      // Who joined by each code, by handle: a hold's address is someone else's, never shown, and
      // a member out of good standing is a place taken with no handle.
      db.all(sql`
        select c.code, c.created_at as "createdAt", c.revoked_at as "revokedAt",
          (select json_group_array(json_object(
              'handle', case when ${standingOk('p')} then p.handle end,
              'joinedAt', r.redeemed_at))
            from invite_redemptions r join profiles p on p.user_id = r.user_id
            where r.code = c.code and r.redeemed_at is not null) as joined
        from invite_codes c where c.created_by = ${id} order by c.created_at, c.code
      `),
      db.all(sql`
        select r.code, r.redeemed_at as "joinedAt", p.handle as "invitedBy"
        from invite_redemptions r left join invite_codes c on c.code = r.code
          left join profiles p on p.user_id = c.created_by and ${standingOk('p')}
        where r.user_id = ${id} and r.settled_at is not null
        order by r.redeemed_at, r.id limit 1
      `),
      // What they read and marked unread by hand. A feed's posts up to its subscription's
      // `readUpTo` are read too, whether or not a row here says so (ADR 0009).
      db.all(sql`
        select ${post}, st.read_at as "readAt",
          (st.read_at is null and st.read_updated_at is not null) as "markedUnread"
        from user_article_states st ${on(sql`st.article_id`)}
        where st.user_id = ${id} and (st.read_at is not null or st.read_updated_at is not null)
        order by coalesce(st.read_at, st.read_updated_at) desc, st.article_id
      `),
      // The apps they connected and still hold (ADR 0064): what each may do and when it last
      // acted for them, and whether it sees their address as `/v1/me` would answer it now
      // (`emailAllowed`, ADR 0067). Never a token, which Tela keeps only as a hash.
      db.all(sql`
        select a.name as "app", a.developer, a.homepage_url as "homepage", g.scope,
          (g.email = 1 and ${emailAllowed('a')}) as "seesEmail", g.created_at as "connectedAt",
          g.last_used_at as "lastUsedAt"
        from app_grants g join apps a on a.id = g.app_id
        where g.user_id = ${id} and g.ended_at is null order by g.created_at, g.id
      `),
      // The apps they registered in Settings → Developer (ADR 0067), as Tela keeps them: the
      // contact address and the review request included, which the Privacy page names.
      db.all(sql`
        select a.client_id as "clientId", a.name, a.developer, a.contact_email as "contactEmail",
          a.homepage_url as "homepage", a.privacy_url as "privacyPolicy",
          a.redirect_uris as "redirectUris", a.max_scope as "maxScope", a.status,
          (a.reviewed_at is not null) as "reviewed", a.review_requested_at as "reviewRequestedAt",
          a.review_note as "reviewNote", a.terms_at as "rulesAcceptedAt",
          a.created_at as "registeredAt"
        from apps a where a.developer_id = ${id} order by a.created_at, a.id
      `),
    ] as never)) as unknown as Record<string, unknown>[][]
    const profile = profiles?.[0]
    const body = {
      exportedAt: new Date(now).toISOString(),
      email: member.email,
      profile: profile
        ? {
            ...profile,
            publicSubscriptions: profile.publicSubscriptions === 1,
            publicLikes: profile.publicLikes === 1,
            showsGravatar: profile.showsGravatar === 1,
            pictureUploaded: profile.pictureUploaded === 1,
            // Where anyone sees it, whole, rather than the path the app asks for.
            picture:
              typeof profile.picture === 'string'
                ? `${deps.config.publicUrl}${profile.picture}`
                : null,
          }
        : null,
      prefs: (prefs ?? []).map((p) => ({ key: p.key, value: JSON.parse(String(p.valueJson)) })),
      subscriptions,
      folders,
      likes,
      recommendations,
      highlights,
      following,
      blogrolls: (blogrolls ?? []).map(({ isPublic, blogs, ...blogroll }) => ({
        ...blogroll,
        isPublic: isPublic === 1,
        blogs: JSON.parse(String(blogs ?? '[]')),
      })),
      claims,
      inviteCodes: (codes ?? []).map(({ joined, ...code }) => ({
        ...code,
        joined: JSON.parse(String(joined ?? '[]')),
      })),
      joinedBy: joinedBy?.[0] ?? null,
      reads: (reads ?? []).map(({ markedUnread, ...read }) => ({
        ...read,
        markedUnread: markedUnread === 1,
      })),
      connectedApps: (apps ?? []).map(({ seesEmail, ...app }) => ({
        ...app,
        seesEmail: seesEmail === 1,
      })),
      registeredApps: (registered ?? []).map(({ redirectUris, reviewed, status, ...app }) => ({
        ...app,
        // Members read Testing, Live and Cut off; the stored names stay (ADR 0067).
        status: status === 'draft' ? 'testing' : status === 'approved' ? 'live' : 'cutOff',
        reviewed: reviewed === 1,
        redirectUris: JSON.parse(String(redirectUris ?? '[]')),
      })),
    }
    return new Response(JSON.stringify(body, null, 2), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="tela-${profile?.handle ?? 'export'}.json"`,
        'cache-control': 'no-store',
      },
    })
  })

  /**
   * Search past the horizon the device holds: articles of the member's feeds by title in either
   * language, and blogs anyone can find plus the member's own private ones (`search`, which the
   * API shares). The device searches what it holds first; this fills in the rest.
   */
  routes.get('/search', async (c) => {
    const { sites, articles } = await search(
      deps,
      { userId: c.get('member').id },
      { q: c.req.query('q') ?? '', lang: c.req.query('lang') },
    )
    // The web's answer as it was: the hit's blog is the device's to find by its feed.
    return c.json({ sites, articles: articles.map(({ siteId: _, ...article }) => article) })
  })

  return routes
}
