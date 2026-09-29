import { Link, useLocation } from 'react-router'
import { useTranslations } from 'use-intl'
import { useSession } from '../session'
import { useReadingLang, useTables } from '../store/hooks'
import { useUi } from '../ui'
import { LocaleSwitcher } from './locale-switcher'
import { LogoMark } from './logo'
import { ReadInMenu } from './read-in-menu'
import { SearchField } from './search-field'

type NavKey = 'reading' | 'discover' | 'dashboard' | 'settings'

const ACTIVE: [NavKey, RegExp][] = [
  ['reading', /^\/reading/],
  ['discover', /^\/(discover|s\/)/],
  ['dashboard', /^\/dashboard/],
  ['settings', /^\/settings/],
]

/** The member's initial, linking to their profile; everything it needs is in the local store. */
function HeaderAvatar() {
  const tables = useTables()
  const profile = tables.profile
  const initial = (profile?.displayName ?? profile?.handle ?? 'U').charAt(0).toUpperCase()
  return (
    <Link
      to={profile?.handle ? `/@${profile.handle}` : '/settings'}
      data-testid="nav-profile"
      className="flex size-[30px] items-center justify-center rounded-full bg-accent font-semibold text-white hover:no-underline"
      title={profile?.displayName ?? profile?.handle ?? ''}
    >
      {initial}
    </Link>
  )
}

/**
 * The header (DESIGN.md: three stages across `lg` and `xl`, and the nav is the one control
 * allowed to shrink, because it is the one that scrolls).
 */
export function AppHeader() {
  const t = useTranslations('nav')
  const { status, signOut } = useSession()
  const { locale } = useUi()
  const readingLang = useReadingLang(locale)
  const location = useLocation()
  const member = status === 'member'
  const active = ACTIVE.find(([, re]) => re.test(location.pathname))?.[0]
  const query =
    location.pathname === '/search' ? (new URLSearchParams(location.search).get('q') ?? '') : ''
  const pill = (key: NavKey, href: string) => (
    <Link
      to={href}
      data-testid={`nav-${key}`}
      className={`rounded-full px-3 py-1.5 font-medium text-ink hover:bg-hover hover:no-underline ${active === key ? 'bg-hover' : ''}`}
    >
      {t(key)}
    </Link>
  )
  return (
    <header className="sticky top-0 z-10 flex h-14 items-center gap-2.5 border-b border-line bg-paper px-4 lg:gap-7 lg:px-7">
      <Link
        to="/"
        className="flex shrink-0 items-center gap-[9px] font-serif text-[26px] font-semibold tracking-tight text-ink hover:no-underline"
      >
        <LogoMark />
        {/* Below lg the mark carries the brand alone; sr-only keeps "Tela" as the name. */}
        <span className="sr-only lg:not-sr-only">Tela</span>
      </Link>
      <nav className="flex min-w-0 gap-1 overflow-x-auto whitespace-nowrap text-sm lg:shrink-0 [scrollbar-width:none]">
        {pill('reading', '/reading')}
        {pill('discover', '/discover')}
        {member ? pill('dashboard', '/dashboard') : null}
        {member ? pill('settings', '/settings') : null}
      </nav>
      <div className="flex-1" />
      <Link
        to="/search"
        aria-label={t('search')}
        data-testid="search-link"
        className="hidden size-[34px] shrink-0 items-center justify-center rounded-full border border-line bg-surface text-[15px] text-muted hover:border-muted hover:text-ink hover:no-underline sm:flex xl:hidden"
      >
        <span aria-hidden="true">⌕</span>
      </Link>
      <SearchField
        key={query}
        query={query}
        testId="search-input"
        className="hidden w-60 min-w-0 items-center gap-2 rounded-full border border-line bg-surface px-3.5 py-1.5 text-[13px] text-muted focus-within:border-muted xl:flex"
      />
      {member ? <ReadInMenu readingLang={readingLang} /> : null}
      <LocaleSwitcher />
      {member ? (
        <div className="flex items-center gap-2 sm:shrink-0">
          <HeaderAvatar />
          <button
            type="button"
            className="text-[13px] text-muted hover:text-ink"
            data-testid="sign-out"
            onClick={() => void signOut()}
          >
            {t('signOut')}
          </button>
        </div>
      ) : status === 'guest' ? (
        <Link
          to="/login"
          className="rounded-full bg-ink px-3.5 py-1.5 text-[13px] font-medium text-paper hover:no-underline"
        >
          {t('signIn')}
        </Link>
      ) : null}
    </header>
  )
}
