/**
 * A page's own feeds (ADR 0062) as two small links: RSS of its newest posts, OPML of its blogs.
 * Plain links, not the router's: a feed is a file the browser or a feed reader opens, and the
 * service worker lets a navigation to one through to the network.
 */
import { useTranslations } from 'use-intl'

const LINK = 'text-muted underline-offset-2 hover:text-ink hover:underline'

export function FeedLinks({
  rss,
  opml,
  className = '',
}: {
  rss: string
  opml: string
  className?: string
}) {
  const t = useTranslations('feeds')
  return (
    <nav
      aria-label={t('label')}
      className={`text-[12.5px] text-muted ${className}`}
      data-testid="feed-links"
    >
      <a href={rss} type="application/rss+xml" title={t('rss')} className={LINK}>
        RSS
      </a>
      <span aria-hidden="true"> · </span>
      <a href={opml} type="text/x-opml" title={t('opml')} className={LINK}>
        OPML
      </a>
    </nav>
  )
}
