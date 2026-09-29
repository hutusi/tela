import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { useTitle } from '../lib/title'

export function LandingPage() {
  const t = useTranslations('home')
  useTitle(null)
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-16 animate-fade md:px-12">
      <h1 className="max-w-2xl font-serif text-[40px] font-medium leading-[1.1] tracking-tight">
        {t('title')}
      </h1>
      <p className="max-w-xl text-base leading-relaxed text-ink-2">{t('intro')}</p>
      <div>
        <Link
          to="/login"
          className="inline-block rounded-full bg-ink px-5 py-2.5 font-medium text-paper hover:no-underline hover:brightness-125"
        >
          {t('cta')}
        </Link>
      </div>
    </main>
  )
}
