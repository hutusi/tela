/**
 * The Translation area (ADR 0039): what translation cost over the last 30 days, in tokens, by
 * blog, by job and by model, and the day's budgets. A blog is charged through the call log's feed
 * (titles by their job's feed, bodies by the first article with their content); a title call
 * logged before the log named feeds, carrying several blogs' posts, is "unattributed".
 */
import { BACKGROUND, type TelaDb, utcDay } from '@tela/data'
import { MAX_ARTICLE_TRANSLATION_TOKENS, USER_DAILY_TRANSLATION_TOKENS } from '@tela/shared'
import {
  ADMIN_LIST_LIMIT,
  type AdminFilter,
  type AdminList,
  type AdminTranslationReport,
  type AdminTranslationRow,
  isAdminFilter,
} from '@tela/shared/admin'
import { type SQL, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { ApiDeps } from '../../../deps'
import type { AdminEnv } from '../framework'
import { runBatch } from '../framework'
import { configOf } from './system'

const DAY = 86_400_000
/** The window every Translation figure covers: thirty UTC days, today the last of them. */
export const TRANSLATION_DAYS = 30

type Row = Record<string, unknown>

/** The first instant of the window: midnight UTC, 29 days before today's. */
export const windowStart = (now: number) => (Math.floor(now / DAY) - (TRANSLATION_DAYS - 1)) * DAY

/**
 * The median latency per group, over the window: the middle call, or the mean of the two middle
 * ones. Window functions rather than a JS sort, so only one row per group comes back.
 */
function medians(db: TelaDb, group: SQL, from: SQL, since: number) {
  return db.all(sql`
    select g, avg(latency_ms) as median from (
      select ${group} as g, c.latency_ms,
        row_number() over (partition by ${group} order by c.latency_ms) as r,
        count(*) over (partition by ${group}) as n
      from ${from} where c.created_at >= ${since}
    )
    where r in ((n + 1) / 2, (n + 2) / 2)
    group by g
  `)
}

const BY_BLOG = sql`llm_calls c join feeds f on f.id = c.feed_id join sites s on s.id = f.site_id`

function targetsOf(value: unknown): string[] {
  try {
    const list = JSON.parse(String(value ?? '[]')) as unknown[]
    return list.filter((t): t is string => typeof t === 'string').sort()
  } catch {
    return []
  }
}

async function translationList(
  db: TelaDb,
  filter: AdminFilter<'translation'>,
  q: string,
  now: number,
): Promise<AdminList<AdminTranslationRow, 'translation'>> {
  const since = windowStart(now)
  const limit = ADMIN_LIST_LIMIT + 1
  const search = (text: SQL) => (q ? sql`and instr(lower(${text}), ${q.toLowerCase()}) > 0` : sql``)
  const totals = sql`count(*) as calls, sum(c.input_tokens) as input,
    sum(c.output_tokens) as output, json_group_array(distinct c.target_lang) as targets`
  const [counted, found, middle] = (await runBatch(db, [
    db.all(sql`
      select
        (select count(distinct f.site_id) from llm_calls c join feeds f on f.id = c.feed_id
          where c.created_at >= ${since}) as blogs,
        (select count(distinct job) from llm_calls where created_at >= ${since}) as jobs,
        (select count(distinct model) from llm_calls where created_at >= ${since}) as models
    `),
    filter === 'blogs'
      ? db.all(sql`
          select s.id as g, s.title, s.home_url, s.primary_lang, s.translation_opt_out, ${totals}
          from ${BY_BLOG}
          where c.created_at >= ${since}
            ${search(sql`coalesce(s.title, '') || ' ' || s.home_url`)}
          group by s.id
          order by sum(c.input_tokens + c.output_tokens) desc, s.id
          limit ${limit}
        `)
      : db.all(sql`
          select ${filter === 'jobs' ? sql`c.job` : sql`c.model`} as g, ${totals}
          from llm_calls c
          where c.created_at >= ${since}
            ${search(filter === 'jobs' ? sql`c.job` : sql`c.model`)}
          group by g
          order by sum(c.input_tokens + c.output_tokens) desc, g
          limit ${limit}
        `),
    filter === 'blogs'
      ? medians(db, sql`f.site_id`, sql`llm_calls c join feeds f on f.id = c.feed_id`, since)
      : medians(db, filter === 'jobs' ? sql`c.job` : sql`c.model`, sql`llm_calls c`, since),
  ])) as [Row[], Row[], Row[]]
  const median = new Map(middle.map((r) => [String(r.g), Math.round(Number(r.median))]))
  const counts = counted[0] ?? {}
  const rows = found.slice(0, ADMIN_LIST_LIMIT).map((r): AdminTranslationRow => {
    const base = {
      targets: targetsOf(r.targets),
      calls: Number(r.calls ?? 0),
      inputTokens: Number(r.input ?? 0),
      outputTokens: Number(r.output ?? 0),
      medianLatencyMs: median.get(String(r.g)) ?? null,
    }
    if (filter === 'blogs') {
      const optOut = Number(r.translation_opt_out) === 1
      return {
        id: String(r.g),
        actions: [optOut ? 'site.translationOn' : 'site.translationOff'],
        kind: 'blog',
        label: r.title === null || r.title === undefined ? null : String(r.title),
        siteId: Number(r.g),
        homeUrl: String(r.home_url),
        sourceLang: r.primary_lang === null ? null : String(r.primary_lang),
        translationOptOut: optOut,
        ...base,
      }
    }
    const kind = filter === 'jobs' ? 'job' : 'model'
    return {
      id: `${kind}:${String(r.g)}`,
      actions: [],
      kind,
      label: String(r.g),
      siteId: null,
      homeUrl: null,
      sourceLang: null,
      translationOptOut: false,
      ...base,
    }
  })
  return {
    counts: {
      blogs: Number(counts.blogs ?? 0),
      jobs: Number(counts.jobs ?? 0),
      models: Number(counts.models ?? 0),
    },
    rows,
    truncated: found.length > ADMIN_LIST_LIMIT,
  }
}

async function translationReport(db: TelaDb, now: number): Promise<AdminTranslationReport> {
  const since = windowStart(now)
  const today = utcDay(now)
  const weekStart = utcDay(now - 6 * DAY)
  // A member whose day has less than one article's worth left: the next article could be refused.
  const nearCap = USER_DAILY_TRANSLATION_TOKENS - MAX_ARTICLE_TRANSLATION_TOKENS
  const [days, totals, background, tick, near] = (await runBatch(db, [
    // Days as whole UTC days since the epoch: integer division, no date functions.
    db.all(sql`
      select c.created_at / 86400000 as d,
        sum(case when c.job = 'translate.title' then c.input_tokens + c.output_tokens else 0 end)
          as title,
        sum(case when c.job = 'translate.body' then c.input_tokens + c.output_tokens else 0 end)
          as body
      from llm_calls c where c.created_at >= ${since}
      group by d
    `),
    db.all(sql`
      select count(*) as calls, coalesce(sum(input_tokens), 0) as input,
        coalesce(sum(output_tokens), 0) as output,
        coalesce(sum(case when feed_id is null then input_tokens + output_tokens else 0 end), 0)
          as unattributed
      from llm_calls where created_at >= ${since}
    `),
    db.all(sql`
      select used, reserved from usage_daily where subject = ${BACKGROUND} and day = ${today}
    `),
    db.all(sql`select info from ops_heartbeats where name = 'tick'`),
    db.all(sql`
      select count(distinct u.subject) as n from usage_daily u
      where u.subject <> ${BACKGROUND} and u.day >= ${weekStart}
        and u.used + u.reserved > ${nearCap}
    `),
  ])) as [Row[], Row[], Row[], Row[], Row[]]
  const byDay = new Map(days.map((r) => [Number(r.d), r]))
  const first = Math.floor(now / DAY) - (TRANSLATION_DAYS - 1)
  let info: Record<string, unknown> | undefined
  try {
    info = JSON.parse(String(tick[0]?.info ?? '{}')) as Record<string, unknown>
  } catch {}
  const config = configOf(info)
  const total = totals[0] ?? {}
  return {
    days: Array.from({ length: TRANSLATION_DAYS }, (_, i) => {
      const row = byDay.get(first + i)
      return {
        day: utcDay((first + i) * DAY),
        title: Number(row?.title ?? 0),
        body: Number(row?.body ?? 0),
      }
    }),
    totals: {
      inputTokens: Number(total.input ?? 0),
      outputTokens: Number(total.output ?? 0),
      calls: Number(total.calls ?? 0),
    },
    unattributed: Number(total.unattributed ?? 0),
    background: {
      day: today,
      used: Number(background[0]?.used ?? 0),
      reserved: Number(background[0]?.reserved ?? 0),
      budget: config ? config.backgroundBudget : null,
    },
    memberCap: USER_DAILY_TRANSLATION_TOKENS,
    nearCap: Number(near[0]?.n ?? 0),
  }
}

export function translationRoutes(deps: ApiDeps) {
  const routes = new Hono<AdminEnv>()
  routes.get('/translation', async (c) => {
    const f = c.req.query('f') ?? 'blogs'
    if (!isAdminFilter('translation', f)) return c.json({ error: 'invalid' }, 400)
    const q = (c.req.query('q') ?? '').trim().slice(0, 100)
    return c.json(await translationList(deps.db, f, q, deps.clock.now()))
  })
  routes.get('/translation/report', async (c) =>
    c.json(await translationReport(deps.db, deps.clock.now())),
  )
  return routes
}
