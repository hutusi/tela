import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { useTitle } from '../lib/title'

export function NotFoundPage() {
  const t = useTranslations('notFound')
  useTitle(t('title'))
  return (
    <main
      className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 px-6 py-20 animate-fade"
      data-testid="not-found"
    >
      <h1 className="font-serif text-[34px] font-medium leading-tight tracking-tight">
        {t('title')}
      </h1>
      <p className="text-[15px] text-ink-2">{t('intro')}</p>
      <div>
        <Link
          to="/"
          className="inline-block rounded-full border border-ink px-4 py-2 text-[13px] font-medium text-ink hover:bg-ink hover:text-paper hover:no-underline"
        >
          {t('home')}
        </Link>
      </div>
    </main>
  )
}
