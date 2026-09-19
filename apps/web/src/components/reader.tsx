'use client'

import type { ArticleFilter } from '@tela/db/queries'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useMemo } from 'react'
import { type ReadingMode, readingModeParam } from '@/app/reading/href'
import { pairBlocks } from '@/lib/block-pairs'
import { LikeButton } from './like-button'
import { MarkRead } from './mark-read'
import { PairedBody } from './paired-body'
import { PollUntil } from './poll-until'
import type { ReaderData } from './reader-data'
import { RecommendPopover } from './recommend-popover'
import { RequestTranslation } from './request-translation'
import { Swatch } from './swatch'
import { TranslationBar } from './translation-bar'

export type { ReaderTranslation } from './reader-data'

type Props = {
  data: ReaderData
  readingLang: string
  /** What a URL with no `mode` means for this reader: their last choice, remembered. */
  defaultMode: ReadingMode
  /** Decides whether the like button owes the list a refresh. */
  filter: ArticleFilter
  onClose: () => void
  /** Remember a mode change for the next article. */
  onModeChange: (mode: ReadingMode) => void
  /** Re-fetch this pane, for when a background job has changed it. */
  onReload: () => void
}

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
      // biome-ignore lint/security/noDangerouslySetInnerHtml: allowlist-sanitized by @tela/content; images go through the signed proxy
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

/**
 * The article itself.
 *
 * A client component, so that opening an article fetches JSON from a route handler instead of
 * re-rendering the page on the server — around 20 ms against 67 ms, against a 10 ms Workers Free
 * budget (ADR 0017). The server still renders it for a direct link; every click after that is
 * this component swapping its data.
 */
export function Reader({
  data,
  readingLang,
  defaultMode,
  filter,
  onClose,
  onReload,
  onModeChange,
}: Props) {
  const t = useTranslations('reader')
  const mode = readingModeParam(useSearchParams().get('mode')) ?? defaultMode
  const { article, blocks, translation, recommendation, extracting, revision } = data

  const sourceLang = article.sourceLang ?? undefined
  const ready =
    translation !== null &&
    translation.blocks !== null &&
    (translation.state === 'done' || translation.state === 'partial')
  const shown = translation === null ? 'orig' : ready ? mode : 'orig'
  const showTrans = ready && shown !== 'orig'
  const showOrig = shown !== 'trans'
  const twoCols = showTrans && showOrig
  const title = showTrans && translation?.title ? translation.title : article.title
  const pending =
    translation !== null && (translation.state === 'requested' || translation.state === 'running')
  const needsRequest = translation !== null && translation.state === 'none'
  const failed = translation?.state === 'failed'
  const requestOwnsPolling = needsRequest || failed

  const shownBlocks = showTrans ? (translation?.blocks ?? []) : blocks
  const shownHtml = useMemo(() => shownBlocks.map((b) => b.html).join(''), [shownBlocks])
  const pairs = useMemo(
    () =>
      twoCols
        ? pairBlocks(translation?.blocks ?? [], blocks, translation?.untranslatedBlocks ?? [])
        : [],
    [twoCols, translation?.blocks, translation?.untranslatedBlocks, blocks],
  )

  const onMode = (next: ReadingMode) => {
    onModeChange(next)
    const url = new URL(window.location.href)
    if (next === 'side') url.searchParams.delete('mode')
    else url.searchParams.set('mode', next)
    window.history.replaceState(null, '', url)
  }

  return (
    <main
      className="min-w-0 overflow-hidden px-5 pb-20 pt-6 outline-none animate-fade md:px-8"
      data-testid="reader"
      data-mode={shown}
      // A navigation used to move focus here for nothing; opening an article on the client has to
      // do it deliberately, or a keyboard reader stays parked in the list.
      tabIndex={-1}
    >
      <MarkRead articleId={article.id} isRead={article.isRead} />
      {extracting ? (
        <p className="mx-auto mb-4 max-w-[1240px] text-[13px] text-muted" data-testid="extracting">
          {t('fetchingFullText')}
        </p>
      ) : null}
      {needsRequest ? (
        <RequestTranslation
          key={`request:${article.id}:${translation.targetLang}`}
          articleId={article.id}
          targetLang={translation.targetLang}
          revision={revision}
          onReload={onReload}
          pollInitially={extracting}
        />
      ) : null}
      {!requestOwnsPolling && (pending || extracting) ? (
        <PollUntil
          articleId={article.id}
          lang={readingLang}
          revision={revision}
          onChanged={onReload}
        />
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
            liked={article.isLiked}
            likeCount={article.likeCount}
            listFiltersOnLiked={filter === 'liked'}
          />
          <RecommendPopover
            articleId={article.id}
            recommended={recommendation !== null}
            note={recommendation?.note ?? null}
            recommendCount={article.recommendCount}
          />
        </div>
      </div>

      <div className="mx-auto max-w-[1240px]">
        <div className="mb-3.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[13px] text-muted">
          <Swatch id={article.feedId} title={article.feedTitle} size={22} />
          <span className="font-medium text-ink">{article.feedTitle}</span>
          {article.author ? (
            <>
              <span>·</span>
              <span>{article.author}</span>
            </>
          ) : null}
          <span>·</span>
          <span>{article.publishedLabel}</span>
          <span>·</span>
          <span>{t('minRead', { n: article.readingMinutes ?? 1 })}</span>
          {article.url ? (
            <>
              <span>·</span>
              <a href={article.url} target="_blank" rel="noopener noreferrer">
                {t('readOriginal')} ↗
              </a>
            </>
          ) : null}
        </div>

        {translation && sourceLang ? (
          <TranslationBar sourceLang={sourceLang} view={translation} mode={mode} onMode={onMode} />
        ) : null}
        {translation?.state === 'failed' ? (
          <RequestTranslation
            key={`retry:${article.id}:${translation.targetLang}`}
            articleId={article.id}
            targetLang={translation.targetLang}
            mode="button"
            revision={revision}
            onReload={onReload}
            pollInitially={extracting}
          />
        ) : null}

        {twoCols ? (
          <PairedBody
            pairs={pairs}
            title={title}
            originalTitle={article.title}
            targetLang={translation?.targetLang ?? readingLang}
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
            {shownHtml ? (
              <Body
                html={shownHtml}
                lang={showTrans ? translation?.targetLang : sourceLang}
                dir={showTrans ? undefined : 'auto'}
                testId={showTrans ? 'body-translated' : 'body-original'}
              />
            ) : (
              <p className="text-muted">{t('noContent')}</p>
            )}
          </div>
        )}

        <div className="mt-10 flex max-w-[640px] items-center gap-4 border-t border-line pt-6">
          <Swatch id={article.feedId} title={article.feedTitle} size={44} round />
          <div className="flex-1">
            <div className="font-medium">{article.site.title ?? article.feedTitle}</div>
            <div className="text-[13px] text-muted">
              {article.site.description ? `${article.site.description} · ` : ''}
              {t('readersOnTela', { n: article.site.readerCount })}
            </div>
          </div>
          <span className="hidden text-[13px] text-muted xl:block">{t('visibleToAuthor')}</span>
        </div>
      </div>
    </main>
  )
}
