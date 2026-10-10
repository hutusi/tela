/**
 * Discover's Articles (`/discover/articles`, ADR 0044): posts from the directory by topic and
 * language, the most recommended first or the newest. Pure, rendered by the SPA and the edge. The
 * sort is two links, not a switch, so it works before any script runs; "More" is a link to the
 * next page, which the app turns into more of this one.
 */
import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { LanguageFilter, TopicChips } from '../components/discover-filters'
import { PostRow } from '../components/discover-post'
import { type ArticlesParams, type ArticlesSort, articlesHref } from '../lib/discover-href'
import type { Hidden } from '../lib/discover-overlay'
import { DiscoverFrame } from './discover-frame'
import type { ArticlesData, DiscoverPost, MemberControls, Person, Reading } from './types'

/**
 * The posts a sort shows from the pages held, without the member's blogs: the most recommended
 * are the first page's recommended ones, then the newest; a post is listed once, where it first
 * comes. Newest is the stream alone.
 */
export function articlesList(
  pages: readonly ArticlesData[],
  sort: ArticlesSort,
  hidden: Hidden,
): DiscoverPost[] {
  const seen = new Set<number>()
  const out: DiscoverPost[] = []
  const add = (p: DiscoverPost) => {
    if (seen.has(p.article.id) || hidden(p.site.id, p.article.feedId)) return
    seen.add(p.article.id)
    out.push(p)
  }
  if (sort === 'recs') for (const p of pages[0]?.recommended ?? []) add(p)
  for (const page of pages) for (const p of page.posts) add(p)
  return out
}

const NOBODY: readonly Person[] = []
const nobody = () => NOBODY

const sortLink = (on: boolean) =>
  `rounded-md px-2.5 py-[5px] text-[12.5px] whitespace-nowrap hover:no-underline ${
    on
      ? 'bg-surface text-ink shadow-[0_1px_2px_rgba(0,0,0,.08)] hover:text-ink'
      : 'text-ink-2 hover:text-ink'
  }`

export function DiscoverArticlesView({
  posts,
  languages,
  next,
  params,
  member,
  reading,
  locale,
  now,
  followed = nobody,
  onMore,
  loadingMore = false,
}: {
  /** Null while the first page is on its way. */
  posts: readonly DiscoverPost[] | null
  languages: readonly { lang: string; count: number }[]
  /** The cursor of the page after these, if there is one. */
  next: string | null
  params: ArticlesParams
  member?: MemberControls | undefined
  reading: Reading
  locale: string
  now: number
  followed?: (post: DiscoverPost) => readonly Person[]
  /** More of this page in place, once the app runs: the link's own click, to prevent. */
  onMore?: ((event: React.MouseEvent<HTMLAnchorElement>) => void) | undefined
  loadingMore?: boolean
}) {
  const t = useTranslations('discover')
  // A filter or a sort starts again from the newest; a cursor is for the order it was cut in.
  const filtered = (over: Partial<ArticlesParams>) =>
    articlesHref({ ...params, cursor: null, ...over })
  return (
    <DiscoverFrame tab="articles">
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <TopicChips topic={params.topic} hrefOf={(topic) => filtered({ topic })} />
        <div className="flex-1" />
        <nav
          className="flex shrink-0 gap-0.5 rounded-lg bg-hover p-0.5"
          aria-label={t('articles.sortLabel')}
        >
          {(['recs', 'new'] as const).map((sort) => (
            <Link
              key={sort}
              to={filtered({ sort })}
              aria-current={params.sort === sort ? 'page' : undefined}
              className={sortLink(params.sort === sort)}
              data-testid={`articles-sort-${sort}`}
            >
              {t(`articles.sort.${sort}`)}
            </Link>
          ))}
        </nav>
        <LanguageFilter
          lang={params.lang}
          languages={languages}
          hrefOf={(lang) => filtered({ lang })}
          locale={locale}
        />
      </div>

      {posts === null ? (
        <div aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="border-b border-line py-[26px]">
              <div className="h-[92px] max-w-[740px] animate-pulse rounded-lg bg-hover" />
            </div>
          ))}
        </div>
      ) : posts.length === 0 && next === null ? (
        <p className="m-0 py-14 text-center text-muted" data-testid="articles-empty">
          {t('articles.empty')}
        </p>
      ) : (
        <div data-testid="articles-list">
          {posts.map((post) => (
            <PostRow
              key={post.article.id}
              post={post}
              member={member}
              reading={reading}
              locale={locale}
              now={now}
              followed={followed(post)}
            />
          ))}
        </div>
      )}

      {posts !== null && next !== null ? (
        <div className="pt-8 text-center">
          <Link
            to={articlesHref({ ...params, cursor: next })}
            onClick={onMore}
            aria-disabled={loadingMore || undefined}
            className={`inline-block rounded-full border border-thumb px-4 py-2 text-[13px] font-medium text-ink hover:border-ink hover:text-ink hover:no-underline ${
              loadingMore ? 'opacity-60' : ''
            }`}
            data-testid="articles-more"
          >
            {t('articles.more')}
          </Link>
        </div>
      ) : null}
    </DiscoverFrame>
  )
}
