/**
 * The public pages' footer: who makes Tela, and the pages that say what it is, what it offers
 * writers and what it keeps.
 * Pure, like the views it closes: the edge renders it too.
 */
import { Link } from 'react-router'
import { useTranslations } from 'use-intl'

const LINK = 'text-ink-2 hover:text-ink hover:no-underline'

export function SiteFooter({ year }: { year: number }) {
  const t = useTranslations('footer')
  return (
    <footer
      className="border-t border-line px-4 py-8 text-[13px] text-muted md:px-12"
      data-testid="site-footer"
    >
      <div className="mx-auto flex w-full max-w-[1120px] flex-wrap items-center gap-x-6 gap-y-3">
        <p className="m-0">
          {t.rich('made', {
            // A string: a number would be formatted, and 2026 is not "2,026".
            year: String(year),
            maker: (chunks) => (
              <a href="https://ainaive.com" className={LINK}>
                {chunks}
              </a>
            ),
          })}
        </p>
        <div className="flex-1" />
        <nav aria-label={t('label')} className="flex flex-wrap gap-x-5 gap-y-2">
          <Link to="/about" className={LINK}>
            {t('about')}
          </Link>
          <Link to="/writers" className={LINK}>
            {t('writers')}
          </Link>
          <Link to="/privacy" className={LINK}>
            {t('privacy')}
          </Link>
          <Link to="/terms" className={LINK}>
            {t('terms')}
          </Link>
        </nav>
      </div>
    </footer>
  )
}
