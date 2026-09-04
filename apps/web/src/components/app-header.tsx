import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { signOut } from '@/app/login/actions'
import { getSessionUser } from '@/lib/auth'
import { getCurrentProfile } from '@/lib/profile'
import { getReadingLang } from '@/lib/reading'
import { LocaleSwitcher } from './locale-switcher'
import { ReadInMenu } from './read-in-menu'

type NavKey = 'reading' | 'discover' | 'dashboard' | 'settings'

export async function AppHeader({ active, query }: { active?: NavKey; query?: string }) {
  const [t, user, locale] = await Promise.all([
    getTranslations('nav'),
    getSessionUser(),
    getLocale(),
  ])
  const profile = user ? await getCurrentProfile() : null
  const pill = (key: NavKey, href: string) => (
    <Link
      href={href}
      data-testid={`nav-${key}`}
      className={`rounded-full px-3 py-1.5 font-medium hover:bg-hover ${active === key ? 'bg-hover text-ink' : 'text-ink-2'}`}
    >
      {t(key)}
    </Link>
  )
  const initial = (profile?.displayName ?? profile?.handle ?? user?.email ?? 'U')
    .charAt(0)
    .toUpperCase()
  return (
    <header className="sticky top-0 z-10 flex h-14 items-center gap-7 border-b border-line bg-paper px-7">
      <Link
        href="/"
        className="font-serif text-[26px] font-semibold tracking-tight text-ink hover:no-underline"
      >
        Tela
      </Link>
      <nav className="flex gap-1 text-sm">
        {pill('reading', '/reading')}
        {pill('discover', '/discover')}
        {user ? pill('dashboard', '/dashboard') : null}
        {user ? pill('settings', '/settings') : null}
      </nav>
      <div className="flex-1" />
      <form
        action="/search"
        method="get"
        role="search"
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
      {user ? <ReadInMenu readingLang={await getReadingLang()} /> : null}
      <LocaleSwitcher locale={locale} />
      {user ? (
        <form action={signOut} className="flex items-center gap-2">
          <Link
            href={profile?.handle ? `/@${profile.handle}` : '/settings'}
            data-testid="nav-profile"
            className="flex size-[30px] items-center justify-center rounded-full bg-accent font-semibold text-white hover:no-underline"
            title={profile?.displayName ?? user.email ?? ''}
          >
            {initial}
          </Link>
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
