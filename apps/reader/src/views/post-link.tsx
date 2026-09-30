import type { ArticleRow } from '@tela/sync'
import { Link } from 'react-router'
import type { MemberControls } from './types'

/**
 * A post on a public page. A member opens it in the reader; anyone else goes to the blog itself,
 * which is where a post without a reader belongs.
 */
export function PostLink({
  article,
  source,
  member,
  className,
  children,
}: {
  article: ArticleRow
  source: string | null
  member: MemberControls | undefined
  className: string
  /** What the link says: the post's title unless the page shows it another way (translated). */
  children?: React.ReactNode
}) {
  const label = children ?? article.title
  if (member) {
    return (
      <Link
        to={member.readHref(article)}
        onClick={() => member.hold(article, source)}
        className={className}
      >
        {label}
      </Link>
    )
  }
  return article.url ? (
    <a href={article.url} target="_blank" rel="noopener noreferrer" className={className}>
      {label}
    </a>
  ) : (
    <span className={className}>{label}</span>
  )
}
