import { Link, useLocation } from 'react-router'
import { useTranslations } from 'use-intl'
import { useSession } from '../session'
import { useReadingLang, useStore } from '../store/hooks'
import { useUi } from '../ui'
import { AccountMenu } from './account-menu'
import { type DoorRequest, opensSheet, useFrontDoor } from './front-door'
import { LogoMark } from './logo'
import { ReadInMenu } from './read-in-menu'
import { SearchField } from './search-field'
import { VisitorLocale } from './visitor-locale'

type NavKey = 'reading' | 'discover' | 'following'

const ACTIVE: [NavKey, RegExp][] = [
  ['reading', /^\/reading/],
  ['discover', /^\/(discover|s\/)/],
  ['following', /^\/following/],
]

const HEADER =
  'sticky top-0 z-10 flex h-14 items-center gap-2.5 border-b border-line bg-paper px-4 lg:gap-7 lg:px-7'
const NAV =
  'flex min-w-0 gap-1 overflow-x-auto whitespace-nowrap text-sm lg:shrink-0 [scrollbar-width:none]'

function Lockup() {
  return (
    <Link
      to="/"
      className="flex shrink-0 items-center gap-[9px] font-serif text-[26px] font-semibold tracking-tight text-ink hover:no-underline"
    >
      <LogoMark />
      {/* Below lg the mark carries the brand alone; sr-only keeps "Tela" as the name. */}
      <span className="sr-only lg:not-sr-only">Tela</span>
    </Link>
  )
}

/**
 * The header (DESIGN.md: three stages across `lg` and `xl`, and the nav is the one control
 * allowed to shrink, because it is the one that scrolls). A member's profile, dashboard, settings
 * and sign-out are in the menu under their avatar (Tela v2). A visitor gets a header of their own
 * (ADR 0035), as soon as the device is known to hold no member: it does not wait for /me.
 */
export function AppHeader() {
  const { status } = useSession()
  const { store } = useStore()
  const visitor = status === 'guest' || (status === 'unknown' && store.userId === null)
  return visitor ? <VisitorHeader /> : <MemberHeader />
}

function usePill() {
  const t = useTranslations('nav')
  const location = useLocation()
  const active = ACTIVE.find(([, re]) => re.test(location.pathname))?.[0]
  return (key: NavKey, href: string) => (
    <Link
      to={href}
      data-testid={`nav-${key}`}
      className={`rounded-full px-3 py-1.5 font-medium text-ink hover:bg-hover hover:no-underline ${active === key ? 'bg-hover' : ''}`}
    >
      {t(key)}
    </Link>
  )
}

/**
 * From `sm` up: the lockup, Discover, then Read in, Log in and Join; below `sm` only Join is left
 * beside the nav, which stays the one item that shrinks. No Reading and no search: both are a
 * member's. Log in and Join are links, so they work before the script does, and open the sheet
 * over the page once it runs.
 */
function VisitorHeader() {
  const t = useTranslations('nav')
  const pill = usePill()
  const door = useFrontDoor()
  const opens = (request: DoorRequest) => (e: React.MouseEvent) => {
    if (!door || !opensSheet(e)) return
    e.preventDefault()
    door(request)
  }
  return (
    <header className={HEADER}>
      <Lockup />
      <nav className={NAV}>{pill('discover', '/discover')}</nav>
      <div className="flex-1" />
      <VisitorLocale className="hidden shrink-0 sm:block" />
      <div className="flex shrink-0 items-center gap-1.5">
        <Link
          to="/login"
          onClick={opens({ mode: 'login' })}
          data-testid="nav-login"
          className="hidden whitespace-nowrap rounded-full px-3.5 py-1.5 text-[13px] font-medium text-ink hover:bg-hover hover:no-underline sm:block"
        >
          {t('logIn')}
        </Link>
        <Link
          to="/join"
          onClick={opens({ mode: 'join' })}
          data-testid="nav-join"
          className="whitespace-nowrap rounded-full bg-primary px-4 py-1.5 text-[13px] font-semibold text-on-primary hover:no-underline hover:brightness-125"
        >
          {t('join')}
        </Link>
      </div>
    </header>
  )
}

/** A member's header, and the one a device holding a member's rows shows until /me answers. */
function MemberHeader() {
  const { status } = useSession()
  const { locale } = useUi()
  const readingLang = useReadingLang(locale)
  const location = useLocation()
  const pill = usePill()
  const t = useTranslations('nav')
  const member = status === 'member'
  const query =
    location.pathname === '/search' ? (new URLSearchParams(location.search).get('q') ?? '') : ''
  return (
    <header className={HEADER}>
      <Lockup />
      <nav className={NAV}>
        {pill('reading', '/reading')}
        {pill('discover', '/discover')}
        {member ? pill('following', '/following') : null}
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
      {/* The UI locale is in Settings for a member. */}
      {member ? <ReadInMenu readingLang={readingLang} /> : null}
      {member ? <AccountMenu /> : null}
    </header>
  )
}
