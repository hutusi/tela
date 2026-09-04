import { LANGUAGE_NAMES, type UiLocale } from '@tela/shared'
import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { AppHeader } from '@/components/app-header'
import { ReadInMenu } from '@/components/read-in-menu'
import { requireUser } from '@/lib/auth'
import { getCurrentProfile } from '@/lib/profile'
import { getReadingLang } from '@/lib/reading'
import { SettingsForm } from './settings-form'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('settings')
  return { title: t('title') }
}

export default async function SettingsPage() {
  await requireUser('/settings')
  const [profile, t, locale, readingLang] = await Promise.all([
    getCurrentProfile(),
    getTranslations('settings'),
    getLocale(),
    getReadingLang(),
  ])
  const names = LANGUAGE_NAMES[locale as UiLocale] ?? LANGUAGE_NAMES.en
  return (
    <>
      <AppHeader active="settings" />
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-10 px-8 py-12 animate-fade">
        <div>
          <h1 className="font-serif text-[34px] font-medium leading-tight tracking-tight">
            {t('title')}
          </h1>
          {profile ? (
            <p className="mt-2 text-[15px] text-ink-2">
              {t('profileLink')}{' '}
              <Link href={`/@${profile.handle}`} data-testid="profile-link">
                @{profile.handle}
              </Link>
            </p>
          ) : null}
        </div>
        {profile ? (
          <SettingsForm
            handle={profile.handle}
            displayName={profile.displayName}
            bio={profile.bio}
            publicSubscriptions={profile.publicSubscriptions}
          />
        ) : null}
        <section className="flex flex-col gap-3 border-t border-line pt-8">
          <h2 className="font-serif text-[22px] font-medium">{t('reading')}</h2>
          <div className="flex flex-wrap items-center gap-3 text-[14px] text-ink-2">
            <span>{t('readingLang', { lang: names[readingLang] ?? readingLang })}</span>
            <ReadInMenu readingLang={readingLang} />
          </div>
        </section>
        <section className="flex flex-col gap-3 border-t border-line pt-8">
          <h2 className="font-serif text-[22px] font-medium">{t('data')}</h2>
          <p className="text-[14px] text-ink-2">{t('opmlHint')}</p>
          <div>
            <a
              href="/settings/opml"
              className="inline-block rounded-full border border-ink px-4 py-2 text-[13px] font-medium text-ink hover:bg-ink hover:text-paper hover:no-underline"
              data-testid="opml-export"
            >
              {t('opmlExport')}
            </a>
          </div>
        </section>
      </main>
    </>
  )
}
