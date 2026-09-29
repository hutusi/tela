/**
 * The article itself. Everything comes from the device: the row from the local store, the body
 * from IndexedDB (prefetched, usually) or the edge. Opening one therefore costs no request to
 * tela-api at all (ADR 0025). Highlights, notes and typography are the member's synced rows and
 * prefs (ADR 0026).
 */
import type { ArticleRow } from '@tela/sync'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'use-intl'
import { pairBlocks, readerBlocks, runsOf } from '../lib/block-pairs'
import { relativeTime } from '../lib/format'
import { pointAt, type Side } from '../lib/highlight-dom'
import type { ReadingMode } from '../lib/href'
import { newId } from '../lib/id'
import { readerStyle, typographyOf } from '../lib/typography'
import { useHighlights } from '../lib/use-highlights'
import { useArticleTranslation } from '../lib/use-translation'
import { useNow, useStore, useTables } from '../store/hooks'
import type { ContentObject } from '../store/objects'
import { feedTitle, isLiked, isRecommended, shownTitle, siteOfFeed } from '../store/selectors'
import { HighlightList, HighlightNote, HighlightToolbar, useSelectedAnchor } from './highlights'
import { LikeButton } from './like-button'
import { PairedBody } from './paired-body'
import { RecommendPopover } from './recommend-popover'
import { ReaderPaneSkeleton } from './skeletons'
import { Swatch } from './swatch'
import { TranslationBar } from './translation-bar'
import { TypographyMenu } from './typography-menu'
import { Untranslated } from './untranslated'

function Body({
  html,
  lang,
  dir,
  testId,
}: {
  html: string
  lang?: string | undefined
  dir?: 'auto' | undefined
  testId: string
}) {
  return (
    <div
      className="article-body"
      lang={lang}
      dir={dir}
      data-testid={testId}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: allowlist-sanitized by @tela/content; model output re-escaped on rehydration (ADR 0005)
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

type Props = {
  article: ArticleRow
  readingLang: string
  mode: ReadingMode
  onMode: (mode: ReadingMode) => void
  onClose: () => void
}

/** While a summary-only post waits for its full text, pull quickly so it appears when it lands. */
const EXTRACT_PULL_MS = 4000

export function Reader({ article, readingLang, mode, onMode, onClose }: Props) {
  const t = useTranslations('reader')
  const locale = useLocale()
  const now = useNow()
  const tables = useTables()
  const { objects, engine, store } = useStore()
  const [content, setContent] = useState<{ key: string; object: ContentObject | null } | null>(null)
  const key = article.contentKey

  useEffect(() => {
    if (!key) return
    const controller = new AbortController()
    objects
      .body(key, controller.signal)
      .then((object) => setContent({ key, object }))
      .catch(() => !controller.signal.aborted && setContent({ key, object: null }))
    return () => controller.abort()
  }, [key, objects])

  const extracting = article.extractState === 'due'
  useEffect(() => {
    if (!extracting) return
    const id = setInterval(() => void engine.pull(), EXTRACT_PULL_MS)
    return () => clearInterval(id)
  }, [extracting, engine])

  const object = content?.key === key ? content.object : null
  const loaded = !key || content?.key === key
  // Focus moves in once the article is on screen, not while its skeleton is: focusing the pane
  // before that focused nothing, and a keyboard reader was left in the list.
  const pane = useRef<HTMLElement>(null)
  useEffect(() => {
    if (loaded) pane.current?.focus({ preventScroll: true })
  }, [loaded])
  const translation = useArticleTranslation(article, object, readingLang)
  const original = useMemo(() => (object ? readerBlocks(object) : []), [object])
  const pairs = useMemo(
    () =>
      translation.blocks ? pairBlocks(translation.blocks, original, translation.untranslated) : [],
    [translation.blocks, original, translation.untranslated],
  )

  const view = translation.view
  const shown: ReadingMode = view?.available ? mode : 'orig'

  // Highlights: painted over what is rendered, found again after the post changes (ADR 0026).
  const body = useRef<HTMLDivElement>(null)
  const [note, setNote] = useState<{ id: string; x: number; y: number } | null>(null)
  const translationSettled = view?.state === 'done' || view?.state === 'partial'
  const rendered = useMemo(() => ({ shown, object, pairs }), [shown, object, pairs])
  const highlights = useHighlights({
    article,
    root: body,
    readingLang,
    rendered,
    translationSettled,
    activeId: note?.id ?? null,
  })
  const selected = useSelectedAnchor(body)
  // A streaming translation's text is still changing: highlight it once it has settled.
  const selectable =
    selected && (selected.side === 'original' || translationSettled) ? selected : null
  const highlight = useCallback(
    (side: Side, withNote: boolean) => {
      if (!selectable || !article.contentKey) return
      const id = newId()
      store.mutate({
        type: 'putHighlight',
        id,
        articleId: article.id,
        contentKey: article.contentKey,
        side,
        lang: side === 'translation' ? readingLang : null,
        ...selectable.anchor,
        note: null,
      })
      window.getSelection()?.removeAllRanges()
      if (withNote) {
        const { rect } = selectable
        setNote({ id, x: rect.left + rect.width / 2, y: rect.bottom })
      }
    },
    [selectable, article.id, article.contentKey, readingLang, store],
  )
  // `h` highlights the selection: the keyboard's way to the toolbar.
  useEffect(() => {
    if (!selectable) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'h' || e.metaKey || e.ctrlKey || e.altKey) return
      e.preventDefault()
      highlight(selectable.side, false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectable, highlight])
  const noteRow = note ? tables.highlights.get(note.id) : undefined
  const closeNote = useCallback(() => setNote(null), [])

  if (!loaded) return <ReaderPaneSkeleton />

  const { size, measure } = typographyOf(tables)
  // A click on painted text opens that highlight's note; a click on a link inside it still follows
  // the link. The list below the article is the keyboard's way to the same popover.
  const onBodyClick = (e: React.MouseEvent) => {
    if ((e.target as Element).closest('a') || !window.getSelection()?.isCollapsed) return
    const point = pointAt(e.clientX, e.clientY)
    const row = point ? highlights.at(point.side, point.leafId, point.offset) : undefined
    if (row) setNote({ id: row.id, x: e.clientX, y: e.clientY })
  }
  const showTrans = shown !== 'orig'
  const twoCols = shown === 'side'
  const sourceLang = article.sourceLang ?? undefined
  const name = feedTitle(tables, article.feedId) || store.sourceName(article.feedId)
  const site = siteOfFeed(tables, article.feedId)
  const titles = shownTitle(tables, article, readingLang)
  const title = showTrans ? titles.title : article.title
  const runs = showTrans
    ? runsOf(pairs, 'translated')
    : [{ id: 'o', html: original.map((b) => b.html).join(''), untranslated: false, pending: false }]

  return (
    <main
      ref={pane}
      className="min-w-0 overflow-hidden px-5 pb-20 pt-6 outline-none animate-fade md:px-8"
      data-testid="reader"
      data-mode={shown}
      data-size={size}
      data-measure={measure}
      style={readerStyle(size, measure)}
      tabIndex={-1}
    >
      {extracting ? (
        <p className="mx-auto mb-4 max-w-[1240px] text-[13px] text-muted" data-testid="extracting">
          {t('fetchingFullText')}
        </p>
      ) : null}

      <div className="mx-auto mb-7 flex max-w-[1240px] flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={onClose}
          className="-ml-2.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-muted hover:bg-hover hover:text-ink"
          data-testid="close-article"
        >
          {t('close')}
        </button>
        <div className="flex flex-wrap items-center gap-2">
          <TypographyMenu />
          <LikeButton
            articleId={article.id}
            liked={isLiked(tables, article.id)}
            likeCount={article.likeCount}
          />
          <RecommendPopover
            articleId={article.id}
            recommended={isRecommended(tables, article.id)}
            note={tables.recommendations.get(article.id)?.note ?? null}
            recommendCount={article.recommendCount}
          />
        </div>
      </div>

      <div className="mx-auto max-w-[1240px]">
        <div className="mb-3.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[13px] text-muted">
          <Swatch id={article.feedId} title={name} size={22} />
          <span className="font-medium text-ink">{name}</span>
          {article.author ? (
            <>
              <span>·</span>
              <span>{article.author}</span>
            </>
          ) : null}
          <span>·</span>
          <span>{relativeTime(article.publishedAt ?? article.fetchedAt, locale, now)}</span>
          <span>·</span>
          <span>{t('minRead', { n: article.readingMinutes || 1 })}</span>
          {article.url ? (
            <>
              <span>·</span>
              <a href={article.url} target="_blank" rel="noopener noreferrer">
                {t('readOriginal')} ↗
              </a>
            </>
          ) : null}
        </div>

        {view && sourceLang ? (
          <TranslationBar sourceLang={sourceLang} view={view} mode={mode} onMode={onMode} />
        ) : null}
        {translation.notice ? (
          <p className="text-[13px] text-muted" data-testid={`translation-${translation.notice}`}>
            <TranslationNotice notice={translation.notice} />
          </p>
        ) : null}
        {view?.state === 'failed' || translation.notice === 'unavailable' ? (
          <RetryTranslation onRetry={translation.retry} />
        ) : null}

        {/* biome-ignore lint/a11y/useKeyWithClickEvents: a pointer shortcut to a highlight's note; the list below reaches the same popover by keyboard */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: as above */}
        <div ref={body} onClick={onBodyClick}>
          {twoCols ? (
            <PairedBody
              pairs={pairs}
              title={titles.title}
              originalTitle={article.title}
              targetLang={readingLang}
              sourceLang={sourceLang}
            />
          ) : (
            <div className="max-w-(--reader-measure)">
              <h1
                className="mb-6 font-serif text-[40px] font-medium leading-[1.12] tracking-tight"
                style={{ textWrap: 'pretty' }}
                data-testid="article-title"
              >
                {title}
              </h1>
              {object && original.length > 0 ? (
                runs.map((run) =>
                  run.untranslated ? (
                    <Untranslated key={run.id} pending={run.pending}>
                      <Body html={run.html} lang={sourceLang} dir="auto" testId="body-translated" />
                    </Untranslated>
                  ) : (
                    <Body
                      key={run.id}
                      html={run.html}
                      lang={showTrans ? readingLang : sourceLang}
                      dir={showTrans ? undefined : 'auto'}
                      testId={showTrans ? 'body-translated' : 'body-original'}
                    />
                  ),
                )
              ) : (
                <p className="text-muted">{t('noContent')}</p>
              )}
            </div>
          )}
        </div>

        <HighlightList
          items={highlights.items}
          onOpen={(item, at) => setNote({ id: item.row.id, x: at.x, y: at.y })}
        />
        {selectable ? (
          <HighlightToolbar
            selected={selectable}
            onHighlight={(withNote) => highlight(selectable.side, withNote)}
          />
        ) : null}
        {noteRow && note ? <HighlightNote row={noteRow} at={note} onClose={closeNote} /> : null}

        <div className="mt-10 flex max-w-(--reader-measure) items-center gap-4 border-t border-line pt-6">
          <Swatch id={article.feedId} title={name} size={44} round />
          <div className="flex-1">
            <div className="font-medium">{site?.title ?? name}</div>
            <div className="text-[13px] text-muted">
              {site?.description ? `${site.description} · ` : ''}
              {t('readersOnTela', { n: site?.readerCount ?? 0 })}
            </div>
          </div>
          <span className="hidden text-[13px] text-muted xl:block">{t('visibleToAuthor')}</span>
        </div>
      </div>
    </main>
  )
}

function TranslationNotice({
  notice,
}: {
  notice: 'rateLimited' | 'budgetExhausted' | 'unavailable'
}) {
  const t = useTranslations('translation')
  return <>{t(notice)}</>
}

function RetryTranslation({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('translation')
  return (
    <button
      type="button"
      data-testid="translation-retry"
      className="mb-7 rounded-full border border-line bg-surface px-3.5 py-1.5 text-[13px] hover:border-muted"
      onClick={onRetry}
    >
      {t('retry')}
    </button>
  )
}
