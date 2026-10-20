/**
 * An article's translation into the reading language, streamed (ADR 0023, 0025).
 *
 * - A foreign article asks for one when it opens, unless one exists, or the member translates only
 *   when asked (`enabled` is false until they do). A language they never translate is not foreign.
 * - While it runs, the status is polled (visible tabs only) and each new chunk object is fetched
 *   and laid over the original by block index: the first paragraphs show in seconds. Every 400 ms
 *   while the first chunk is awaited, for 5 s at most, then every 1.5 s (`pollDelay`).
 * - Once done, the finished object replaces the chunks; the synced row says so on every device.
 * - A finished object that cannot be had, asked for twice, leaves the blocks no chunk brought with
 *   nothing on the way to them: the translation is then failed for this reader (`readerState`),
 *   and Retry asks for the object again.
 */
import type { ArticleRow, TranslationRow } from '@tela/sync'
import { translationKey } from '@tela/sync'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReaderTranslationState, TranslationView } from '../components/translation-bar'
import { api } from '../store/api'
import { useStore, useTables } from '../store/hooks'
import type { ContentObject, Objects, TranslationChunk, TranslationObject } from '../store/objects'
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
/** How often the status is asked for while the first chunk is awaited: it is what the reader sees. */
const FIRST_CHUNK_POLL_MS = 400
/**
 * How long the fast poll lasts. A translation's first chunk lands within a few seconds or the model
 * is slow today, and a slow run polled every 400 ms would ask four times as often for the whole of
 * it: one article in production polled for 35 s and more.
 */
const FIRST_CHUNK_WAIT_MS = 5000

/**
 * The wait before the next status poll: short until the first chunk is named, within the first
 * few seconds of polling, and the usual pace after either.
 */
export function pollDelay(sincePollStarted: number, chunked: boolean): number {
  return !chunked && sincePollStarted < FIRST_CHUNK_WAIT_MS ? FIRST_CHUNK_POLL_MS : POLL_MS
}
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

/**
 * Whether a translation request's answer is a reason to pull, given the row the device holds for
 * it. `ready` is: the translation is done, and its row may not be on the device yet. A new attempt
 * (`requested`, `in_progress`) is when the device holds a row that had ended, failed or skipped or
 * done: that row outranks the request's own answer (`moreAdvanced`), so until a pull brings the
 * new row nothing polls and the reader still says it failed, for up to a minute after Try again
 * (Codex's review). Not when it holds none, an article's first request: the pull after the push
 * that marked it read brings the row, and the poll pulls when the translation ends; pulling here
 * as well landed during that pull and cost a second round, on every article opened. A refusal
 * (`rate_limited`, `invalid`, …) writes nothing to pull.
 */
export function pullsAfterRequest(status: string, held: Live | undefined): boolean {
  if (status === 'ready') return true
  if (status !== 'requested' && status !== 'in_progress') return false
  return held !== undefined && held.state !== 'requested' && held.state !== 'running'
}

/** Between the two asks for a finished object: long enough for a dropped connection to return. */
export const FINISHED_RETRY_MS = 1500

/**
 * The finished translation object, asked for a second time when the first answer is not one (a
 * non-OK answer is null, a network error rejects). Null when neither was, or once `signal` is
 * aborted. Nothing else asks for it again: polling stops once the translation is done.
 */
export async function finishedObject(
  objects: Pick<Objects, 'object'>,
  key: string,
  signal: AbortSignal,
  pause: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms)),
): Promise<TranslationObject | null> {
  const ask = () => objects.object<TranslationObject>(key, signal).catch(() => null)
  const first = await ask()
  if (first || signal.aborted) return first
  await pause(FINISHED_RETRY_MS)
  return signal.aborted ? null : ask()
}

/**
 * Where the translation stands for this reader. Until the member asks, nothing is under way for
 * them, whatever another reader started; skipped reads as failed. So does a finished translation
 * whose object could not be had while blocks still wait on it (`stalled`): no chunk is coming for
 * them, so they would wait under "Translating the rest…" for ever, with no Retry.
 */
export function readerState(
  current: Live | null,
  enabled: boolean,
  stalled: boolean,
): ReaderTranslationState {
  if (!current || !enabled) return 'none'
  if (current.state === 'skipped' || stalled) return 'failed'
  return current.state as ReaderTranslationState
}

export function useArticleTranslation(
  article: ArticleRow | null,
  content: ContentObject | null,
  readingLang: string,
  options: {
    /** Ask for it and fetch what exists; false shows the original until the member asks. */
    enabled: boolean
    /** Languages the member reads as written (a pref): never translated. */
    never: readonly string[]
  } = { enabled: true, never: [] },
): ArticleTranslation {
  const tables = useTables()
  const { objects, engine } = useStore()
  const { enabled } = options
  const contentKey = article?.contentKey ?? null
  const optOut = article ? (siteOfFeed(tables, article.feedId)?.translationOptOut ?? false) : false
  const needed =
    article !== null &&
    contentKey !== null &&
    article.sourceLang !== null &&
    article.sourceLang !== readingLang &&
    !options.never.includes(article.sourceLang) &&
    !optOut
  const row = contentKey
    ? tables.translations.get(translationKey(contentKey, readingLang))
    : undefined
  const [live, setLive] = useState<Live | null>(null)
  const [notice, setNotice] = useState<TranslationNotice | null>(null)
  const [chunks, setChunks] = useState<Map<number, string>>(() => new Map())
  const [final, setFinal] = useState<TranslationObject | null>(null)
  // The key of a finished object asked for twice in vain, and how many times Retry asked again.
  const [lost, setLost] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const asked = useRef<string | null>(null)

  // A new article or language starts from nothing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on the key alone
  useEffect(() => {
    setLive(null)
    setNotice(null)
    setChunks(new Map())
    setFinal(null)
    setLost(null)
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
      if (pullsAfterRequest(body.status, row)) void engine.pull()
    } catch {
      setNotice('unavailable')
    }
  }, [article, readingLang, engine, row])

  // Ask once per article and language, when there is nothing to show yet.
  useEffect(() => {
    if (!needed || !enabled || row || !contentKey) return
    const key = `${contentKey}:${readingLang}`
    if (asked.current === key) return
    asked.current = key
    void request()
  }, [needed, enabled, row, contentKey, readingLang, request])

  // Poll while it runs, in a visible tab.
  const running = current?.state === 'requested' || current?.state === 'running'
  useEffect(() => {
    if (!running || !enabled || !contentKey) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const started = Date.now()
    // Whether a poll has named a chunk yet: the first one is what the reader is waiting for.
    let chunked = false
    const ask = async () => {
      if (document.visibilityState !== 'visible') return
      try {
        const res = await api(`/api/v1/translations/${contentKey}/${readingLang}`)
        if (!res.ok || stopped) return
        const next = (await res.json()) as Live
        chunked ||= next.chunkKeys.length > 0
        setLive(next)
        if (next.state !== 'requested' && next.state !== 'running') void engine.pull()
      } catch {
        // The next tick tries again.
      }
    }
    // One poll at a time, each scheduled when the last has answered.
    const tick = async () => {
      await ask()
      if (!stopped) timer = setTimeout(() => void tick(), pollDelay(Date.now() - started, chunked))
    }
    void tick()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [running, enabled, contentKey, readingLang, engine])

  // Fetch each chunk as it is named, and lay it over the original. Keyed by the list's text: the
  // row is a fresh array on every pull even when it names the same chunks. One that fails is not
  // asked for again: the finished object brings its blocks.
  const chunkList = enabled ? (current?.chunkKeys ?? []).join('|') : ''
  useEffect(() => {
    let cancelled = false
    for (const key of chunkList ? chunkList.split('|') : []) {
      void objects
        .object<TranslationChunk>(key)
        .catch(() => null)
        .then((chunk) => {
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

  // The finished object, once there is one, and again each time Retry asks for it.
  const objectKey = enabled ? (current?.objectKey ?? null) : null
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` asks again for the same key
  useEffect(() => {
    if (!objectKey) return
    const controller = new AbortController()
    void finishedObject(objects, objectKey, controller.signal).then((o) => {
      if (controller.signal.aborted) return
      if (o) setFinal(o)
      else setLost(objectKey)
    })
    return () => controller.abort()
  }, [objectKey, objects, attempt])

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
  // The finished object is lost to this reader while blocks still wait on it. Chunks that all
  // landed are the whole translation, and lose nothing without it.
  const stalled =
    objectKey !== null &&
    lost === objectKey &&
    final === null &&
    (blocks === null || blocks.some((b) => b === null))
  const state = readerState(current, enabled, stalled)
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
    // Stalled, the translation is there and only its object is missing: ask for that again, not
    // for a new translation. Until it lands the rest waits under its placeholder once more.
    retry: stalled
      ? () => {
          setLost(null)
          setAttempt((n) => n + 1)
        }
      : () => void request(),
  }
}
