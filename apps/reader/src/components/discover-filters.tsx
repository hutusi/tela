/**
 * Discover's filters (Articles and Blogs): topic chips and the language menu. Links all of them,
 * so a page the edge rendered filters before any script runs; the menu is a native `<details>`.
 */
import { asLabel, LANGUAGE_NAMES, TOPICS, type UiLocale } from '@tela/shared'
import { Link } from 'react-router'
import { useTranslations } from 'use-intl'

export const chip = (on: boolean) =>
  `rounded-full border px-3.5 py-1.5 text-[13px] hover:no-underline ${
    on ? 'border-ink bg-ink text-paper' : 'border-line text-ink-2 hover:border-ink'
  }`

const menuItem = (on: boolean) =>
  `flex justify-between gap-3 rounded-md px-2.5 py-[7px] text-[13px] text-ink hover:bg-hover hover:no-underline ${on ? 'bg-hover' : ''}`

/** "All" and each topic; the chosen one again goes back to all. */
export function TopicChips({
  topic,
  hrefOf,
}: {
  topic: string | null
  hrefOf: (topic: string | null) => string
}) {
  const t = useTranslations('discover')
  return (
    <div className="flex flex-wrap gap-2" data-testid="topic-chips">
      <Link to={hrefOf(null)} className={chip(topic === null)}>
        {t('allTopics')}
      </Link>
      {TOPICS.map((k) => (
        <Link key={k} to={hrefOf(topic === k ? null : k)} className={chip(topic === k)}>
          {t(`topics.${k}`)}
        </Link>
      ))}
    </div>
  )
}

export function LanguageFilter({
  lang,
  languages,
  hrefOf,
  locale,
}: {
  lang: string | null
  languages: readonly { lang: string; count: number }[]
  hrefOf: (lang: string | null) => string
  locale: string
}) {
  const t = useTranslations('discover')
  const names = LANGUAGE_NAMES[locale as UiLocale] ?? LANGUAGE_NAMES.en
  // The menu's value and items are labels: "Japonais", where a French sentence says "japonais".
  const label = (tag: string) => asLabel(names[tag] ?? tag, locale)
  return (
    // A <details>, so the menu works in the edge-rendered page before any script runs.
    <details className="relative" data-testid="discover-language">
      <summary
        className={`flex cursor-pointer list-none items-center gap-1.5 whitespace-nowrap rounded-full border bg-surface px-3 py-1.5 text-[13px] font-medium hover:border-muted ${
          lang ? 'border-ink' : 'border-line'
        }`}
      >
        <span className="font-normal text-muted">{t('language')}</span>
        {lang ? label(lang) : t('allLanguages')}
        <span className="text-[10px] text-muted">▾</span>
      </summary>
      <div className="absolute right-0 top-[calc(100%+6px)] z-[4] flex min-w-[180px] flex-col rounded-[10px] border border-line bg-surface p-1.5 shadow-[0_8px_24px_rgba(0,0,0,.08)] animate-fade">
        <Link to={hrefOf(null)} className={menuItem(lang === null)}>
          <span>{t('allLanguages')}</span>
          <span className="text-xs text-muted">{languages.reduce((n, l) => n + l.count, 0)}</span>
        </Link>
        {languages.map((l) => (
          <Link key={l.lang} to={hrefOf(l.lang)} className={menuItem(lang === l.lang)}>
            <span>{label(l.lang)}</span>
            <span className="text-xs text-muted">{l.count}</span>
          </Link>
        ))}
      </div>
    </details>
  )
}

/** A section's 11px label, with its "All … →" link on the right. */
export function SectionHead({
  label,
  link,
  first = false,
  testId,
  span,
}: {
  label: string
  link?: { to: string; text: string } | undefined
  /** The page's first section, which needs no room above it. */
  first?: boolean
  testId?: string
  span?: string
}) {
  return (
    <div
      className={`mb-4 flex items-baseline justify-between gap-4 ${first ? '' : 'mt-16'}`}
      data-testid={testId}
      data-span={span}
    >
      <h2 className="m-0 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
        {label}
      </h2>
      {link ? (
        <Link
          to={link.to}
          className="shrink-0 whitespace-nowrap text-[13px] text-muted hover:text-ink hover:no-underline"
        >
          {link.text}
        </Link>
      ) : null}
    </div>
  )
}
