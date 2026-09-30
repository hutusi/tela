import { env } from 'cloudflare:test'
import { d1Db } from '@tela/platform/cloudflare'
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { dataContract, type TestApi } from '../../src/contract'
import type { TelaDb } from '../../src/db'
import * as schema from '../../src/schema'

/** Children before parents, so foreign keys never object; then reset the AUTOINCREMENT counters. */
const TABLES = [
  'highlights',
  'recommendations',
  'user_article_states',
  'subscriptions',
  'article_titles',
  'article_versions',
  'body_translations',
  'llm_calls',
  'articles',
  'websub_subscriptions',
  'site_claims',
  'site_topics',
  'feeds',
  'sites',
  'user_prefs',
  'profiles',
  'session',
  'account',
  'verification',
  'rate_limit',
  'user',
  'leases',
  'lease_fence',
  'dead_letters',
  'action_limits',
  'applied_mutations',
  'tombstones',
  'ops_heartbeats',
  'counters',
  'block_translations',
  'usage_daily',
]

async function freshDb(): Promise<TelaDb> {
  const db = d1Db(env.DB, schema)
  await db.batch([
    db.run(sql`select 1`),
    ...TABLES.map((t) => db.run(sql.raw(`delete from "${t}"`))),
    db.run(sql`delete from sqlite_sequence`),
  ])
  return db
}

dataContract({ describe, it, expect } as unknown as TestApi, freshDb)
