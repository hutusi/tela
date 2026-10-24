/**
 * Process an article's current body again from the raw HTML it was stored with (ADR 0055). When
 * the pipeline changes (`PIPELINE_VERSION`), every current version made under an older one is due:
 * nothing is fetched, the result is a new version only where the content object changed, and an
 * unchanged one is stamped current. So a fix to sanitizing or normalization reaches every stored
 * post, including those a feed no longer lists and pages that are gone.
 */
import { buildContentObject, objectKeys, processArticleHtml, sha256Hex } from '@tela/content'
import {
  adoptReprocessedVersion,
  chooseCurrent,
  type Lease,
  loadArticleForReprocess,
  type StoredVersion,
  stampPipeline,
} from '@tela/data'
import { PIPELINE_VERSION } from '@tela/shared'
import { commit, type IngestContext } from './context'

export type ReprocessResult =
  | { status: 'reprocessed'; version: number }
  | { status: 'unchanged' }
  | { status: 'skipped'; reason: string }
  | { status: 'lost' }

const IMMUTABLE = 'public, max-age=31536000, immutable'

/** Reprocess one article's current version. `lease.key` is the article id. */
export async function reprocessArticleJob(
  ctx: IngestContext,
  lease: Lease,
): Promise<ReprocessResult> {
  const article = await loadArticleForReprocess(ctx.db, Number(lease.key))
  if (!article || article.current.pipelineVersion >= PIPELINE_VERSION) {
    const committed = await commit(ctx, lease, [])
    return committed.ok ? { status: 'skipped', reason: 'not due' } : { status: 'lost' }
  }
  const { current } = article
  const stamp = async (reason: string): Promise<ReprocessResult> => {
    const committed = await commit(ctx, lease, [stampPipeline(ctx.db, article.id, current.version)])
    if (!committed.ok) return { status: 'lost' }
    return reason === 'unchanged' ? { status: 'unchanged' } : { status: 'skipped', reason }
  }
  // A version from before raw HTML was kept, or whose object went: nothing to process again.
  const raw = current.rawKey ? await ctx.blobs.get(current.rawKey) : null
  if (raw === null) return stamp('no raw html')
  const html = await raw.text()

  const baseUrl = current.sourceUrl ?? article.url
  const processed = await processArticleHtml({
    html,
    ...(baseUrl ? { baseUrl } : {}),
    langHint: article.sourceLang,
    title: article.title,
  })
  const object = buildContentObject(processed)
  if (object.key === current.contentKey) return stamp('unchanged')

  await ctx.blobs.put(objectKeys.content(object.key), JSON.stringify(object), {
    contentType: 'application/json',
    cacheControl: IMMUTABLE,
  })
  const next = Math.max(0, ...article.versions.map((v) => v.version)) + 1
  const made: StoredVersion = {
    version: next,
    provenance: current.provenance,
    contentKey: object.key,
    bodyChars: processed.text.length,
    excerpt: processed.excerpt || null,
    wordCount: processed.wordCount,
    readingMinutes: processed.readingMinutes,
    lang: processed.lang === 'und' ? null : processed.lang,
  }
  // The same provenance's latest is the one `chooseCurrent` reads, so the new version takes the
  // place of the one it was made from.
  const chosen = (chooseCurrent([...article.versions, made], article.contentMode) ??
    made) as StoredVersion
  const titleHash = (await sha256Hex(`${article.title}\n${chosen.excerpt ?? ''}`)).slice(0, 16)
  const committed = await commit(ctx, lease, [
    ...adoptReprocessedVersion(
      ctx.db,
      article.id,
      { ...made, rawKey: current.rawKey, sourceUrl: current.sourceUrl },
      chosen,
      titleHash,
      ctx.clock.now(),
    ),
  ])
  if (!committed.ok) return { status: 'lost' }
  return { status: 'reprocessed', version: next }
}
