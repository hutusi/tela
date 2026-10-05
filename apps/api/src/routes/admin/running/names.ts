/**
 * What a key names, in words an operator recognises: the feed a job's key points at, a site's
 * title, a member's handle. The System ledger links a dead letter to its feed, site, claim or
 * member, and the Overview's activity names what each action touched. Every lookup a page needs
 * is gathered first and read in one batch, one statement per kind of thing, each taking its keys
 * as a single JSON parameter.
 */
import { splitBodyKey, type TelaDb } from '@tela/data'
import type { AdminDeadRow, AdminHistoryEntry } from '@tela/shared/admin'
import { sql } from 'drizzle-orm'
import { runBatch } from '../framework'

export type Target = AdminDeadRow['target']

type Feed = { feedId: number; feedUrl: string }

/** Everything a page asked to be named, by kind. */
export type Names = {
  feeds: Map<number, Feed>
  /** An article's feed. */
  articles: Map<number, Feed>
  /** The feed of the first article with a content key. */
  contents: Map<string, Feed>
  /** A site's title, or its home page. */
  sites: Map<number, string>
  /** A claim's site's title, or its home page. */
  claims: Map<number, string>
  /** A member's handle. */
  members: Map<string, string>
  /** A dead letter's kind and key. */
  dead: Map<number, string>
}

export type Wanted = {
  feeds: Set<number>
  articles: Set<number>
  contents: Set<string>
  sites: Set<number>
  claims: Set<number>
  members: Set<string>
  dead: Set<number>
}

export function wanted(): Wanted {
  return {
    feeds: new Set(),
    articles: new Set(),
    contents: new Set(),
    sites: new Set(),
    claims: new Set(),
    members: new Set(),
    dead: new Set(),
  }
}

/** A positive integer key, or null: a key that is not one names nothing. */
export const intKey = (key: string): number | null => {
  const n = Number(key)
  return Number.isSafeInteger(n) && n > 0 && String(n) === key ? n : null
}

const add = <T>(set: Set<T>, value: T | null) => {
  if (value !== null) set.add(value)
}

/** What a background job's key names: which lookups its target needs. */
export function wantJob(w: Wanted, kind: string, key: string) {
  switch (kind) {
    case 'feed.fetch':
    case 'translate.title':
    case 'websub.subscribe':
      return add(w.feeds, intKey(key))
    case 'article.extract':
      return add(w.articles, intKey(key))
    case 'translate.body':
      return w.contents.add(splitBodyKey(key).contentKey)
    case 'site.assets':
      return add(w.sites, intKey(key))
    case 'site.claim':
      return add(w.claims, intKey(key))
    case 'member.gravatar':
      return w.members.add(key)
  }
}

/** The thing a job's key names, with a link into the ledger that holds it; null when gone. */
export function targetOf(names: Names, kind: string, key: string): Target {
  const feed = (f: Feed | undefined): Target =>
    f ? { area: 'feeds', id: String(f.feedId), label: f.feedUrl } : null
  const n = intKey(key)
  switch (kind) {
    case 'feed.fetch':
    case 'translate.title':
    case 'websub.subscribe':
      return n === null ? null : feed(names.feeds.get(n))
    case 'article.extract':
      return n === null ? null : feed(names.articles.get(n))
    case 'translate.body':
      return feed(names.contents.get(splitBodyKey(key).contentKey))
    case 'site.assets': {
      const label = n === null ? undefined : names.sites.get(n)
      return label === undefined ? null : { area: 'sites', id: key, label }
    }
    case 'site.claim': {
      const label = n === null ? undefined : names.claims.get(n)
      return label === undefined ? null : { area: 'claims', id: key, label }
    }
    case 'member.gravatar': {
      const label = names.members.get(key)
      return label === undefined ? null : { area: 'people', id: key, label }
    }
    default:
      return null
  }
}

/** What an audit row's target needs looked up. */
export function wantAudited(w: Wanted, entry: AdminHistoryEntry) {
  const key = entry.targetKey
  switch (entry.targetKind) {
    case 'site':
      return add(w.sites, intKey(key))
    case 'feed':
      return add(w.feeds, intKey(key))
    case 'claim':
      return add(w.claims, intKey(key))
    case 'member':
      return w.members.add(key)
    case 'dead':
      return add(w.dead, intKey(key))
  }
}

/**
 * An audit row's target in words: a site's title, a feed's address, the claimed site, a member's
 * handle, a code as itself, a dead letter's kind and key. Null for what has no name to show (an
 * invitation held for an address, which an audit row never names) or no longer exists.
 */
export function auditedLabel(names: Names, entry: AdminHistoryEntry): string | null {
  const key = entry.targetKey
  const n = intKey(key)
  switch (entry.targetKind) {
    case 'site':
      return (n !== null && names.sites.get(n)) || null
    case 'feed':
      return (n !== null && names.feeds.get(n)?.feedUrl) || null
    case 'claim':
      return (n !== null && names.claims.get(n)) || null
    case 'member':
      return names.members.get(key) ?? null
    case 'code':
      return key
    case 'dead':
      return (n !== null && names.dead.get(n)) || null
    case 'lease':
      return key.replace(':', ' ')
    default:
      return null
  }
}

type Row = Record<string, unknown>

/** Read every name a page wants, in one batch. */
export async function lookUp(db: TelaDb, w: Wanted): Promise<Names> {
  const names: Names = {
    feeds: new Map(),
    articles: new Map(),
    contents: new Map(),
    sites: new Map(),
    claims: new Map(),
    members: new Map(),
    dead: new Map(),
  }
  const json = (set: Set<unknown>) => JSON.stringify([...set])
  const steps: { run: () => ReturnType<TelaDb['all']>; take: (rows: Row[]) => void }[] = []
  if (w.feeds.size > 0)
    steps.push({
      run: () =>
        db.all(
          sql`select id, feed_url from feeds where id in (select value from json_each(${json(w.feeds)}))`,
        ),
      take: (rows) => {
        for (const r of rows) {
          names.feeds.set(Number(r.id), { feedId: Number(r.id), feedUrl: String(r.feed_url) })
        }
      },
    })
  if (w.articles.size > 0)
    steps.push({
      run: () =>
        db.all(sql`
          select a.id, f.id as feed_id, f.feed_url from articles a join feeds f on f.id = a.feed_id
          where a.id in (select value from json_each(${json(w.articles)}))
        `),
      take: (rows) => {
        for (const r of rows) {
          names.articles.set(Number(r.id), {
            feedId: Number(r.feed_id),
            feedUrl: String(r.feed_url),
          })
        }
      },
    })
  if (w.contents.size > 0)
    steps.push({
      // The first article with the content, as the call log attributes a body.
      run: () =>
        db.all(sql`
          select a.content_key, f.id as feed_id, f.feed_url
          from articles a join feeds f on f.id = a.feed_id
          where a.id in (
            select min(id) from articles
            where content_key in (select value from json_each(${json(w.contents)}))
            group by content_key
          )
        `),
      take: (rows) => {
        for (const r of rows) {
          names.contents.set(String(r.content_key), {
            feedId: Number(r.feed_id),
            feedUrl: String(r.feed_url),
          })
        }
      },
    })
  if (w.sites.size > 0)
    steps.push({
      run: () =>
        db.all(sql`
          select id, coalesce(title, home_url) as label from sites
          where id in (select value from json_each(${json(w.sites)}))
        `),
      take: (rows) => {
        for (const r of rows) names.sites.set(Number(r.id), String(r.label))
      },
    })
  if (w.claims.size > 0)
    steps.push({
      run: () =>
        db.all(sql`
          select c.id, coalesce(s.title, s.home_url) as label
          from site_claims c join sites s on s.id = c.site_id
          where c.id in (select value from json_each(${json(w.claims)}))
        `),
      take: (rows) => {
        for (const r of rows) names.claims.set(Number(r.id), String(r.label))
      },
    })
  if (w.members.size > 0)
    steps.push({
      run: () =>
        db.all(sql`
          select user_id, handle from profiles
          where user_id in (select value from json_each(${json(w.members)}))
        `),
      take: (rows) => {
        for (const r of rows) names.members.set(String(r.user_id), String(r.handle))
      },
    })
  if (w.dead.size > 0)
    steps.push({
      run: () =>
        db.all(sql`
          select id, kind || ' ' || key as label from dead_letters
          where id in (select value from json_each(${json(w.dead)}))
        `),
      take: (rows) => {
        for (const r of rows) names.dead.set(Number(r.id), String(r.label))
      },
    })
  const results = await runBatch(
    db,
    steps.map((s) => s.run()),
  )
  for (const [i, step] of steps.entries()) step.take((results[i] ?? []) as Row[])
  return names
}
