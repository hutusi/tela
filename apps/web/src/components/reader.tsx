import type { ArticleDetail } from '@tela/db/queries'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { type ReadingParams, readingHref } from '@/app/reading/href'
import { relativeTime } from '@/lib/format'
import { LikeButton } from './like-button'
import { MarkRead } from './mark-read'
import { Swatch } from './swatch'

type Props = { article: ArticleDetail; html: string; params: ReadingParams; locale: string }

export async function Reader({ article, html, params, locale }: Props) {
  const t = await getTranslations('reader')
  return (
    <main
      className="min-w-0 overflow-hidden px-8 pb-20 pt-6 animate-fade"
      data-testid="reader"
      lang={article.sourceLang ?? undefined}
    >
      <MarkRead articleId={article.id} isRead={article.isRead} />
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

        <div className="max-w-[640px]">
          <h1
            className="mb-6 font-serif text-[40px] font-medium leading-[1.12] tracking-tight"
            style={{ textWrap: 'pretty' }}
            data-testid="article-title"
          >
            {article.title}
          </h1>
          {html ? (
            // biome-ignore lint/security/noDangerouslySetInnerHtml: allowlist-sanitized by @tela/content; images go through the signed proxy
            <div className="article-body" dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <p className="text-muted">{t('noContent')}</p>
          )}
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
