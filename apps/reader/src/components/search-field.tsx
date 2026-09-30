import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useTranslations } from 'use-intl'

/**
 * The site's one search input. The header carries it from `xl`, the search page below `xl`, so
 * exactly one is visible at any width (DESIGN.md).
 */
export function SearchField({
  query,
  className,
  testId,
}: {
  query?: string
  className: string
  testId: string
}) {
  const t = useTranslations('nav')
  const navigate = useNavigate()
  const [value, setValue] = useState(query ?? '')
  return (
    <form
      action="/search"
      method="get"
      className={className}
      onSubmit={(e) => {
        e.preventDefault()
        navigate(`/search?q=${encodeURIComponent(value.trim())}`)
      }}
    >
      <span aria-hidden="true">⌕</span>
      <input
        type="search"
        name="q"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={t('search')}
        aria-label={t('search')}
        maxLength={100}
        data-testid={testId}
        className="w-full bg-transparent text-ink outline-none placeholder:text-muted"
      />
    </form>
  )
}
