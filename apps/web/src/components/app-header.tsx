import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { Suspense } from 'react'
import { signOut } from '@/app/login/actions'
import { getSessionUser } from '@/lib/auth'
import { getCurrentProfile } from '@/lib/profile'
import { getReadingLangState } from '@/lib/reading'
import { LocaleSwitcher } from './locale-switcher'
import { LogoMark } from './logo'
import { ReadInMenu } from './read-in-menu'
import { ReadingLangCookieSeed } from './reading-lang-cookie-seed'
import { SearchField } from './search-field'

type NavKey = 'reading' | 'discover' | 'dashboard' | 'settings'

/**
 * The member's avatar, which is the one thing in this header that can need the database — the
 * display name and handle live on the profile row. It renders inside its own Suspense boundary so
 * the header reaches the browser without waiting for a query, on every page that has a header.
 */
async function HeaderAvatar({ email }: { email: string | null }) {
  const profile = await getCurrentProfile()
  const initial = (profile?.displayName ?? profile?.handle ?? email ?? 'U').charAt(0).toUpperCase()
  return (
    <Link
      href={profile?.handle ? `/@${profile.handle}` : '/settings'}
      data-testid="nav-profile"
      className="flex size-[30px] items-center justify-center rounded-full bg-accent font-semibold text-white hover:no-underline"
      title={profile?.displayName ?? email ?? ''}
    >
      {initial}
    </Link>
  )
}

function HeaderAvatarSkeleton() {
  return <div aria-hidden className="size-[30px] rounded-full bg-hover" />
}

export async function AppHeader({ active, query }: { active?: NavKey; query?: string }) {
  const [t, user, locale] = await Promise.all([
    getTranslations('nav'),
    getSessionUser(),
    getLocale(),
  ])
  const pill = (key: NavKey, href: string) => (
    <Link
      href={href}
      data-testid={`nav-${key}`}
      className={`rounded-full px-3 py-1.5 font-medium text-ink hover:bg-hover hover:no-underline ${active === key ? 'bg-hover' : ''}`}
    >
      {t(key)}
    </Link>
  )
  return (
    <header className="sticky top-0 z-10 flex h-14 items-center gap-2.5 border-b border-line bg-paper px-4 lg:gap-7 lg:px-7">
      <Link
        href="/"
        className="flex shrink-0 items-center gap-[9px] font-serif text-[26px] font-semibold tracking-tight text-ink hover:no-underline"
      >
        <LogoMark />
        {/* Below lg the mark carries the brand alone. This header holds four nav pills, two
            language switchers and the account controls: beside the wordmark and the 240px search
            field they do not fit a tablet, and the nav is the part that must not be given up.
            The two arrive at different breakpoints for the same reason: turning both on at lg
            wrapped the Read-in and locale labels onto two lines from 1024 to 1280.
            sr-only rather than hidden keeps "Tela" as the link's accessible name at every width. */}
        <span className="sr-only lg:not-sr-only">Tela</span>
      </Link>
      <nav className="flex min-w-0 gap-1 overflow-x-auto whitespace-nowrap text-sm lg:shrink-0 [scrollbar-width:none]">
        {pill('reading', '/reading')}
        {pill('discover', '/discover')}
        {user ? pill('dashboard', '/dashboard') : null}
        {user ? pill('settings', '/settings') : null}
      </nav>
      {/* From sm up, the nav is the only thing meant to give way — it scrolls, and squeezed below
          its one-line width every other control wraps its label into the 56px header instead.
          Below sm they stay shrinkable: the phone header has no room to spare and a wrapped pill
          beats a nav with nothing left to scroll. */}
      <div className="flex-1" />
      <Link
        href="/search"
        aria-label={t('search')}
        data-testid="search-link"
        className="hidden size-[34px] shrink-0 items-center justify-center rounded-full border border-line bg-white text-[15px] text-muted hover:border-muted hover:text-ink hover:no-underline sm:flex xl:hidden"
      >
        <span aria-hidden="true">⌕</span>
      </Link>
      <SearchField
        query={query}
        testId="search-input"
        className="hidden w-60 min-w-0 items-center gap-2 rounded-full border border-line bg-white px-3.5 py-1.5 text-[13px] text-muted focus-within:border-muted xl:flex"
      />
      {user ? (
        <Suspense fallback={null}>
          <ReadInMenuAsync />
        </Suspense>
      ) : null}
      <LocaleSwitcher locale={locale} />
      {user ? (
        <form action={signOut} className="flex items-center gap-2 sm:shrink-0">
          <Suspense fallback={<HeaderAvatarSkeleton />}>
            <HeaderAvatar email={user.email} />
          </Suspense>
          <button
            type="submit"
            className="text-[13px] text-muted hover:text-ink"
            data-testid="sign-out"
          >
            {t('signOut')}
          </button>
        </form>
      ) : (
        <Link
          href="/login"
          className="rounded-full bg-ink px-3.5 py-1.5 text-[13px] font-medium text-paper hover:no-underline"
        >
          {t('signIn')}
        </Link>
      )}
    </header>
  )
}

/**
 * The reading language usually comes from a cookie, but a member whose cookie has not been
 * written yet falls back to the profile row — a query, and one this header must not block on.
 */
async function ReadInMenuAsync() {
  const { lang, seed } = await getReadingLangState()
  return (
    <>
      <ReadInMenu readingLang={lang} />
      {seed ? <ReadingLangCookieSeed userId={seed.userId} lang={seed.lang} /> : null}
    </>
  )
}
