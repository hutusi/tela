import type { ArticleRow } from '@tela/sync'
import { Link } from 'react-router'
import type { MemberControls } from './types'

/**
 * The `rel` of a public page's link out to a blog (ADR 0060). A blog an operator listed is vouched
 * for, and its link is an ordinary one. Any other came by someone Tela has not vouched for (a
 * member who added it, a claim, a blogroll), and its link says so, `ugc nofollow`: with sign-up
 * open, a link from an indexed page on telaread.com must not be something anyone can make.
 */
export function outboundRel(vouched: boolean): string {
  return vouched ? 'noopener noreferrer' : 'ugc nofollow noopener noreferrer'
}

/**
 * A post on a public page. A member opens it in the reader; anyone else goes to the blog itself,
 * which is where a post without a reader belongs, by a link `outboundRel` qualifies.
 */
export function PostLink({
  article,
  source,
  member,
  vouched = false,
  className,
  children,
}: {
  article: ArticleRow
  source: string | null
  member: MemberControls | undefined
  /** An operator listed the post's blog: its link is followed. */
  vouched?: boolean | undefined
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
    <a href={article.url} target="_blank" rel={outboundRel(vouched)} className={className}>
      {label}
    </a>
  ) : (
    <span className={className}>{label}</span>
  )
}
