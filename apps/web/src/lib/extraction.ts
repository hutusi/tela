import type { Db } from '@tela/db'
import {
  type ArticleDetail,
  EXTRACT_COOLDOWN_MINUTES,
  markExtractRequested,
} from '@tela/db/queries'
import { wantsExtraction } from '@tela/ingest'
import { enqueueArticleExtract } from './queue'

/**
 * Claim one extraction window for an opened summary-only article, or do nothing.
 *
 * The reader is not waiting on this, so callers run it behind `waitUntil`: the job follows the row
 * update that wins a cooldown window, not the render, and the worker stamps the article on a final
 * outcome. `extract_requested_at` comes back with the article, so a request inside a window it
 * cannot win never reaches the database at all.
 */
export async function claimExtraction(article: ArticleDetail | null, db: Db): Promise<void> {
  if (!article || !wantsExtraction(article)) return
  const requested = article.extractRequestedAt
  const cooled =
    requested === null || Date.now() - requested.getTime() > EXTRACT_COOLDOWN_MINUTES * 60_000
  if (!cooled) return
  if (await markExtractRequested(db, article.id)) await enqueueArticleExtract(db, article.id)
}
