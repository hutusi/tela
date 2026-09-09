import type { Db } from '@tela/db'
import { createJobSender } from '@tela/db/queue'
import type { FetchFeedOptions } from '@tela/ingest'
import { READING_LANGUAGES } from '@tela/shared'
import { sql } from 'drizzle-orm'
import { QUEUES } from './queues'

/** Ceiling on articles per fetch that get eager title jobs. */
export const TITLE_JOBS_PER_FETCH = 100

export const DEFAULT_TITLE_REPAIR_LIMIT = 500
export const MAX_TITLE_REPAIR_LIMIT = 5_000

/** Whether the pg-boss schema and translate.title queue are ready to accept work. */
export async function titleQueueAvailable(db: Db): Promise<boolean> {
  const [table] = await db.execute<{ queue_table: string | null }>(
    sql`select to_regclass('pgboss.queue')::text as queue_table`,
  )
  if (!table?.queue_table) return false
  const rows = await db.execute<{ name: string }>(
    sql`select name from pgboss.queue where name = ${QUEUES.translateTitle}`,
  )
  return rows.length > 0
}

/**
 * Title/excerpt translation into every reading language the article is not in, queued through
 * the article's own transaction so the jobs commit with it. The newest feed items arrive first,
 * and the cap bounds the eager provider work created by one fetch.
 */
export function titleEnqueuer(counters: {
  articles: number
  jobs: number
}): NonNullable<FetchFeedOptions['onArticleStored']> {
  return async (tx, article) => {
    if (counters.articles >= TITLE_JOBS_PER_FETCH) return
    counters.articles += 1
    const sender = createJobSender(tx)
    for (const target of READING_LANGUAGES) {
      if (article.sourceLang === target) continue
      const id = await sender.send(
        QUEUES.translateTitle,
        { articleId: article.id, targetLang: target },
        { singletonKey: `${article.id}:${target}`, priority: 5 },
      )
      if (id) counters.jobs += 1
    }
  }
}

export type RepairTitleJobsResult = {
  selected: number
  enqueued: number
  alreadyQueued: number
}

/** Queue a bounded, newest-first batch of title translations that never landed. */
export async function repairMissingTitleJobs(
  db: Db,
  limit = DEFAULT_TITLE_REPAIR_LIMIT,
): Promise<RepairTitleJobsResult> {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TITLE_REPAIR_LIMIT) {
    throw new Error(`title repair limit must be an integer from 1 to ${MAX_TITLE_REPAIR_LIMIT}`)
  }
  if (!(await titleQueueAvailable(db))) {
    throw new Error(`queue ${QUEUES.translateTitle} is unavailable; start the worker to create it`)
  }

  const targetRows = sql.join(
    READING_LANGUAGES.map((target) => sql`(${target})`),
    sql`, `,
  )
  const candidates = await db.execute<{ article_id: string | number; target_lang: string }>(sql`
    select a.id as article_id, target.lang as target_lang
    from articles a
    join feeds f on f.id = a.feed_id
    join sites s on s.id = f.site_id
    cross join (values ${targetRows}) as target(lang)
    left join article_translations t
      on t.article_id = a.id and t.target_lang = target.lang
    where a.source_lang is distinct from target.lang
      and not s.translation_opt_out
      and t.title is null
    order by coalesce(a.published_at, a.fetched_at) desc, a.id desc, target.lang
    limit ${limit}
  `)

  const sender = createJobSender(db)
  let enqueued = 0
  for (const row of candidates) {
    const articleId = Number(row.article_id)
    const id = await sender.send(
      QUEUES.translateTitle,
      { articleId, targetLang: row.target_lang },
      { singletonKey: `${articleId}:${row.target_lang}`, priority: 5 },
    )
    if (id) enqueued += 1
  }
  return {
    selected: candidates.length,
    enqueued,
    alreadyQueued: candidates.length - enqueued,
  }
}
