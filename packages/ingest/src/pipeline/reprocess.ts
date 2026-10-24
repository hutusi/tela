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
  pointed,
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

  // The base the body was first made against: the item's link, else the feed's own address, as
  // `processItem` resolves a GUID-only item's relative images and links.
  const processed = await processArticleHtml({
    html,
    baseUrl: current.sourceUrl ?? article.url ?? article.feedUrl,
    // Its own language as the hint: a near tie stays as it was, only a clearer reading moves it.
    langHint: article.sourceLang,
    title: article.title,
  })
  const object = buildContentObject(processed)
  const was = article.versions.find((v) => v.version === current.version)
  const sameBody = object.key === current.contentKey
  const next = Math.max(0, ...article.versions.map((v) => v.version)) + 1
  const made: StoredVersion = {
    version: next,
    provenance: current.provenance,
    contentKey: object.key,
    bodyChars: processed.text.length,
    excerpt: processed.excerpt || null,
    wordCount: processed.wordCount,
    readingMinutes: processed.readingMinutes,
    // A body's language is its content object's, which is immutable and keyed by the body alone,
    // and the body job reads it from there: an unchanged body keeps the language it has, or a
    // corrected one would say English while its object said French and refuse a French reader
    // ("already in that language"). A language follows a new body.
    lang: sameBody ? (was?.lang ?? null) : processed.lang === 'und' ? null : processed.lang,
  }
  // The content key hashes the annotated body alone. What the version derives from it beside the
  // object (excerpt, counts) is the pipeline's output too, and a fix to an excerpt alone must not
  // be stamped away: either differing is a new version, of the same body when only those differ.
  const same =
    sameBody &&
    was !== undefined &&
    was.excerpt === made.excerpt &&
    was.wordCount === made.wordCount &&
    was.readingMinutes === made.readingMinutes &&
    was.bodyChars === made.bodyChars
  if (same) return stamp('unchanged')

  // A body that came out the same has its object already: the content key names it.
  if (!sameBody) {
    await ctx.blobs.put(objectKeys.content(object.key), JSON.stringify(object), {
      contentType: 'application/json',
      cacheControl: IMMUTABLE,
    })
  }
  // The same provenance's latest is the one `chooseCurrent` reads, so the new version takes the
  // place of the one it was made from.
  const chosen = (chooseCurrent([...article.versions, made], article.contentMode) ??
    made) as StoredVersion
  const titleHash = (await sha256Hex(`${article.title}\n${chosen.excerpt ?? ''}`)).slice(0, 16)
  const committed = await commit(ctx, lease, [
    ...adoptReprocessedVersion(
      ctx.db,
      { id: article.id, currentVersion: current.version },
      { ...made, rawKey: current.rawKey, sourceUrl: current.sourceUrl },
      chosen,
      titleHash,
      ctx.clock.now(),
    ),
  ])
  if (!committed.ok) return { status: 'lost' }
  // fence, seq, the insert, then the move: a feed's fetch or an extraction moved the article since
  // it was read, so this one wrote nothing. Still due if its current version is still old.
  if (!pointed(committed.results, 3)) return { status: 'skipped', reason: 'superseded' }
  return { status: 'reprocessed', version: next }
}
