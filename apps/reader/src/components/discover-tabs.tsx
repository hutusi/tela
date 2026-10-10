/**
 * Discover's four tabs (ADR 0044): addresses, so each is a page of its own that works before any
 * script runs, underlined as Following's are. On a phone the row scrolls sideways rather than
 * wrapping: it is in the page, not the header, and its line runs to the screen's edges.
 */
import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { DISCOVER_TABS, type DiscoverTab, tabHref } from '../lib/discover-href'

export function DiscoverTabs({ tab }: { tab: DiscoverTab }) {
  const t = useTranslations('discover')
  return (
    <div className="-mx-4 mb-9 min-w-0 md:mx-0">
      {/* The rule is a shadow inside the row, not a border under it: a scrolling row clips what
          hangs below it, so the current tab's underline sits over the rule, inside. */}
      <nav
        className="flex gap-6 overflow-x-auto px-4 whitespace-nowrap shadow-[inset_0_-1px_0_var(--color-line)] [scrollbar-width:none] md:px-0"
        aria-label={t('title')}
        data-testid="discover-tabs"
      >
        {DISCOVER_TABS.map((k) => (
          <Link
            key={k}
            to={tabHref(k)}
            aria-current={k === tab ? 'page' : undefined}
            className={`shrink-0 border-b-2 py-2.5 font-medium hover:text-ink hover:no-underline ${
              k === tab ? 'border-ink text-ink' : 'border-transparent text-muted'
            }`}
            data-testid={`discover-tab-${k}`}
          >
            {t(`tabs.${k}`)}
          </Link>
        ))}
      </nav>
    </div>
  )
}
