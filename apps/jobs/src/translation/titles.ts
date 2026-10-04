/**
 * Eager title translations (ADR 0006): what lists show, for a few hundred tokens an article. The
 * sweep finds feeds with articles whose current title hash has no translation into some launch
 * language, so an article whose title or excerpt changes is translated again without anything
 * being queued. A job takes one feed's due titles together: one call per language carries up to
 * `TITLES_PER_JOB` of them, so the prompt is paid once, not once an article.
 *
 * Traditional Chinese is never asked of the model (`./scripts`): it rides on the Simplified call
 * and is converted, and a post in one Chinese script reaches the other by conversion alone.
 */
import { blockHash } from '@tela/content'
import { plainText } from '@tela/content/tagged'
import {
  BACKGROUND,
  cachedTranslations,
  chargeUsage,
  type DueTitle,
  dueTitlesOfFeed,
  extendLease,
  first,
  type Lease,
  recordLlmCall,
  storeBlockTranslations,
  upsertArticleTitle,
  utcDay,
} from '@tela/data'
import { commit, type IngestContext, type Statement } from '@tela/ingest/pipeline'
import { type TranslateBlocksOutcome, type Translator, translateBlocks } from '@tela/llm'
import { NORM_VERSION, READING_LANGUAGES } from '@tela/shared'
import { sql } from 'drizzle-orm'
import { escapeUTF8 } from 'entities'
import { convertTagged, planFor } from './scripts'

export type TranslationContext = IngestContext & {
  /** Absent when no provider is configured; the translation kinds are disabled then. */
  translator?: Translator
  /** Daily token budget for background work (titles); 0 = unlimited. */
  backgroundBudget?: number
  /** Ceiling on source tokens translated per article body. */
  maxArticleTokens?: number
}

export type TitleResult =
  | { status: 'done'; articles: number; languages: Record<string, number> }
  | { status: 'skipped'; reason: string }
  | { status: 'retry'; error: string }
  | { status: 'lost' }

/**
 * How long a title job holds its lease at a time. Every call and every group's commit extends it
 * by this much, so it has to cover one call, not the feed: a feed in several source languages
 * makes a group, and at least one call, for each (target, source) pair.
 */
export const TITLE_TTL_MS = 5 * 60_000

type Block = { id: string; text: string; hash: string }

type StoredTitle = {
  article_id: number
  lang: string
  title: string | null
  excerpt: string | null
  status: 'done' | 'echo' | 'failed'
  source_hash: string
  model: string | null
}

/** An article in a group, and the reading languages the group writes for it. */
type Member = { article: DueTitle; langs: string[] }

/**
 * Work that shares a source language and what a model writes for it (`target`), so one call
 * serves the group: a Simplified group writes Traditional too. `target` is null for the source
 * converted into the other Chinese script, which asks nothing of a model.
 */
type Group = { target: string | null; sourceLang: string | null; members: Map<number, Member> }

/** Thrown out of `translateBlocks` between two calls whose lease has gone. */
class LeaseLost extends Error {
  override name = 'LeaseLost'
}

/** An article's title and excerpt as blocks, ids unique across the batch. */
async function blocksOf(article: DueTitle): Promise<Block[]> {
  const blocks = [{ id: `t${article.id}`, text: escapeUTF8(article.title) }]
  if (article.excerpt) blocks.push({ id: `e${article.id}`, text: escapeUTF8(article.excerpt) })
  return Promise.all(blocks.map(async (b) => ({ ...b, hash: await blockHash(b.text) })))
}

/**
 * Translate a feed's due titles and excerpts into every launch language each is not written in.
 * The key is the feed id. Work is grouped by (what is written, source language), at most one
 * `translateBlocks` call a group, and each group commits in its own fenced batch as it lands. A
 * group the provider refuses leaves the rest standing, and a lease lost midway keeps the groups
 * committed before it: paid work is never thrown away.
 */
export async function translateTitlesJob(
  ctx: TranslationContext,
  lease: Lease,
): Promise<TitleResult> {
  const { db } = ctx
  const feedId = Number(lease.key)
  const skip = async (reason: string): Promise<TitleResult> => {
    const committed = await commit(ctx, lease, [])
    return committed.ok ? { status: 'skipped', reason } : { status: 'lost' }
  }
  const translator = ctx.translator
  if (!translator) return skip('no translator configured')
  const site = await first<{ site_title: string | null }>(
    db,
    sql`
      select coalesce(s.title, f.title) as site_title
      from feeds f join sites s on s.id = f.site_id where f.id = ${feedId}
    `,
  )
  // The due query already leaves out opted-out sites and blank titles.
  const articles = site ? await dueTitlesOfFeed(db, feedId) : []
  if (articles.length === 0) return skip('up to date')

  // A row made from the current title is not due, and a current Simplified row is what a
  // Traditional reader's title is converted from.
  const stored = new Map(
    (
      await db.all<StoredTitle>(sql`
        select article_id, lang, title, excerpt, status, source_hash, model from article_titles
        where article_id in (select value from json_each(${JSON.stringify(articles.map((a) => a.id))}))
      `)
    ).map((r) => [`${r.article_id}:${r.lang}`, r]),
  )
  const current = (article: DueTitle, lang: string) => {
    const row = stored.get(`${article.id}:${lang}`)
    return row?.source_hash === article.title_hash ? row : undefined
  }
  const blocks = new Map<number, Block[]>()
  for (const article of articles) blocks.set(article.id, await blocksOf(article))

  const groups = new Map<string, Group>()
  for (const article of articles) {
    for (const lang of READING_LANGUAGES) {
      if (lang === article.source_lang || current(article, lang)) continue
      // One group per source language and model target, so Traditional rides on the Simplified
      // call; converting between the Chinese scripts asks no model and is a group of its own.
      const { target } = planFor(article.source_lang, lang)
      const key = `${target ?? `converted:${lang}`}\u0000${article.source_lang ?? ''}`
      const group = groups.get(key) ?? {
        target,
        sourceLang: article.source_lang,
        members: new Map(),
      }
      const member = group.members.get(article.id) ?? { article, langs: [] }
      member.langs.push(lang)
      group.members.set(article.id, member)
      groups.set(key, group)
    }
  }

  const translatedCount = new Map<string, number>()
  let providerError: string | null = null
  for (const { target, sourceLang, members } of groups.values()) {
    // An article whose Simplified title is current needs only its Traditional one, converted from
    // the stored row, echo and failure included: nothing is asked of the model again.
    const fresh: Member[] = []
    const derived: Array<{ member: Member; from: StoredTitle }> = []
    for (const member of members.values()) {
      const from = target === null ? undefined : current(member.article, target)
      if (from) derived.push({ member, from })
      else fresh.push(member)
    }
    const all = fresh.flatMap((m) => blocks.get(m.article.id) as Block[])
    // Block id → what was written: in `target`, or with no model the source itself.
    const written = new Map<string, string>()
    const missing: Block[] = []
    if (target === null) {
      for (const b of all) written.set(b.id, b.text)
    } else {
      const cached = await cachedTranslations(
        db,
        all.map((b) => b.hash),
        target,
        sourceLang,
      )
      for (const b of all) {
        const hit = cached.get(b.hash)
        if (hit !== undefined) written.set(b.id, hit)
        else missing.push(b)
      }
    }
    let outcome: TranslateBlocksOutcome | null = null
    if (target !== null && missing.length > 0) {
      try {
        outcome = await translateBlocks(translator, {
          blocks: missing.map(({ id, text }) => ({ id, text })),
          sourceLang,
          targetLang: target,
          context: { siteTitle: site?.site_title ?? null },
          // A title may be a name that reads the same in every language; excerpts keep the
          // echo guard.
          allowIdenticalBlockIds: missing.filter((b) => b.id.startsWith('t')).map((b) => b.id),
          // A group can take several calls (chunks, the strict retry), and a feed several groups.
          // Each call first extends the lease, so one lost meanwhile (after a call that failed,
          // too) stops the job before it pays for another.
          beforeCall: async () => {
            if (!(await extendLease(db, lease, ctx.clock.now(), TITLE_TTL_MS))) {
              throw new LeaseLost()
            }
          },
        })
      } catch (err) {
        if (err instanceof LeaseLost) return { status: 'lost' }
        // The provider is down or refusing: keep what other groups made, back off for the rest.
        // Nothing of this group is written, Traditional included, so the two stay due together.
        providerError = err instanceof Error ? err.message : String(err)
        continue
      }
    }
    const now = ctx.clock.now()
    const statements: Statement[] = []
    const echoed = new Set<string>()
    let spent = 0
    if (target !== null && outcome) {
      for (const usage of outcome.usage) {
        spent += usage.inputTokens + usage.outputTokens
        statements.push(
          recordLlmCall(
            db,
            {
              job: 'translate.title',
              contentKey: null,
              articleId: fresh.length === 1 ? (fresh[0] as Member).article.id : null,
              // What the model wrote: Simplified, for Traditional readers as well.
              targetLang: target,
              userId: null,
              model: usage.model,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              latencyMs: usage.latencyMs,
            },
            now,
          ),
        )
      }
      // An echo accepted only by the title exemption stays out of the shared cache: it is
      // content-addressed and first-write-wins, so a body <h1> repeating the headline would
      // inherit "this is its own translation" for ever (AGENTS.md).
      const hashOf = new Map(missing.map((b) => [b.id, b.hash]))
      const { translated, echoed: echoes } = outcome
      const cacheable = [...translated.entries()].filter(([id]) => !echoes.has(id))
      if (cacheable.length > 0) {
        statements.push(
          storeBlockTranslations(
            db,
            cacheable.map(([id, text]) => ({
              sourceHash: hashOf.get(id) as string,
              taggedText: text,
            })),
            { targetLang: target, sourceLang, model: translator.model, normVersion: NORM_VERSION },
            now,
          ),
        )
      }
      for (const [id, text] of translated) written.set(id, text)
      for (const id of echoes) echoed.add(id)
    }
    for (const { article, langs } of fresh) {
      for (const lang of langs) {
        // The model's Simplified becomes Traditional here, and the source the other script.
        const { finish, label } = planFor(sourceLang, lang)
        const text = (id: string) => {
          const source = written.get(id)
          const finished = source === undefined ? undefined : convertTagged(finish, source)
          return finished === undefined ? null : plainText(finished)
        }
        const title = text(`t${article.id}`)
        statements.push(
          upsertArticleTitle(
            db,
            {
              articleId: article.id,
              lang,
              title,
              excerpt: text(`e${article.id}`),
              // Failed and echoed titles are recorded too, so the sweep stops asking until the
              // title itself changes.
              status: title === null ? 'failed' : echoed.has(`t${article.id}`) ? 'echo' : 'done',
              sourceHash: article.title_hash,
              model: label ?? translator.model,
            },
            now,
          ),
        )
      }
    }
    for (const { member, from } of derived) {
      for (const lang of member.langs) {
        // A stored title is plain text; OpenCC leaves everything but Chinese as it is.
        const { finish } = planFor(sourceLang, lang)
        statements.push(
          upsertArticleTitle(
            db,
            {
              articleId: member.article.id,
              lang,
              title: from.title === null ? null : finish(from.title),
              excerpt: from.excerpt === null ? null : finish(from.excerpt),
              status: from.status,
              sourceHash: member.article.title_hash,
              model: from.model,
            },
            now,
          ),
        )
      }
    }
    if (spent > 0) statements.push(chargeUsage(db, BACKGROUND, utcDay(now), spent))
    // Each group commits the moment it lands and holds the lease for the next, so a feed's calls
    // need not all fit in one lease, and a lease lost later keeps what was paid for here.
    const committed = await commit(ctx, lease, statements, { hold: { ttlMs: TITLE_TTL_MS } })
    if (!committed.ok) return { status: 'lost' }
    for (const { langs } of members.values()) {
      for (const lang of langs) translatedCount.set(lang, (translatedCount.get(lang) ?? 0) + 1)
    }
  }
  // What succeeded is written; the lease is still held, so runJob can back it off.
  if (providerError !== null) return { status: 'retry', error: providerError }
  const released = await commit(ctx, lease, [])
  return released.ok
    ? { status: 'done', articles: articles.length, languages: Object.fromEntries(translatedCount) }
    : { status: 'lost' }
}
