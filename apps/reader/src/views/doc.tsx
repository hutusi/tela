/**
 * A section of For writers or of How Tela reads your blog (ADR 0070): one 680px column, a rule
 * over each section, a serif head, an opening paragraph, then its points, each a short sans
 * heading over running text. Each section keeps its anchor (`#claiming`, `#reading`…), the same in
 * every language, and each point a test id after it.
 */
import type { ReactNode } from 'react'
import { useTranslations } from 'use-intl'
import { BODY, CODE, HEAD, ITEM } from './public-type'

/** The column the sections sit in. */
export const DOC_COLUMN = 'max-w-[680px]'

const code = (chunks: ReactNode) => <code className={CODE}>{chunks}</code>
const mail = (chunks: ReactNode) => (
  <a
    href="mailto:me@hutu.si"
    className="text-ink underline decoration-underline underline-offset-[3px] hover:text-ink hover:decoration-current"
  >
    {chunks}
  </a>
)

/** A paragraph of the writers' catalog, with its code and its address marked up. */
export function useDocText() {
  const t = useTranslations('writers')
  return (key: string, className = BODY) => (
    <p className={className}>{t.rich(key, { code, mail })}</p>
  )
}

export function DocSection({
  id,
  title,
  intro,
  first = false,
  children,
}: {
  id: string
  /** None for a section the page's own title already names. */
  title?: string | undefined
  intro?: ReactNode
  /** The first section under a page's title sits closer to it. */
  first?: boolean
  children: ReactNode
}) {
  return (
    <section
      id={id}
      className={`scroll-mt-14 border-t border-line pt-3.5 ${first ? 'mt-9' : 'mt-[52px]'} ${
        // Untitled, its first point sits just under the rule.
        title ? '' : '[&>:first-child>li:first-child]:mt-1.5'
      }`}
      data-testid={`writers-${id}`}
    >
      {title ? (
        <h2 className={`${HEAD} leading-[1.25] [font-size:calc(clamp(24px,3vw,30px)*var(--hs))]`}>
          {title}
        </h2>
      ) : null}
      {intro}
      {children}
    </section>
  )
}

/** A section's points, numbered when the order matters ("How it works"). */
export function DocItems({
  numbered = false,
  children,
}: {
  numbered?: boolean
  children: ReactNode
}) {
  const List = numbered ? 'ol' : 'ul'
  return <List className="m-0 list-none p-0">{children}</List>
}

/** One point: its number when the list is numbered, a short heading, and what it means. */
export function DocItem({
  id,
  n,
  title,
  children,
}: {
  id: string
  n?: number | undefined
  title: string
  children: ReactNode
}) {
  return (
    <li
      className={`mt-5 ${n ? 'grid grid-cols-[28px_minmax(0,1fr)] gap-x-3.5' : ''}`}
      data-testid={`writers-${id}`}
    >
      {n ? (
        <span aria-hidden="true" className="font-serif text-[24px] leading-[1.05] text-muted">
          {n}
        </span>
      ) : null}
      <div className="flex min-w-0 flex-col gap-[5px]">
        <h3 className={ITEM}>{title}</h3>
        {children}
      </div>
    </li>
  )
}
