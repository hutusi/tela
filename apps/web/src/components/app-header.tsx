import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { signOut } from '@/app/login/actions'
import { getSessionUser } from '@/lib/auth'
import { LocaleSwitcher } from './locale-switcher'

export async function AppHeader({ active }: { active?: 'reading' | 'discover' }) {
  const [t, user, locale] = await Promise.all([
    getTranslations('nav'),
    getSessionUser(),
    getLocale(),
  ])
  const pill = (key: 'reading' | 'discover', href: string) => (
    <Link
      href={href}
      className={`rounded-full px-3 py-1.5 font-medium hover:bg-hover ${active === key ? 'bg-hover text-ink' : 'text-ink-2'}`}
    >
      {t(key)}
    </Link>
  )
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
      </nav>
      <div className="flex-1" />
      <div className="hidden min-w-60 items-center gap-2 rounded-full border border-line bg-white px-3.5 py-1.5 text-[13px] text-muted md:flex">
        <span>⌕</span>
        <span>{t('search')}</span>
      </div>
      <LocaleSwitcher locale={locale} />
      {user ? (
        <form action={signOut} className="flex items-center gap-2">
          <span
            className="flex size-[30px] items-center justify-center rounded-full bg-accent font-semibold text-white"
            title={user.email ?? ''}
          >
            {(user.email ?? 'U').charAt(0).toUpperCase()}
          </span>
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
