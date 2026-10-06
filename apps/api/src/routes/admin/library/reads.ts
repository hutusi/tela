/**
 * The library's ledgers and records: Claims, Sites, Feeds and Discover (ADR 0039). A ledger is
 * one batch, so its counts and its rows come from one snapshot: every filter's size under the
 * search, and the filter's rows up to the limit. A record is one batch too, with the history an
 * operator left read after it (the log only grows, so a moment's difference shows one entry more).
 */
import { DISCOVER_REVIEW, historyOf, type TelaDb } from '@tela/data'
import {
  ADMIN_FILTERS,
  ADMIN_LIST_LIMIT,
  type AdminClaimDetail,
  type AdminFeedDetail,
  type AdminFilter,
  type AdminList,
  type AdminSiteDetail,
  isAdminFilter,
  type LedgerArea,
} from '@tela/shared/admin'
import { type SQL, sql } from 'drizzle-orm'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { ApiDeps } from '../../../deps'
import { type AdminEnv, runBatch } from '../framework'
import { idOf, likePattern } from './common'
import {
  CLAIM_SELECT,
  type ClaimRaw,
  claimMatches,
  claimRow,
  FEED_SELECT,
  type FeedRaw,
  feedMatches,
  feedRow,
  NEEDS_REVIEW,
  RELAY_SELECT,
  relayOf,
  SITE_ATTENTION,
  type SiteRaw,
  siteMatches,
  siteRow,
  siteSelect,
} from './rows'

const DAY = 24 * 3600 * 1000
/** The longest search kept: past this, a search is a paste, not a name. */
const MAX_QUERY = 200

const SITE_FILTERS: Record<AdminFilter<'sites'>, SQL> = {
  discover: sql`s.listing in ('listed', 'featured')`,
  private: sql`s.listing = 'private'`,
  attention: SITE_ATTENTION,
  hidden: sql`s.listing = 'rejected'`,
}

/**
 * Discover's filters. To review (`candidates`) is the queue of blogs members added (ADR 0041);
 * Not for Discover (`dismissed`) the ones an operator decided against, which three readers can
 * still list. A private blog that waits for nothing (unread, unfetched) is the Sites ledger's.
 */
const DISCOVER_FILTERS: Record<AdminFilter<'discover'>, SQL> = {
  candidates: DISCOVER_REVIEW,
  featured: sql`s.listing = 'featured'`,
  listed: sql`s.listing = 'listed'`,
  dismissed: sql`s.listing = 'private' and s.claimed_by is null and s.reviewed_at is not null`,
  hidden: sql`s.listing = 'rejected'`,
}

const CLAIM_FILTERS: Record<AdminFilter<'claims'>, SQL> = {
  review: NEEDS_REVIEW,
  checking: sql`c.status = 'pending'`,
  verified: sql`c.status = 'verified'`,
}

const FEED_FILTERS: Record<AdminFilter<'feeds'>, SQL> = {
  failing: sql`f.status = 'active' and f.error_count > 0 and f.timeout_streak < 3`,
  timeout: sql`f.status = 'active' and f.timeout_streak >= 3`,
  dead: sql`f.status = 'dead'`,
  paused: sql`f.status = 'paused' and f.merged_into is null`,
  merged: sql`f.merged_into is not null`,
  // Fetching as it should: the feeds an operator pauses when a writer asks to leave.
  fetching: sql`f.status = 'active' and f.error_count = 0 and f.timeout_streak < 3
    and f.merged_into is null`,
}

/** One count per filter, in one row, over `from` narrowed by the search. */
function countsOf(filters: Record<string, SQL>, from: SQL, matches: SQL): SQL {
  const columns = Object.entries(filters).map(
    ([name, where]) =>
      sql`coalesce(sum(case when ${where} then 1 else 0 end), 0) as ${sql.raw(`"${name}"`)}`,
  )
  return sql`select ${sql.join(columns, sql`, `)} ${from} where ${matches}`
}

/** A request's filter and search, or null for a filter the area does not have. */
function ledgerQuery<A extends LedgerArea>(
  c: Context<AdminEnv>,
  area: A,
): { filter: AdminFilter<A>; pattern: string | null } | null {
  const given = c.req.query('f')
  const filter = given === undefined ? ADMIN_FILTERS[area][0] : given
  if (!isAdminFilter(area, filter)) return null
  const q = (c.req.query('q') ?? '').trim().slice(0, MAX_QUERY)
  return { filter, pattern: q ? likePattern(q) : null }
}

/** A ledger's answer from its batch: the counts row, and one row past the limit to say so. */
function listOf<R, A extends LedgerArea>(counts: unknown, rows: R[]): AdminList<R, A> {
  return {
    counts: ((counts as Record<string, number>[])[0] ?? {}) as AdminList<R, A>['counts'],
    rows: rows.slice(0, ADMIN_LIST_LIMIT),
    truncated: rows.length > ADMIN_LIST_LIMIT,
  }
}

const OVER_LIMIT = sql.raw(`limit ${ADMIN_LIST_LIMIT + 1}`)
const SITES_FROM = sql`from sites s left join profiles op on op.user_id = s.claimed_by`

async function siteLedger<A extends 'sites' | 'discover'>(
  db: TelaDb,
  area: A,
  filters: Record<AdminFilter<A>, SQL>,
  filter: AdminFilter<A>,
  pattern: string | null,
  now: number,
): Promise<AdminList<ReturnType<typeof siteRow>, A>> {
  const matches = siteMatches(pattern)
  const [counts, rows] = await runBatch(db, [
    db.all(countsOf(filters, SITES_FROM, matches)),
    db.all(sql`
      ${siteSelect(now - 30 * DAY)} where ${filters[filter]} and ${matches}
      order by s.reader_count desc, s.id desc ${OVER_LIMIT}
    `),
  ])
  return listOf(
    counts,
    (rows as SiteRaw[]).map((raw) => siteRow(raw, area)),
  )
}

export function libraryReads(deps: ApiDeps) {
  const { db } = deps
  const routes = new Hono<AdminEnv>()

  routes.get('/claims', async (c) => {
    const query = ledgerQuery(c, 'claims')
    if (!query) return c.json({ error: 'invalid' }, 400)
    const matches = claimMatches(query.pattern)
    const from = sql`from site_claims c join sites s on s.id = c.site_id
      left join profiles cp on cp.user_id = c.user_id
      left join profiles op on op.user_id = s.claimed_by and s.claimed_by <> c.user_id`
    const [counts, rows] = await runBatch(db, [
      db.all(countsOf(CLAIM_FILTERS, from, matches)),
      db.all(sql`
        ${CLAIM_SELECT} where ${CLAIM_FILTERS[query.filter]} and ${matches}
        order by coalesce(c.last_checked_at, c.created_at) desc, c.id desc ${OVER_LIMIT}
      `),
    ])
    const now = deps.clock.now()
    return c.json(
      listOf(
        counts,
        (rows as ClaimRaw[]).map((raw) => claimRow(raw, now)),
      ),
    )
  })

  routes.get('/claims/:id', async (c) => {
    const id = idOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'not_found' }, 404)
    const [rows] = await runBatch(db, [db.all(sql`${CLAIM_SELECT} where c.id = ${id}`)])
    const raw = (rows as ClaimRaw[])[0]
    if (!raw) return c.json({ error: 'not_found' }, 404)
    const detail: AdminClaimDetail = {
      claim: claimRow(raw, deps.clock.now()),
      tokenHead: raw.token_head,
      history: await historyOf(db, 'claim', String(id)),
    }
    return c.json(detail)
  })

  routes.get('/sites', async (c) => {
    const query = ledgerQuery(c, 'sites')
    if (!query) return c.json({ error: 'invalid' }, 400)
    const now = deps.clock.now()
    return c.json(await siteLedger(db, 'sites', SITE_FILTERS, query.filter, query.pattern, now))
  })

  routes.get('/discover', async (c) => {
    const query = ledgerQuery(c, 'discover')
    if (!query) return c.json({ error: 'invalid' }, 400)
    const now = deps.clock.now()
    return c.json(
      await siteLedger(db, 'discover', DISCOVER_FILTERS, query.filter, query.pattern, now),
    )
  })

  routes.get('/sites/:id', async (c) => {
    const id = idOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'not_found' }, 404)
    const now = deps.clock.now()
    const [sites, feeds, claims, tokens, relay] = await runBatch(db, [
      db.all(sql`${siteSelect(now - 30 * DAY)} where s.id = ${id}`),
      db.all(sql`${FEED_SELECT} where f.site_id = ${id}
        order by f.merged_into is not null, f.id`),
      db.all(sql`${CLAIM_SELECT} where c.site_id = ${id} order by c.created_at desc, c.id desc`),
      // Every call a feed of the blog paid for, titles and bodies alike (`llm_calls.feed_id`).
      db.all(sql`
        select coalesce(sum(input_tokens + output_tokens), 0) as tokens from llm_calls
        where feed_id in (select id from feeds where site_id = ${id})
          and created_at >= ${now - 30 * DAY}
      `),
      db.all(RELAY_SELECT),
    ])
    const raw = (sites as SiteRaw[])[0]
    if (!raw) return c.json({ error: 'not_found' }, 404)
    const withRelay = relayOf(relay)
    const detail: AdminSiteDetail = {
      site: siteRow(raw, 'sites'),
      description: raw.description,
      claimedAt: raw.claimed_at,
      feeds: (feeds as FeedRaw[]).map((f) => feedRow(f, withRelay)),
      claims: (claims as ClaimRaw[]).map((cl) => claimRow(cl, now)),
      tokens30d: (tokens as { tokens: number }[])[0]?.tokens ?? 0,
      history: await historyOf(db, 'site', String(id)),
    }
    return c.json(detail)
  })

  routes.get('/feeds', async (c) => {
    const query = ledgerQuery(c, 'feeds')
    if (!query) return c.json({ error: 'invalid' }, 400)
    const matches = feedMatches(query.pattern)
    const from = sql`from feeds f join sites s on s.id = f.site_id
      left join profiles op on op.user_id = s.claimed_by`
    const [counts, rows, relay] = await runBatch(db, [
      db.all(countsOf(FEED_FILTERS, from, matches)),
      db.all(sql`
        ${FEED_SELECT} where ${FEED_FILTERS[query.filter]} and ${matches}
        order by f.error_count desc, coalesce(f.last_fetched_at, f.created_at) desc, f.id desc
        ${OVER_LIMIT}
      `),
      db.all(RELAY_SELECT),
    ])
    const withRelay = relayOf(relay)
    return c.json(
      listOf(
        counts,
        (rows as FeedRaw[]).map((raw) => feedRow(raw, withRelay)),
      ),
    )
  })

  routes.get('/feeds/:id', async (c) => {
    const id = idOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'not_found' }, 404)
    const [rows, relay] = await runBatch(db, [
      db.all(sql`${FEED_SELECT} where f.id = ${id}`),
      db.all(RELAY_SELECT),
    ])
    const raw = (rows as FeedRaw[])[0]
    if (!raw) return c.json({ error: 'not_found' }, 404)
    const withRelay = relayOf(relay)
    const detail: AdminFeedDetail = {
      feed: feedRow(raw, withRelay),
      relay: withRelay,
      history: await historyOf(db, 'feed', String(id)),
    }
    return c.json(detail)
  })

  return routes
}
