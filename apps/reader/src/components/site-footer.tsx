/**
 * The public pages' footer: who makes Tela, and the pages that say what it is, what it offers
 * writers and what it keeps. Laid out as Tela Public closes its pages (ADR 0070): the name in
 * serif, the maker, and the links at the right, on the public pages' 1120px measure. A visitor
 * on a phone finds the language and the theme here first (Tela v5), since their header has room
 * for neither. The edge renders it too, as a guest, in the language it renders the page in.
 */
import { useId } from 'react'
import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { useVisitor } from './app-header'
import { CHEVRON_DOWN, Glyph } from './glyph'
import { endonym, useVisitorLanguage } from './language-menu'
import { ThemeSwitch } from './theme-menu'

const LINK = 'text-ink-2 hover:text-ink hover:no-underline'

export function SiteFooter({ year }: { year: number }) {
  const t = useTranslations('footer')
  const visitor = useVisitor()
  return (
    <footer
      className="border-t border-line text-[13.5px] leading-[1.2] text-muted"
      data-testid="site-footer"
    >
      <div className="mx-auto flex w-full max-w-[1120px] flex-wrap items-center gap-x-6 gap-y-3 px-5 pt-[26px] pb-10 md:px-12">
        {visitor ? <PhoneChoices /> : null}
        <span className="font-serif text-[19px] leading-none font-semibold text-ink">Tela</span>
        <p className="m-0">
          {t.rich('made', {
            // A string: a number would be formatted, and 2026 is not "2,026".
            year: String(year),
            maker: (chunks) => (
              <a href="https://ainaive.com" className={`${LINK} font-medium`}>
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

/**
 * Below `sm`, the language and the theme the visitor header shows as circles from `sm` up, and
 * doing what they do (`useVisitorLanguage`, `useThemeChoice`). The language is a native select,
 * so a phone opens its own list, at 16px: iOS Safari zooms the page into a field set any smaller
 * when it takes focus. Choosing needs the script.
 */
function PhoneChoices() {
  const t = useTranslations('footer')
  const { options, value, choose } = useVisitorLanguage()
  const id = useId()
  return (
    <div
      className="flex w-full flex-col gap-2.5 border-b border-line pb-4 sm:hidden"
      data-testid="footer-choices"
    >
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id}>{t('language')}</label>
        <span className="relative text-ink">
          <select
            id={id}
            value={value}
            onChange={(e) => {
              const code = options.find((o) => o === e.target.value)
              if (code) choose(code)
            }}
            data-testid="footer-language"
            className="min-h-10 cursor-pointer appearance-none rounded-full border border-line bg-surface py-0 pr-8 pl-3.5 text-base text-ink"
          >
            {options.map((code) => (
              <option key={code} value={code} lang={code}>
                {endonym(code)}
              </option>
            ))}
          </select>
          <Glyph
            size={12}
            className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2"
          >
            {CHEVRON_DOWN}
          </Glyph>
        </span>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span>{t('theme')}</span>
        <ThemeSwitch label={t('theme')} testId="footer-theme" />
      </div>
    </div>
  )
}
