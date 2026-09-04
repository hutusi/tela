import { getTranslations } from 'next-intl/server'
import { AppHeader } from '@/components/app-header'
import { requireUser } from '@/lib/auth'
import { AddFeedForm, OpmlForm } from './add-form'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('add')
  return { title: t('title') }
}

const KNOWN_ERRORS = new Set(['rate_limited'])

export default async function AddPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  await requireUser('/add')
  const t = await getTranslations('add')
  const { error } = await searchParams
  return (
    <>
      <AppHeader active="reading" />
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-8 py-12 animate-fade">
        <div>
          <h1 className="font-serif text-[34px] font-medium leading-tight tracking-tight">
            {t('title')}
          </h1>
          <p className="mt-2 text-[15px] leading-relaxed text-ink-2">{t('intro')}</p>
        </div>
        {error && KNOWN_ERRORS.has(error) ? (
          <p className="text-sm text-[oklch(0.5_0.15_25)]" data-testid="add-error">
            {t(`errors.${error}`)}
          </p>
        ) : null}
        <AddFeedForm />
        <div className="border-t border-line pt-8">
          <h2 className="font-serif text-[22px] font-medium">{t('opml')}</h2>
          <p className="mb-3 text-[13px] text-muted">{t('opmlHint')}</p>
          <OpmlForm />
        </div>
      </main>
    </>
  )
}
