/**
 * Streamed body translation (ADR 0023). A reader asks for a translation of the content version
 * they are reading; this runs it in chunks along top-level block boundaries and writes each chunk
 * as its own object the moment it lands, so the first paragraphs appear in seconds rather than
 * after the whole article.
 *
 * The first chunk is small on purpose: GLM emits 70–100 tokens a second (spike S6), so a 3k-token
 * first chunk would keep the reader waiting half a minute for the opening paragraph, while ~400
 * tokens arrive in about five seconds. Later chunks grow; translation outruns reading by far.
 *
 * Model output is never trusted as HTML: `translateBlocks` validates every block's placeholders,
 * and rehydration re-escapes text (ADR 0005). An execution stops starting chunks at its budget and
 * releases the lease with the row still `running`; the next tick claims it again and continues,
 * already-translated blocks now being cache hits.
 */
import {
  type ContentObject,
  objectKeys,
  rehydrateBlocks,
  sha256Hex,
  taggedTextsOf,
} from '@tela/content'
import {
  cachedTranslations,
  currentSeq,
  type Lease,
  loadBodyTranslation,
  recordLlmCall,
  settleBodyUsage,
  storeBlockTranslations,
} from '@tela/data'
import { commit, type Statement } from '@tela/ingest/pipeline'
import { estimateTokens, type TranslationBlock, translateBlocks } from '@tela/llm'
import { MAX_ARTICLE_TRANSLATION_TOKENS, NORM_VERSION } from '@tela/shared'
import { sql } from 'drizzle-orm'
import type { TranslationContext } from './titles'

/** The opening chunk: small, so the first paragraphs land in about five seconds. */
export const FIRST_CHUNK_TOKENS = 400
export const CHUNK_TOKENS = 3000
/** An execution starts no chunk after this; the queue consumer's own limit is 15 minutes. */
export const BODY_EXECUTION_BUDGET_MS = 10 * 60_000
/** How long a chunk's batch holds the lease for the next one (a call is at most two minutes). */
const CHUNK_HOLD_MS = 4 * 60_000

export const translationObjectKeys = {
  chunk: (contentKey: string, lang: string, requestId: string, n: number) =>
    `tc/${contentKey}/${lang}/${requestId}/${n}.json`,
  final: (contentKey: string, lang: string, sha: string) => `t/${contentKey}/${lang}/${sha}.json`,
}

/** A translated chunk, overlaid by the reader onto the source by top-level block index. */
export type TranslationChunk = { format: 1; n: number; blocks: Record<string, string> }

/** The finished translation, aligned with the content object's blocks. */
export type TranslationObject = {
  format: 1
  norm: number
  source: string
  lang: string
  model: string
  status: 'done' | 'partial' | 'failed'
  /** Rehydrated HTML per top-level block; a block with no translation carries its source. */
  blocks: string[]
  failedLeaves: string[]
}

export type BodyResult =
  | { status: 'done' | 'partial' | 'failed'; chunks: number }
  | { status: 'continued'; chunks: number }
  | { status: 'skipped'; reason: string }
  | { status: 'retry'; error: string }
  | { status: 'lost' }

type Group = { blocks: number[]; misses: TranslationBlock[] }

/** Group top-level blocks into chunks of translatable misses: a small first, then larger. */
export function chunkGroups(
  object: ContentObject,
  misses: Map<string, string>,
  limits: { first: number; rest: number },
): Group[] {
  const groups: Group[] = []
  let current: Group = { blocks: [], misses: [] }
  let size = 0
  object.blocks.forEach((block, index) => {
    current.blocks.push(index)
    for (const id of block.leaves) {
      const text = misses.get(id)
      if (text === undefined) continue
      current.misses.push({ id, text })
      size += estimateTokens(text)
    }
    const limit = groups.length === 0 ? limits.first : limits.rest
    if (size >= limit) {
      groups.push(current)
      current = { blocks: [], misses: [] }
      size = 0
    }
  })
  if (current.blocks.length > 0) groups.push(current)
  return groups
}

function blockHtml(object: ContentObject, index: number, translated: Map<string, string>): string {
  const block = object.blocks[index]
  if (!block) return ''
  const own: Record<string, string> = {}
  for (const id of block.leaves) {
    const text = translated.get(id)
    if (text !== undefined) own[id] = text
  }
  return Object.keys(own).length === 0 ? block.html : rehydrateBlocks(block.html, own)
}

/** Run (or continue) the body translation `lease.key` names: `<contentKey>:<lang>`. */
export async function translateBodyJob(ctx: TranslationContext, lease: Lease): Promise<BodyResult> {
  const { db } = ctx
  const split = lease.key.lastIndexOf(':')
  const contentKey = lease.key.slice(0, split)
  const lang = lease.key.slice(split + 1)
  const skip = async (reason: string): Promise<BodyResult> => {
    const committed = await commit(ctx, lease, [])
    return committed.ok ? { status: 'skipped', reason } : { status: 'lost' }
  }
  const translator = ctx.translator
  if (!translator) return skip('no translator configured')
  const row = await loadBodyTranslation(db, contentKey, lang)
  if (!row || (row.state !== 'requested' && row.state !== 'running')) return skip('not requested')
  const stored = await ctx.blobs.get(objectKeys.content(contentKey))
  if (!stored) return settleFailed(ctx, lease, contentKey, lang, 'content object missing')
  const object = JSON.parse(await stored.text()) as ContentObject
  if (object.norm !== NORM_VERSION) {
    // Old hashes under new rules would mix cache entries (ADR 0005). Renormalizing from the raw
    // HTML first is the fix; until a NORM_VERSION bump happens there is nothing to renormalize.
    return settleFailed(ctx, lease, contentKey, lang, 'content predates the current NORM_VERSION')
  }
  const sourceLang = object.lang === 'und' ? null : object.lang
  const requestId = row.requestId ?? 'background'

  // Which leaves need a model: translatable, not skipped, not already cached.
  const tagged = taggedTextsOf(object.blocks.map((b) => b.html).join(''))
  const hashOf = new Map<string, string>()
  for (const [id, info] of Object.entries(object.leaves)) {
    if (!info.skip && tagged[id] !== undefined) hashOf.set(id, info.hash)
  }
  const cached = await cachedTranslations(db, [...new Set(hashOf.values())], lang, sourceLang)
  const translated = new Map<string, string>()
  const misses = new Map<string, string>()
  for (const [id, hash] of hashOf) {
    const hit = cached.get(hash)
    if (hit !== undefined) translated.set(id, hit)
    else misses.set(id, tagged[id] as string)
  }

  // Cap the source tokens one article may spend: the operator's ceiling, and the reader's
  // reservation when they asked for it. Leaves past the cap render as source (`partial`).
  const cap = Math.min(
    ctx.maxArticleTokens ?? MAX_ARTICLE_TRANSLATION_TOKENS,
    row.reservedTokens > 0 ? row.reservedTokens : Number.POSITIVE_INFINITY,
  )
  const failed = new Set<string>()
  let budgeted = 0
  for (const [id, text] of misses) {
    budgeted += estimateTokens(text)
    if (budgeted > cap) {
      failed.add(id)
      misses.delete(id)
    }
  }

  const deadline = ctx.clock.now() + BODY_EXECUTION_BUDGET_MS
  // A continuation already streamed its earlier chunks; it only sends groups that still need a
  // model. A first execution streams every group, cache hits included.
  const resuming = row.chunkKeys.length > 0
  let chunkNumber = row.chunkKeys.length
  let usedTokens = row.usedTokens
  const groups = chunkGroups(object, misses, { first: FIRST_CHUNK_TOKENS, rest: CHUNK_TOKENS })
  let stopped = false
  for (const group of groups) {
    const needsModel = group.misses.some((m) => !translated.has(m.id))
    if (!needsModel && resuming) continue
    if (ctx.clock.now() >= deadline) {
      stopped = true
      break
    }
    const now = ctx.clock.now()
    const statements: Statement[] = []
    if (needsModel) {
      let outcome: Awaited<ReturnType<typeof translateBlocks>>
      try {
        outcome = await translateBlocks(translator, {
          blocks: group.misses.filter((m) => !translated.has(m.id)),
          sourceLang,
          targetLang: lang,
          // One group is one call plus its own strict retry, so each chunk is final when written.
          maxTokensPerChunk: Number.MAX_SAFE_INTEGER,
        })
      } catch (err) {
        return { status: 'retry', error: err instanceof Error ? err.message : String(err) }
      }
      for (const [id, text] of outcome.translated) translated.set(id, text)
      for (const f of outcome.failed) failed.add(f.id)
      const cacheable = [...outcome.translated.entries()].map(([id, text]) => ({
        sourceHash: hashOf.get(id) as string,
        taggedText: text,
      }))
      if (cacheable.length > 0) {
        statements.push(
          storeBlockTranslations(
            db,
            cacheable,
            { targetLang: lang, sourceLang, model: translator.model, normVersion: NORM_VERSION },
            now,
          ),
        )
      }
      for (const usage of outcome.usage) {
        usedTokens += usage.inputTokens + usage.outputTokens
        statements.push(
          recordLlmCall(
            db,
            {
              job: 'translate.body',
              contentKey,
              articleId: null,
              targetLang: lang,
              userId: row.requestedBy,
              model: usage.model,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              latencyMs: usage.latencyMs,
            },
            now,
          ),
        )
      }
    }
    const chunk: TranslationChunk = {
      format: 1,
      n: chunkNumber,
      blocks: Object.fromEntries(
        group.blocks.map((i) => [String(i), blockHtml(object, i, translated)]),
      ),
    }
    const chunkKey = translationObjectKeys.chunk(contentKey, lang, requestId, chunkNumber)
    await ctx.blobs.put(chunkKey, JSON.stringify(chunk), { contentType: 'application/json' })
    statements.push(
      db.run(sql`
        update body_translations set state = 'running',
          chunk_keys = json_insert(chunk_keys, '$[#]', ${chunkKey}),
          used_tokens = ${usedTokens}, updated_at = ${now}, seq = ${currentSeq}
        where content_key = ${contentKey} and lang = ${lang}
      `),
    )
    const committed = await commit(ctx, lease, statements, { hold: { ttlMs: CHUNK_HOLD_MS } })
    if (!committed.ok) return { status: 'lost' }
    chunkNumber += 1
  }

  if (stopped) {
    const committed = await commit(ctx, lease, [])
    return committed.ok ? { status: 'continued', chunks: chunkNumber } : { status: 'lost' }
  }

  // Everything settled: the finished object, aligned with the source's blocks.
  const translatedCount = [...hashOf.keys()].filter((id) => translated.has(id)).length
  const status: TranslationObject['status'] =
    failed.size === 0 ? 'done' : translatedCount === 0 ? 'failed' : 'partial'
  const final: TranslationObject = {
    format: 1,
    norm: NORM_VERSION,
    source: contentKey,
    lang,
    model: translator.model,
    status,
    blocks: object.blocks.map((_, i) => blockHtml(object, i, translated)),
    failedLeaves: [...failed],
  }
  const body = JSON.stringify(final)
  const finalKey = translationObjectKeys.final(
    contentKey,
    lang,
    (await sha256Hex(body)).slice(0, 16),
  )
  await ctx.blobs.put(finalKey, body, {
    contentType: 'application/json',
    cacheControl: 'public, max-age=31536000, immutable',
  })
  const now = ctx.clock.now()
  const committed = await commit(ctx, lease, [
    // The reservation made when the reader asked is replaced by what was actually spent: the
    // stored running count, which every chunk's batch has already brought up to `usedTokens`.
    settleBodyUsage(db, contentKey, lang, now),
    db.run(sql`
      update body_translations set state = ${status}, object_key = ${finalKey},
        failed_leaves = ${JSON.stringify([...failed])}, model = ${translator.model},
        used_tokens = ${usedTokens}, reserved_tokens = 0, updated_at = ${now}, seq = ${currentSeq}
      where content_key = ${contentKey} and lang = ${lang} and state in ('requested', 'running')
    `),
  ])
  return committed.ok ? { status, chunks: chunkNumber } : { status: 'lost' }
}

async function settleFailed(
  ctx: TranslationContext,
  lease: Lease,
  contentKey: string,
  lang: string,
  reason: string,
): Promise<BodyResult> {
  const now = ctx.clock.now()
  const committed = await commit(ctx, lease, [
    // Nothing was translated, but the reservation still goes back.
    settleBodyUsage(ctx.db, contentKey, lang, now),
    ctx.db.run(sql`
      update body_translations set state = 'failed', failed_leaves = ${JSON.stringify([reason])},
        reserved_tokens = 0, updated_at = ${now}, seq = ${currentSeq}
      where content_key = ${contentKey} and lang = ${lang} and state in ('requested', 'running')
    `),
  ])
  return committed.ok ? { status: 'failed', chunks: 0 } : { status: 'lost' }
}
