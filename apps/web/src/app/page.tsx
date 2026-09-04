import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { AppHeader } from '@/components/app-header'
import { getSessionUser } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export default async function HomePage() {
  const user = await getSessionUser()
  if (user) redirect('/reading')
  const t = await getTranslations('home')
  return (
    <>
      <AppHeader />
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-12 py-16 animate-fade">
        <h1 className="max-w-2xl font-serif text-[40px] font-medium leading-[1.1] tracking-tight">
          {t('title')}
        </h1>
        <p className="max-w-xl text-base leading-relaxed text-ink-2">{t('intro')}</p>
        <div>
          <Link
            href="/login"
            className="inline-block rounded-full bg-ink px-5 py-2.5 font-medium text-paper hover:no-underline hover:brightness-125"
          >
            {t('cta')}
          </Link>
        </div>
      </main>
    </>
  )
}
