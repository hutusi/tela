/**
 * Settings. The profile shown is the synced row, so a change made on another device is here; a
 * handle has to be unique, so saving is an RPC, and the row comes back by sync.
 */
import { LANGUAGE_NAMES, type UiLocale } from '@tela/shared'
import type { ProfileRow } from '@tela/sync'
import { useState } from 'react'
import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { ReadInMenu } from '../components/read-in-menu'
import { useTitle } from '../lib/title'
import { apiJson } from '../store/api'
import { useReadingLang, useStore, useTables } from '../store/hooks'
import { useUi } from '../ui'

export function SettingsPage() {
  const t = useTranslations('settings')
  const tables = useTables()
  const { locale } = useUi()
  const readingLang = useReadingLang(locale)
  const names = LANGUAGE_NAMES[locale as UiLocale] ?? LANGUAGE_NAMES.en
  const profile = tables.profile
  // Here, not in the form: saving changes the values the form is keyed by, and the answer has to
  // outlive the form it came from.
  const [state, setState] = useState<SaveState>({ saved: false, error: null })
  useTitle(t('title'))

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-10 px-4 py-12 animate-fade md:px-8">
      <div>
        <h1 className="font-serif text-[34px] font-medium leading-tight tracking-tight">
          {t('title')}
        </h1>
        {profile ? (
          <p className="mt-2 text-[15px] text-ink-2">
            {t('profileLink')}{' '}
            <Link to={`/@${profile.handle}`} data-testid="profile-link">
              @{profile.handle}
            </Link>
          </p>
        ) : null}
      </div>
      {/* Keyed by the values it edits, so a change from another device resets it to them, and a
          change to anything else (the reading language below) leaves an edit alone. */}
      {profile ? (
        <SettingsForm
          key={[profile.handle, profile.displayName, profile.bio, profile.publicSubscriptions].join(
            '\u0000',
          )}
          profile={profile}
          state={state}
          onState={setState}
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
            href="/api/v1/feeds/opml"
            download
            className="inline-block rounded-full border border-ink px-4 py-2 text-[13px] font-medium text-ink hover:bg-ink hover:text-paper hover:no-underline"
            data-testid="opml-export"
          >
            {t('opmlExport')}
          </a>
        </div>
      </section>
    </main>
  )
}

type SaveError = 'invalid_handle' | 'handle_taken'
type SaveState = { saved: boolean; error: SaveError | null }

function SettingsForm({
  profile,
  state,
  onState,
}: {
  profile: ProfileRow
  state: SaveState
  onState: (state: SaveState) => void
}) {
  const t = useTranslations('settings')
  const { engine } = useStore()
  const [handle, setHandle] = useState(profile.handle)
  const [displayName, setDisplayName] = useState(profile.displayName ?? '')
  const [bio, setBio] = useState(profile.bio ?? '')
  const [publicSubscriptions, setPublic] = useState(profile.publicSubscriptions)
  const [busy, setBusy] = useState(false)
  const field =
    'w-full rounded-lg border border-line bg-white px-3 py-2.5 outline-none focus:border-muted'

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const { status, body } = await apiJson<{ error?: string }>('/api/v1/profile', {
        method: 'PUT',
        body: { handle, displayName, bio, publicSubscriptions },
      })
      if (status === 200) {
        onState({ saved: true, error: null })
        void engine.pull()
      } else {
        onState({
          saved: false,
          error: body?.error === 'handle_taken' ? 'handle_taken' : 'invalid_handle',
        })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="flex flex-col gap-4"
      data-testid="settings-form"
    >
      <label className="flex flex-col gap-1 text-[13px] font-medium">
        {t('handle')}
        <div className="flex items-center gap-1">
          <span className="text-muted">@</span>
          <input
            name="handle"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            required
            className={field}
            data-testid="settings-handle"
          />
        </div>
        <span className="text-xs font-normal text-muted">{t('handleHint')}</span>
      </label>
      <label className="flex flex-col gap-1 text-[13px] font-medium">
        {t('displayName')}
        <input
          name="displayName"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className={field}
          data-testid="settings-display-name"
        />
      </label>
      <label className="flex flex-col gap-1 text-[13px] font-medium">
        {t('bio')}
        <textarea
          name="bio"
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          rows={3}
          maxLength={280}
          className={`${field} font-serif text-base`}
        />
      </label>
      <label className="flex items-center gap-2 text-[13px]">
        <input
          type="checkbox"
          name="publicSubscriptions"
          checked={publicSubscriptions}
          onChange={(e) => setPublic(e.target.checked)}
        />
        {t('publicSubscriptions')}
      </label>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy}
          className="rounded-full bg-ink px-4 py-2.5 font-medium text-paper hover:brightness-125 disabled:opacity-60"
          data-testid="settings-save"
        >
          {t('save')}
        </button>
        {state.saved ? (
          <span className="text-[13px] text-accent" data-testid="settings-saved">
            {t('saved')}
          </span>
        ) : null}
        {state.error ? (
          <span className="text-[13px] text-[oklch(0.5_0.15_25)]" data-testid="settings-error">
            {t(`errors.${state.error}`)}
          </span>
        ) : null}
      </div>
    </form>
  )
}
