import { Link, useLocation } from 'react-router'
import { useTranslations } from 'use-intl'
import { useSession } from '../session'
import { useStore } from '../store/hooks'
import { AccountMenu } from './account-menu'
import { type DoorRequest, opensSheet, useFrontDoor } from './front-door'
import { Glyph, SEARCH } from './glyph'
import { CONTROL } from './header-control'
import { MemberLanguage, VisitorLanguage } from './language-menu'
import { LogoMark } from './logo'
import { SearchField } from './search-field'
import { ThemeMenu } from './theme-menu'

type NavKey = 'reading' | 'discover' | 'following' | 'writers'

const ACTIVE: [NavKey, RegExp][] = [
  ['reading', /^\/reading/],
  ['discover', /^\/(discover|s\/)/],
  ['following', /^\/following/],
  ['writers', /^\/writers/],
]

// Below `sm` the gaps and the pills' sides are the phone's (Tela v5): the member's three pills
// then fit at 360px beside the avatar alone, with some 15px to spare in English (Figtree,
// measured: a 231px row in 246px), and 35px in French. The header's own gap parts its groups, 28px
// from `lg` (the lockup, the nav, search); the controls on the right sit 8px apart in `CONTROLS`.
const HEADER =
  'sticky top-0 z-10 flex h-14 items-center gap-2 border-b border-line bg-paper px-4 sm:gap-2.5 lg:gap-7 lg:px-7'
const NAV =
  'flex min-w-0 gap-0.5 overflow-x-auto whitespace-nowrap text-sm sm:gap-1 lg:shrink-0 [scrollbar-width:none]'
const CONTROLS = 'flex shrink-0 items-center gap-2'

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
 * (ADR 0035), as soon as the device is known to hold no member: it does not wait for /me. Both
 * carry the theme menu and the same language circle (ADR 0040) from `sm` up; the controls on
 * the right are one family (`header-control.ts`).
 */
export function AppHeader() {
  return useVisitor() ? <VisitorHeader /> : <MemberHeader />
}

/**
 * Whether the page is a visitor's: a guest, or a session still unknown on a device holding no
 * one, so a visitor's controls never wait for /me.
 */
export function useVisitor(): boolean {
  const { status } = useSession()
  const { store } = useStore()
  return status === 'guest' || (status === 'unknown' && store.userId === null)
}

function usePill() {
  const t = useTranslations('nav')
  const location = useLocation()
  const active = ACTIVE.find(([, re]) => re.test(location.pathname))?.[0]
  return (key: NavKey, href: string) => (
    <Link
      to={href}
      data-testid={`nav-${key}`}
      className={`rounded-full px-2.5 py-1.5 font-medium text-ink hover:bg-hover hover:no-underline sm:px-3 ${active === key ? 'bg-hover' : ''}`}
    >
      {t(key)}
    </Link>
  )
}

/**
 * From `sm` up: the lockup, Discover and For writers, then the theme menu, the language circle,
 * Log in and Join; below `sm` only Join is left beside the nav, which stays the one item that
 * shrinks. At 360px the two pills and Join fit with some 50px to spare in English (Figtree,
 * measured), which the two circles, hidden there, would take; in French the nav is 14px short
 * there, and scrolls, as the one item that shrinks may. On a phone the footer carries the
 * language and the theme instead (`SiteFooter`). No Reading and no search: both are a member's.
 * Log in and Join are links, so they work before the script does, and open the sheet over the
 * page once it runs.
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
      <nav className={NAV}>
        {pill('discover', '/discover')}
        {pill('writers', '/writers')}
      </nav>
      <div className="flex-1" />
      <div className={CONTROLS}>
        <ThemeMenu />
        <VisitorLanguage className="hidden shrink-0 sm:block" />
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

/**
 * A member's header, and the one a device holding a member's rows shows until /me answers. From
 * `sm` up the theme menu sits after search and before the language circle. Below `sm` it is the
 * lockup, the nav and the avatar: the language, the theme and search are the first rows of the
 * account menu there (Tela v5), so the three pills have the room the circle took.
 */
function MemberHeader() {
  const { status } = useSession()
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
      <SearchField
        query={query}
        testId="search-input"
        compact
        className="hidden w-60 min-w-0 items-center gap-2 rounded-full border border-line bg-surface px-3.5 py-1.5 text-[13px] text-muted focus-within:border-muted xl:flex"
      />
      <div className={CONTROLS}>
        {/* Below `xl` search is one more circle of the family, so it sits with them. */}
        <Link
          to="/search"
          aria-label={t('search')}
          data-testid="search-link"
          className={`${CONTROL} hidden w-[34px] shrink-0 items-center justify-center text-muted hover:text-ink hover:no-underline sm:flex xl:hidden`}
        >
          <Glyph>{SEARCH}</Glyph>
        </Link>
        <ThemeMenu />
        {member ? <MemberLanguage className="hidden shrink-0 sm:block" /> : null}
        {member ? <AccountMenu /> : null}
      </div>
    </header>
  )
}
