import { useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useTranslations } from 'use-intl'
import { CLOSE, Glyph, SEARCH } from './glyph'

/**
 * The site's one search input. The header carries it from `xl`, the search page below `xl`, so
 * exactly one is visible at any width (DESIGN.md).
 *
 * The URL owns the query; the field holds what is being typed, and takes the URL's query again
 * whenever that changes (a submit, Back, a link) without remounting, so focus survives a search.
 * Its own clear button empties the field and nothing else: the results stay until the next
 * search, as the browser's own clear did (hidden in styles.css, since it drew differently in each).
 */
export function SearchField({
  query = '',
  className,
  testId,
  glyphClassName,
  compact = false,
}: {
  query?: string
  className: string
  testId: string
  /** Classes for the search glyph, e.g. a phone's size. */
  glyphClassName?: string
  /** The header's pill: a smaller cross in its clear button. */
  compact?: boolean
}) {
  const t = useTranslations('nav')
  const ts = useTranslations('search')
  const navigate = useNavigate()
  const input = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(query)
  const [asked, setAsked] = useState(query)
  if (query !== asked) {
    setAsked(query)
    setValue(query)
  }
  // The cross sits on the pill's padding edge, and its 44px target hangs over the padding and past
  // the pill above and below, so the pill is no taller with it than without.
  const cross = compact ? 12 : 14
  return (
    <form
      action="/search"
      method="get"
      className={className}
      onSubmit={(e) => {
        e.preventDefault()
        // A touch screen's keyboard would stay up over the results, which the field kept focus
        // for; a pointer's member may want to refine the query, so there it keeps focus.
        if (window.matchMedia('(pointer: coarse)').matches) input.current?.blur()
        navigate(`/search?q=${encodeURIComponent(value.trim())}`)
      }}
    >
      <Glyph className={`block shrink-0 ${glyphClassName ?? ''}`}>{SEARCH}</Glyph>
      <input
        ref={input}
        type="search"
        name="q"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={t('search')}
        aria-label={t('search')}
        maxLength={100}
        data-testid={testId}
        className="w-full min-w-0 bg-transparent text-ink outline-none placeholder:text-muted"
      />
      {value !== '' ? (
        <button
          type="button"
          onClick={() => {
            setValue('')
            input.current?.focus()
          }}
          aria-label={ts('clear')}
          className={`-my-3.5 flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted hover:text-ink ${compact ? '-mr-4' : '-mr-[15px]'}`}
          data-testid={`${testId}-clear`}
        >
          <Glyph size={cross}>{CLOSE}</Glyph>
        </button>
      ) : null}
    </form>
  )
}
