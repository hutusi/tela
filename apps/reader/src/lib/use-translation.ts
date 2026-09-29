/**
 * An article's translation into the reading language, streamed (ADR 0023, 0025).
 *
 * - A foreign article asks for one when it opens, unless one exists.
 * - While it runs, the status is polled every 1.5 s (visible tabs only) and each new chunk object
 *   is fetched and laid over the original by block index: the first paragraphs show in seconds.
 * - Once done, the finished object replaces the chunks; the synced row says so on every device.
 */
import type { ArticleRow, TranslationRow } from '@tela/sync'
import { translationKey } from '@tela/sync'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReaderTranslationState, TranslationView } from '../components/translation-bar'
import { api } from '../store/api'
import { useStore, useTables } from '../store/hooks'
import type { ContentObject, TranslationChunk, TranslationObject } from '../store/objects'
import { siteOfFeed } from '../store/selectors'
import { blocksContaining, type ReaderBlock } from './block-pairs'

export type TranslationNotice = 'rateLimited' | 'budgetExhausted' | 'unavailable'

export type ArticleTranslation = {
  /** Null when the article is already in the reading language, or cannot be translated. */
  view: TranslationView | null
  /** Aligned with the original's blocks; null where nothing has arrived for a block. */
  blocks: (ReaderBlock | null)[] | null
  untranslated: string[]
  notice: TranslationNotice | null
  retry(): void
}

export type Live = Pick<TranslationRow, 'state' | 'chunkKeys' | 'objectKey' | 'failedLeaves'>

const POLL_MS = 1500
const RANK: Record<string, number> = {
  requested: 1,
  running: 2,
  partial: 3,
  done: 3,
  failed: 3,
  skipped: 3,
}

/**
 * The more advanced of what sync says and what polling has seen. A later state wins. Between two
 * still running, the one naming more chunks is the newer, since a request's chunks only ever
 * append; otherwise a synced row, refreshed by a pull about once a minute, would hold back the
 * chunks polling sees every 1.5 s.
 */
export function moreAdvanced(row: Live | undefined, live: Live | null): Live | null {
  if (!row) return live
  if (!live) return row
  const byState = (RANK[live.state] ?? 0) - (RANK[row.state] ?? 0)
  if (byState !== 0) return byState > 0 ? live : row
  const going = live.state === 'requested' || live.state === 'running'
  return going && live.chunkKeys.length > row.chunkKeys.length ? live : row
}

const NOTICE: Record<string, TranslationNotice> = {
  rate_limited: 'rateLimited',
  budget_exhausted: 'budgetExhausted',
  unavailable: 'unavailable',
}

export function useArticleTranslation(
  article: ArticleRow | null,
  content: ContentObject | null,
  readingLang: string,
): ArticleTranslation {
  const tables = useTables()
  const { objects, engine } = useStore()
  const contentKey = article?.contentKey ?? null
  const optOut = article ? (siteOfFeed(tables, article.feedId)?.translationOptOut ?? false) : false
  const needed =
    article !== null &&
    contentKey !== null &&
    article.sourceLang !== null &&
    article.sourceLang !== readingLang &&
    !optOut
  const row = contentKey
    ? tables.translations.get(translationKey(contentKey, readingLang))
    : undefined
  const [live, setLive] = useState<Live | null>(null)
  const [notice, setNotice] = useState<TranslationNotice | null>(null)
  const [chunks, setChunks] = useState<Map<number, string>>(() => new Map())
  const [final, setFinal] = useState<TranslationObject | null>(null)
  const asked = useRef<string | null>(null)

  // A new article or language starts from nothing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on the key alone
  useEffect(() => {
    setLive(null)
    setNotice(null)
    setChunks(new Map())
    setFinal(null)
  }, [contentKey, readingLang])

  const current = useMemo(() => moreAdvanced(row, live), [row, live])

  const request = useCallback(async () => {
    if (!article) return
    setNotice(null)
    try {
      const res = await api('/api/v1/translations', {
        body: { articleId: article.id, lang: readingLang },
      })
      const body = (await res.json()) as { status: string; translation: Live | null }
      if (NOTICE[body.status]) setNotice(NOTICE[body.status] as TranslationNotice)
      else if (body.translation) setLive(body.translation)
      void engine.pull()
    } catch {
      setNotice('unavailable')
    }
  }, [article, readingLang, engine])

  // Ask once per article and language, when there is nothing to show yet.
  useEffect(() => {
    if (!needed || row || !contentKey) return
    const key = `${contentKey}:${readingLang}`
    if (asked.current === key) return
    asked.current = key
    void request()
  }, [needed, row, contentKey, readingLang, request])

  // Poll while it runs, in a visible tab.
  const running = current?.state === 'requested' || current?.state === 'running'
  useEffect(() => {
    if (!running || !contentKey) return
    let stopped = false
    const tick = async () => {
      if (document.visibilityState !== 'visible') return
      try {
        const res = await api(`/api/v1/translations/${contentKey}/${readingLang}`)
        if (!res.ok || stopped) return
        const next = (await res.json()) as Live
        setLive(next)
        if (next.state !== 'requested' && next.state !== 'running') void engine.pull()
      } catch {
        // The next tick tries again.
      }
    }
    const id = setInterval(() => void tick(), POLL_MS)
    void tick()
    return () => {
      stopped = true
      clearInterval(id)
    }
  }, [running, contentKey, readingLang, engine])

  // Fetch each chunk as it is named, and lay it over the original. Keyed by the list's text: the
  // row is a fresh array on every pull even when it names the same chunks.
  const chunkList = (current?.chunkKeys ?? []).join('|')
  useEffect(() => {
    let cancelled = false
    for (const key of chunkList ? chunkList.split('|') : []) {
      void objects.object<TranslationChunk>(key).then((chunk) => {
        if (!chunk || cancelled) return
        setChunks((held) => {
          const next = new Map(held)
          for (const [i, html] of Object.entries(chunk.blocks)) next.set(Number(i), html)
          return next
        })
      })
    }
    return () => {
      cancelled = true
    }
  }, [chunkList, objects])

  // The finished object, once there is one.
  const objectKey = current?.objectKey ?? null
  useEffect(() => {
    if (!objectKey) return
    let cancelled = false
    void objects.object<TranslationObject>(objectKey).then((o) => {
      if (!cancelled && o) setFinal(o)
    })
    return () => {
      cancelled = true
    }
  }, [objectKey, objects])

  const blocks = useMemo(() => {
    if (!content) return null
    const original = content.blocks
    if (final && final.blocks.length === original.length) {
      return original.map((o, i) => ({
        id: o.leaves[0] ?? `#${i}`,
        tag: o.tag,
        html: final.blocks[i] ?? o.html,
      }))
    }
    if (chunks.size === 0) return null
    return original.map((o, i) => {
      const html = chunks.get(i)
      return html === undefined ? null : { id: o.leaves[0] ?? `#${i}`, tag: o.tag, html }
    })
  }, [content, final, chunks])

  // Memoized: the pairs, and the highlights painted over them, are rebuilt when this changes.
  const failed = (final?.failedLeaves ?? current?.failedLeaves ?? []).join('|')
  const untranslated = useMemo(
    () => (content ? blocksContaining(content, failed ? failed.split('|') : []) : []),
    [content, failed],
  )
  const state: ReaderTranslationState = current
    ? ((current.state === 'skipped' ? 'failed' : current.state) as ReaderTranslationState)
    : 'none'
  return {
    view: needed
      ? {
          targetLang: readingLang,
          state,
          failedBlocks: untranslated.length,
          available: blocks !== null,
        }
      : null,
    blocks,
    untranslated,
    notice,
    retry: () => void request(),
  }
}
