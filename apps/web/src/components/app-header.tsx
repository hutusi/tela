import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { Suspense } from 'react'
import { signOut } from '@/app/login/actions'
import { getSessionUser } from '@/lib/auth'
import { getCurrentProfile } from '@/lib/profile'
import { getReadingLangState } from '@/lib/reading'
import { LocaleSwitcher } from './locale-switcher'
import { ReadInMenu } from './read-in-menu'
import { ReadingLangCookieSeed } from './reading-lang-cookie-seed'

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
      className={`rounded-full px-3 py-1.5 font-medium hover:bg-hover ${active === key ? 'bg-hover text-ink' : 'text-ink-2'}`}
    >
      {t(key)}
    </Link>
  )
  return (
    <header className="sticky top-0 z-10 flex h-14 items-center gap-3 border-b border-line bg-paper px-4 md:gap-7 md:px-7">
      <Link
        href="/"
        className="font-serif text-[26px] font-semibold tracking-tight text-ink hover:no-underline"
      >
        Tela
      </Link>
      <nav className="flex min-w-0 gap-1 overflow-x-auto whitespace-nowrap text-sm [scrollbar-width:none]">
        {pill('reading', '/reading')}
        {pill('discover', '/discover')}
        {user ? pill('dashboard', '/dashboard') : null}
        {user ? pill('settings', '/settings') : null}
      </nav>
      <div className="flex-1" />
      <form
        action="/search"
        method="get"
        className="hidden min-w-60 items-center gap-2 rounded-full border border-line bg-white px-3.5 py-1.5 text-[13px] text-muted focus-within:border-muted md:flex"
      >
        <span aria-hidden="true">⌕</span>
        <input
          type="search"
          name="q"
          defaultValue={query ?? ''}
          placeholder={t('search')}
          aria-label={t('search')}
          maxLength={100}
          data-testid="search-input"
          className="w-full bg-transparent text-ink outline-none placeholder:text-muted"
        />
      </form>
      {user ? (
        <Suspense fallback={null}>
          <ReadInMenuAsync />
        </Suspense>
      ) : null}
      <LocaleSwitcher locale={locale} />
      {user ? (
        <form action={signOut} className="flex items-center gap-2">
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
