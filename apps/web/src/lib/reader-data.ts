import type { ArticleDetail } from '@tela/db/queries'
import { wantsExtraction } from '@tela/ingest'
import { getLocale } from 'next-intl/server'
import { articleRevision } from '@/app/reading/revision'
import type { ReaderData, ReaderTranslation } from '@/components/reader-data'
import { articleBlocks } from './article-html'
import { relativeTime } from './format'

/**
 * Whether a translation row describes the body the reader is looking at, and is readable.
 *
 * One definition, used both to decide what to send and to decide what to fetch (see
 * `getArticle`'s conditional `translationHtml`). Two copies of this predicate drifting apart would
 * silently cost the reader their translation.
 */
export function translationIsShowable(
  translation: ArticleDetail['translation'],
  contentHash: string | null,
): boolean {
  if (translation === null) return false
  if (translation.contentHash !== contentHash) return false
  return translation.status === 'done' || translation.status === 'partial'
}

/** The reader pane's data, from the row `getArticle` returned. */
export async function buildReaderData(
  article: ArticleDetail,
  readingLang: string,
): Promise<ReaderData> {
  const locale = await getLocale()
  const row = article.translation

  // Foreign article: the body translation for the reading language came back with the article.
  let translation: ReaderTranslation | null = null
  if (article.sourceLang && article.sourceLang !== readingLang) {
    const fresh = row !== null && row.contentHash === article.contentHash
    const state = row === null || !fresh || row.status === 'pending' ? 'none' : row.status
    translation = {
      targetLang: readingLang,
      state,
      failedBlocks: fresh ? row.failedBlocks : 0,
      blocks: translationIsShowable(row, article.contentHash)
        ? await articleBlocks(row?.html ?? '')
        : null,
      title: row?.title ?? null,
    }
  }

  return {
    article: {
      id: article.id,
      title: article.title,
      author: article.author,
      url: article.url,
      publishedLabel: relativeTime(article.publishedAt ?? article.fetchedAt, locale),
      sourceLang: article.sourceLang,
      readingMinutes: article.readingMinutes,
      likeCount: article.likeCount,
      recommendCount: article.recommendCount,
      isRead: article.isRead,
      isLiked: article.isLiked,
      feedId: article.feedId,
      feedTitle: article.feedTitle,
      site: {
        title: article.site.title,
        description: article.site.description,
        readerCount: article.site.readerCount,
      },
    },
    blocks: await articleBlocks(article.html),
    translation,
    recommendation: article.recommendation,
    extracting: wantsExtraction(article),
    revision: articleRevision(article),
  }
}
