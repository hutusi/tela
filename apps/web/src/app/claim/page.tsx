import { getTranslations } from 'next-intl/server'
import { AppHeader } from '@/components/app-header'
import { requireUser } from '@/lib/auth'
import { ClaimStartForm } from './claim-form'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('claim')
  return { title: t('title') }
}

/** Step 1 of claiming: tell us your blog's address. */
export default async function ClaimPage() {
  await requireUser('/claim')
  const t = await getTranslations('claim')
  return (
    <>
      <AppHeader active="discover" />
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-8 py-12 animate-fade">
        <div>
          <h1 className="font-serif text-[34px] font-medium leading-tight tracking-tight">
            {t('title')}
          </h1>
          <p className="mt-2 text-[15px] leading-relaxed text-ink-2">{t('intro')}</p>
        </div>
        <ClaimStartForm />
      </main>
    </>
  )
}
