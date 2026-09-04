import { getTranslations } from 'next-intl/server'
import { AppHeader } from '@/components/app-header'

export const dynamic = 'force-dynamic'

/** Placeholder until phase 6 ships the real Discover page. */
export default async function DiscoverPage() {
  const t = await getTranslations('home')
  return (
    <>
      <AppHeader active="discover" />
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 px-12 py-12 animate-fade">
        <h1 className="max-w-2xl font-serif text-[40px] font-medium leading-[1.1] tracking-tight">
          {t('title')}
        </h1>
        <p className="max-w-xl text-base leading-relaxed text-ink-2">{t('intro')}</p>
      </main>
    </>
  )
}
