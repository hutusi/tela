/**
 * Making a dead item due again (ADR 0039). A dead letter is work that ran out of attempts, and the
 * kind's `exhausted` statements marked its domain row so the sweep stops finding it. Nothing
 * retries it on its own. Background work is state, not messages (ADR 0020): a retry sends
 * nothing, it puts the row back where the kind's due query finds it, and the next tick claims it
 * with a fresh count of attempts.
 *
 * Each kind's statements are the reverse of its `exhausted` in tela-jobs' kind table, and each
 * matches the due query that kind's sweep runs. The lease row goes too, unless someone holds it:
 * a leftover backoff would keep the item from being claimed, and a held lease is work under way,
 * which a retry must not take from its holder.
 */
import { sql } from 'drizzle-orm'
import type { TelaDb } from './db'
import { utcDay } from './queries/translation'
import type { LeaseKind } from './schema/values'
import { currentSeq } from './seq'

type Statement = ReturnType<TelaDb['run']>

export type Redue = {
  /** The statements write a row readers sync: the batch starts with `bumpSeq`. */
  synced: boolean
  statements: (db: TelaDb, key: string, now: number) => Statement[]
}

const id = (key: string): number => Number(key)

/** `<contentKey>:<lang>`: a content key may hold a colon, a language never does. */
export function splitBodyKey(key: string): { contentKey: string; lang: string } {
  const split = key.lastIndexOf(':')
  return { contentKey: key.slice(0, split), lang: key.slice(split + 1) }
}

export const REDUE: Record<LeaseKind, Redue> = {
  // Exhausted pushed the next fetch a day out; due now. A paused or dead feed stays as it is:
  // the operator's pause, or the daily revival, decides those.
  'feed.fetch': {
    synced: true,
    statements: (db, key, now) => [
      db.run(sql`
        update feeds set next_fetch_at = ${now}, updated_at = ${now}, seq = ${currentSeq}
        where id = ${id(key)}
      `),
    ],
  },
  'article.extract': {
    synced: true,
    statements: (db, key) => [
      db.run(sql`
        update articles set extract_state = 'due', seq = ${currentSeq}
        where id = ${id(key)} and extract_state = 'failed'
      `),
    ],
  },
  'site.assets': {
    synced: true,
    statements: (db, key, now) => [
      db.run(sql`
        update sites set assets_checked_at = null, updated_at = ${now}, seq = ${currentSeq}
        where id = ${id(key)}
      `),
    ],
  },
  // When Gravatar was last asked is not a column devices hold, and the check itself moves `seq`
  // only when its answer changes: a retry that changes nothing a reader sees stamps nothing.
  'member.gravatar': {
    synced: false,
    statements: (db, key) => [
      db.run(sql`update profiles set gravatar_checked_at = null where user_id = ${key}`),
    ],
  },
  // A member's own re-check does the same (routes/claims.ts); an operator's vouch, if any, stays.
  'site.claim': {
    synced: true,
    statements: (db, key) => [
      db.run(sql`
        update site_claims set status = 'pending', error = null, seq = ${currentSeq}
        where id = ${id(key)} and status = 'failed'
      `),
    ],
  },
  // Not synced: the reader never sees a WebSub subscription.
  'websub.subscribe': {
    synced: false,
    statements: (db, key, now) => [
      db.run(sql`
        update websub_subscriptions set status = 'pending', requested_at = null, updated_at = ${now}
        where feed_id = ${id(key)}
      `),
    ],
  },
  // The title sweep finds an article whose current title hash has no row in some language
  // (`titleIsDue`). A failed row names the hash it failed on; emptying that makes the article due
  // again, while the row itself stays, so a device that holds it is updated rather than left with
  // a row the server no longer has.
  'translate.title': {
    synced: true,
    statements: (db, key, now) => [
      db.run(sql`
        update article_titles set source_hash = '', updated_at = ${now}, seq = ${currentSeq}
        where feed_id = ${id(key)} and status = 'failed'
      `),
    ],
  },
  // A request of nobody's: `requested_by` null is what makes the settle charge the background
  // budget (`'*'`) rather than the member who first asked, and with no reservation the job's
  // only cap is the operator's per-article ceiling (LLM_MAX_ARTICLE_TOKENS). A new request id
  // keeps the old run's chunk objects out of the new one's.
  'translate.body': {
    synced: true,
    statements: (db, key, now) => {
      const { contentKey, lang } = splitBodyKey(key)
      return [
        db.run(sql`
          update body_translations set state = 'requested', request_id = ${crypto.randomUUID()},
            requested_by = null, reserved_tokens = 0, reserved_day = ${utcDay(now)},
            used_tokens = 0, chunk_keys = '[]', object_key = null, failed_leaves = '[]',
            updated_at = ${now}, seq = ${currentSeq}
          where content_key = ${contentKey} and lang = ${lang} and state in ('failed', 'skipped')
        `),
      ]
    },
  },
}

/**
 * Everything a retry of one dead item runs: its kind's statements, and its lease row unless it is
 * held. A batch that runs them starts with `bumpSeq` when `synced` says so.
 */
export function redue(
  db: TelaDb,
  kind: LeaseKind,
  key: string,
  now: number,
): { synced: boolean; statements: Statement[] } {
  const spec = REDUE[kind]
  return {
    synced: spec.synced,
    statements: [
      ...spec.statements(db, key, now),
      db.run(sql`delete from leases where kind = ${kind} and key = ${key} and until < ${now}`),
    ],
  }
}

/** Whether a dead letter's kind is one a retry knows how to make due. */
export const isRedueKind = (kind: string): kind is LeaseKind => Object.hasOwn(REDUE, kind)
