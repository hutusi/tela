import { sites } from '@tela/db'
import { count } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { getDb, isDatabaseConfigured } from '@/lib/platform/db'

export const dynamic = 'force-dynamic'

async function siteCount(): Promise<number | null> {
  try {
    const db = await getDb()
    const [row] = await db.select({ n: count() }).from(sites)
    return row?.n ?? 0
  } catch (err) {
    console.error('[home] site count failed', err)
    return null
  }
}

export default async function HomePage() {
  const t = await getTranslations()
  const n = await siteCount()
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-8 py-16 animate-fade">
      <header className="flex items-center gap-7 border-line border-b pb-4">
        <span className="font-serif text-[26px] font-semibold tracking-tight">{t('app.name')}</span>
        <nav className="flex gap-1 text-sm font-medium">
          <span className="rounded-full bg-hover px-3 py-1.5">{t('nav.reading')}</span>
          <span className="rounded-full px-3 py-1.5 text-ink-2">{t('nav.discover')}</span>
        </nav>
      </header>
      <h1 className="font-serif text-[40px] font-medium leading-[1.1] tracking-tight">
        {t('home.title')}
      </h1>
      <p className="max-w-xl text-base leading-relaxed text-ink-2">{t('home.intro')}</p>
      <p className="text-sm text-muted">
        {n === null && !isDatabaseConfigured() ? t('home.dbMissing') : null}
        {n === null && isDatabaseConfigured() ? t('home.dbMissing') : null}
        {n !== null ? t('home.dbConnected', { sites: n }) : null}
      </p>
    </main>
  )
}
