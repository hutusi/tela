import type { ArticleDetail } from '@tela/db/queries'
import { LANGUAGE_NAMES, type UiLocale } from '@tela/shared'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { type ReadingParams, readingHref } from '@/app/reading/href'
import { relativeTime } from '@/lib/format'
import { AutoRefresh } from './auto-refresh'
import { LikeButton } from './like-button'
import { MarkRead } from './mark-read'
import { RecommendPopover } from './recommend-popover'
import { RequestTranslation } from './request-translation'
import { Swatch } from './swatch'
import { TranslationBar, type TranslationView } from './translation-bar'

export type ReaderTranslation = TranslationView & {
  html: string | null
  title: string | null
}

type Props = {
  article: ArticleDetail
  html: string
  params: ReadingParams
  locale: string
  /** Present when the article is not in the reading language. */
  translation: ReaderTranslation | null
  recommendation: { note: string | null } | null
  /** Full text is being fetched for a summary-only article: say so and poll. */
  extracting: boolean
}

function Body({ html, lang, testId }: { html: string; lang?: string | undefined; testId: string }) {
  return (
    <div
      className="article-body"
      lang={lang}
      data-testid={testId}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: allowlist-sanitized by @tela/content; images go through the signed proxy
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

export async function Reader({
  article,
  html,
  params,
  locale,
  translation,
  recommendation,
  extracting,
}: Props) {
  const t = await getTranslations('reader')
  const tt = await getTranslations('translation')
  const sourceLang = article.sourceLang ?? undefined
  const ready =
    translation !== null &&
    translation.html !== null &&
    (translation.state === 'done' || translation.state === 'partial')
  const mode = translation === null ? 'orig' : ready ? params.mode : 'orig'
  const showTrans = ready && mode !== 'orig'
  const showOrig = mode !== 'trans'
  const twoCols = showTrans && showOrig
  const title = showTrans && translation?.title ? translation.title : article.title
  const pending =
    translation !== null && (translation.state === 'requested' || translation.state === 'running')
  const needsRequest = translation !== null && translation.state === 'none'

  return (
    <main
      className="min-w-0 overflow-hidden px-5 pb-20 pt-6 animate-fade md:px-8"
      data-testid="reader"
      data-mode={mode}
    >
      <MarkRead articleId={article.id} isRead={article.isRead} />
      {extracting ? (
        <p className="mx-auto mb-4 max-w-[1240px] text-[13px] text-muted" data-testid="extracting">
          {t('fetchingFullText')}
        </p>
      ) : null}
      {needsRequest ? (
        <RequestTranslation articleId={article.id} targetLang={translation.targetLang} />
      ) : null}
      {pending || extracting ? <AutoRefresh intervalMs={2000} maxMs={180_000} /> : null}

      <div className="mx-auto mb-7 flex max-w-[1240px] flex-wrap items-center justify-between gap-2">
        <Link
          href={readingHref({ ...params, articleId: null })}
          className="-ml-2.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-muted hover:bg-hover hover:text-ink hover:no-underline"
          data-testid="close-article"
        >
          {t('close')}
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <LikeButton
            articleId={article.id}
            liked={article.isLiked}
            likeCount={article.likeCount}
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
          <span>{relativeTime(article.publishedAt ?? article.fetchedAt, locale)}</span>
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
          <TranslationBar sourceLang={sourceLang} view={translation} params={params} />
        ) : null}
        {translation?.state === 'failed' ? (
          <RequestTranslation
            articleId={article.id}
            targetLang={translation.targetLang}
            mode="button"
          />
        ) : null}

        <div
          className={`grid items-start gap-10 ${twoCols ? 'grid-cols-1 xl:grid-cols-2' : 'grid-cols-1'}`}
        >
          {showTrans && translation?.html ? (
            <div className="min-w-0 max-w-[640px]" lang={translation.targetLang}>
              {twoCols ? (
                <div className="mb-3.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-accent">
                  {tt('columnTranslated', {
                    target:
                      (LANGUAGE_NAMES[locale as UiLocale] ?? LANGUAGE_NAMES.en)[
                        translation.targetLang
                      ] ?? translation.targetLang,
                  })}
                </div>
              ) : null}
              <h1
                className={`mb-6 font-serif font-medium leading-[1.12] tracking-tight ${twoCols ? 'text-[32px]' : 'text-[40px]'}`}
                style={{ textWrap: 'pretty' }}
                data-testid="article-title"
              >
                {title}
              </h1>
              <Body
                html={translation.html}
                lang={translation.targetLang}
                testId="body-translated"
              />
            </div>
          ) : null}
          {showOrig ? (
            <div
              className={`min-w-0 max-w-[640px] ${twoCols ? 'text-ink-2' : ''}`}
              lang={sourceLang}
            >
              {twoCols ? (
                <div className="mb-3.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
                  {tt('columnOriginal')}
                </div>
              ) : null}
              <h1
                className={`mb-6 font-serif font-medium leading-[1.12] tracking-tight ${twoCols ? 'text-[32px]' : 'text-[40px]'}`}
                style={{ textWrap: 'pretty' }}
                data-testid={showTrans ? 'article-title-original' : 'article-title'}
              >
                {article.title}
              </h1>
              {html ? (
                <Body html={html} lang={sourceLang} testId="body-original" />
              ) : (
                <p className="text-muted">{t('noContent')}</p>
              )}
            </div>
          ) : null}
        </div>

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
