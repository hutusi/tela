import { getTranslations } from 'next-intl/server'

/**
 * The site's one search input, shared so its action, field name and limit cannot drift apart.
 *
 * The header carries it from `xl`, the first width with room for 240px of it. The search page
 * carries it below `xl`, because otherwise the header's collapsed search link lands on a page with
 * nothing to type into — which is what it did between 640 and 1279px.
 */
export async function SearchField({
  query,
  className,
  testId,
}: {
  query?: string
  className: string
  testId: string
}) {
  const t = await getTranslations('nav')
  return (
    <form action="/search" method="get" className={className}>
      <span aria-hidden="true">⌕</span>
      <input
        type="search"
        name="q"
        defaultValue={query ?? ''}
        placeholder={t('search')}
        aria-label={t('search')}
        maxLength={100}
        data-testid={testId}
        className="w-full bg-transparent text-ink outline-none placeholder:text-muted"
      />
    </form>
  )
}
