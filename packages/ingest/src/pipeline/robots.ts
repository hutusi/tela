/**
 * Asking a blog's robots.txt before fetching one of its pages (ADR 0061): a post's page for its
 * full text, and the home page a favicon is looked for on. A feed is never checked: subscribing is
 * asking for it, as in any feed reader.
 *
 * The rules Tela obeys are kept per origin in `robots_rules` and read again once they are a day
 * old (RFC 9309 asks no more than that), or an hour, when robots.txt could not be had. Read with
 * the same client as every fetch: private ranges refused, the fetch's timeout, at most five
 * redirects, the first 500 KiB.
 *
 * - **2xx**: its rules, Tela's group or else `*`'s.
 * - **4xx, but 429**: there is no robots.txt: everything is allowed.
 * - **429, 5xx, or no answer at all** (a timeout, a refused or private address, a redirect loop):
 *   unreachable, and RFC 9309 says to assume everything is disallowed until it can be read.
 *
 * What a check learns is returned as statements for the caller's own fenced batch (invariant 6),
 * never written on the side. When the rules it read differ from the ones kept, the host's posts
 * whose extraction failed are made due again: one a robots.txt refused is retried that way once the
 * writer changes it, and the extraction asks the new rules first.
 */
import { currentSeq, first } from '@tela/data'
import type { FetchRegion } from '@tela/shared'
import { sql } from 'drizzle-orm'
import { HttpError } from '../http'
import {
  allowedBy,
  parseRobots,
  ROBOTS_MAX_BYTES,
  ROBOTS_TOKEN,
  rulesFor,
  serializeRules,
} from '../robots'
import type { IngestContext, Statement } from './context'

const HOUR = 60 * 60 * 1000
/** How long rules that were read are kept before robots.txt is asked again. */
export const ROBOTS_FRESH_MS = 24 * HOUR
/** How long an unreachable robots.txt holds pages back before it is asked again. */
export const ROBOTS_RETRY_MS = HOUR
/** A robots.txt is small: a slow one is not waited for as long as a page. */
export const ROBOTS_TIMEOUT_MS = 10_000

export type RobotsVerdict = 'allowed' | 'disallowed' | 'unreachable'

/** What a stored status means: rules to read, no file at all, or no answer. */
type Kind = 'rules' | 'none' | 'unreachable'

function kindOf(status: number): Kind {
  if (status >= 200 && status < 300) return 'rules'
  if (status >= 400 && status < 500 && status !== 429) return 'none'
  return 'unreachable'
}

export type RobotsCheck = {
  verdict: RobotsVerdict
  /** The origin whose robots.txt answered. */
  origin: string
  /** What the check learned, for the caller's fenced batch: empty when the kept rules were fresh. */
  statements: Statement[]
}

type Kept = { status: number; body: string; fetched_at: number }

function verdictOf(kept: { status: number; body: string }, url: string): RobotsVerdict {
  const kind = kindOf(kept.status)
  if (kind === 'unreachable') return 'unreachable'
  if (kind === 'none') return 'allowed'
  const match = rulesFor(parseRobots(kept.body), ROBOTS_TOKEN)
  return !match || allowedBy(match.rules, url) ? 'allowed' : 'disallowed'
}

/** The body as far as its last whole line, when the fetch cut it at the cap. */
function wholeLines(body: string, truncated: boolean | undefined): string {
  if (!truncated) return body
  const end = Math.max(body.lastIndexOf('\n'), body.lastIndexOf('\r'))
  return end < 0 ? '' : body.slice(0, end)
}

/** Fetch an origin's robots.txt: its status (0 when nothing answered) and the rules for Tela. */
async function fetchRules(
  ctx: IngestContext,
  origin: string,
  region: FetchRegion,
): Promise<{ status: number; body: string }> {
  try {
    const res = await ctx.http.get(`${origin}/robots.txt`, {
      region,
      accept: 'text/plain, */*;q=0.5',
      maxBytes: ROBOTS_MAX_BYTES,
      truncate: true,
      timeoutMs: ROBOTS_TIMEOUT_MS,
    })
    if (kindOf(res.status) !== 'rules') return { status: res.status, body: '' }
    const text = wholeLines(res.body, res.truncated)
    return { status: res.status, body: serializeRules(rulesFor(parseRobots(text), ROBOTS_TOKEN)) }
  } catch (err) {
    if (err instanceof HttpError) return { status: 0, body: '' }
    throw err
  }
}

/**
 * Whether Tela may fetch `url`, by its origin's robots.txt, and what the check learned. A URL that
 * does not parse is no page anyone may fetch.
 */
export async function checkRobots(
  ctx: IngestContext,
  url: string,
  region: FetchRegion = 'global',
): Promise<RobotsCheck> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { verdict: 'disallowed', origin: '', statements: [] }
  }
  const origin = parsed.origin
  const now = ctx.clock.now()
  const kept = await first<Kept>(
    ctx.db,
    sql`select status, body, fetched_at from robots_rules where origin = ${origin}`,
  )
  if (kept) {
    const ttl = kindOf(kept.status) === 'unreachable' ? ROBOTS_RETRY_MS : ROBOTS_FRESH_MS
    if (kept.fetched_at > now - ttl) {
      return { verdict: verdictOf(kept, url), origin, statements: [] }
    }
  }
  const read = await fetchRules(ctx, origin, region)
  const statements: Statement[] = [
    ctx.db.run(sql`
      insert into robots_rules (origin, status, body, fetched_at)
      values (${origin}, ${read.status}, ${read.body}, ${now})
      on conflict (origin) do update set status = excluded.status, body = excluded.body,
        fetched_at = excluded.fetched_at
      where excluded.fetched_at >= robots_rules.fetched_at
    `),
  ]
  // Rules that changed are the writer's answer: what they refused before is asked again, and
  // each extraction reads the new rules before it fetches. Not on the first read (nothing was
  // refused by rules Tela never had), and not when robots.txt stopped answering.
  const changed =
    kept !== undefined &&
    (kindOf(kept.status) !== kindOf(read.status) || kept.body !== read.body) &&
    kindOf(read.status) !== 'unreachable'
  if (changed) statements.push(redueRefused(ctx, parsed.hostname.toLowerCase()))
  return { verdict: verdictOf(read, url), origin, statements }
}

/**
 * Make a host's failed extractions due again, on a blog that still lets Tela fetch its pages. It
 * cannot tell a page robots.txt refused from one that failed for another reason, and retries
 * both: rules change rarely, and each retry asks the rules first.
 */
function redueRefused(ctx: IngestContext, host: string): Statement {
  return ctx.db.run(sql`
    update articles set extract_state = 'due', seq = ${currentSeq}
    where extract_state = 'failed' and url_host = ${host}
      and feed_id in (select f.id from feeds f join sites s on s.id = f.site_id
        where f.status = 'active' and s.feed_only = 0)
  `)
}
