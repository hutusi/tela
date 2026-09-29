/**
 * The article itself. Everything comes from the device: the row from the local store, the body
 * from IndexedDB (prefetched, usually) or the edge. Opening one therefore costs no request to
 * tela-api at all (ADR 0025).
 */
import type { ArticleRow } from '@tela/sync'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'use-intl'
import { pairBlocks, readerBlocks, runsOf } from '../lib/block-pairs'
import { relativeTime } from '../lib/format'
import type { ReadingMode } from '../lib/href'
import { useArticleTranslation } from '../lib/use-translation'
import { useNow, useStore, useTables } from '../store/hooks'
import type { ContentObject } from '../store/objects'
import { feedTitle, isLiked, isRecommended, shownTitle, siteOfFeed } from '../store/selectors'
import { LikeButton } from './like-button'
import { PairedBody } from './paired-body'
import { RecommendPopover } from './recommend-popover'
import { ReaderPaneSkeleton } from './skeletons'
import { Swatch } from './swatch'
import { TranslationBar } from './translation-bar'
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

  if (!loaded) return <ReaderPaneSkeleton />

  const view = translation.view
  const shown: ReadingMode = view?.available ? mode : 'orig'
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

        {twoCols ? (
          <PairedBody
            pairs={pairs}
            title={titles.title}
            originalTitle={article.title}
            targetLang={readingLang}
            sourceLang={sourceLang}
          />
        ) : (
          <div className="max-w-[640px]">
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

        <div className="mt-10 flex max-w-[640px] items-center gap-4 border-t border-line pt-6">
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
      className="mb-7 rounded-full border border-line bg-white px-3.5 py-1.5 text-[13px] hover:border-muted"
      onClick={onRetry}
    >
      {t('retry')}
    </button>
  )
}
