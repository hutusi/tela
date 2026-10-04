/**
 * Settings, in sections the URL names (`/settings`, `/settings/reading`, …), so Back and a link
 * both land on the section meant (Tela v2). Everything here is the synced tables: a change made on
 * another device shows here. Most settings are mutations and take effect at once; the handle,
 * name and bio are an RPC, since a handle has to be unique. Invites and Account are the exception,
 * live answers on purpose (`settings-account.tsx`).
 */
import {
  asLabel,
  LANGUAGE_NAMES,
  languageBadge,
  READING_LANGUAGES,
  UI_LOCALES,
  type UiLocale,
} from '@tela/shared'
import type { ProfileRow } from '@tela/sync'
import { useRef, useState } from 'react'
import { Link, Navigate, NavLink, useLocation, useParams } from 'react-router'
import { useTranslations } from 'use-intl'
import { AvatarCrop } from '../components/avatar-crop'
import { PersonAvatar } from '../components/person-avatar'
import { Segmented } from '../components/segmented'
import { SettingRow } from '../components/setting-row'
import { SiteAvatar } from '../components/site-avatar'
import { Switch } from '../components/switch'
import { linkingReturn } from '../lib/account-api'
import { cadenceKey, displayHost } from '../lib/format'
import type { ReadingMode } from '../lib/href'
import { type AddError, importOpml, saveDownload } from '../lib/opml'
import { PREF_KEYS, readingPrefsOf } from '../lib/prefs'
import { useTitle } from '../lib/title'
import {
  MEASURES,
  type Measure,
  PREFS,
  SIZES,
  type Size,
  THEMES,
  typographyOf,
} from '../lib/typography'
import { api, apiJson } from '../store/api'
import { useNow, useReadingLang, useStore, useTables } from '../store/hooks'
import { feedTitle } from '../store/selectors'
import { useUi } from '../ui'
import { AccountSection, InvitesSection } from './settings-account'

export const SECTIONS = [
  'profile',
  'reading',
  'translation',
  'subscriptions',
  'privacy',
  'invites',
  'account',
] as const
export type Section = (typeof SECTIONS)[number]

const hrefOf = (section: Section) => (section === 'profile' ? '/settings' : `/settings/${section}`)

export function SettingsPage() {
  const t = useTranslations('settings')
  const { section: asked } = useParams()
  const { search } = useLocation()
  const section = (asked ?? 'profile') as Section
  useTitle(t('title'))
  if (asked === undefined && linkingReturn(search)) {
    return <Navigate to={`/settings/account${search}`} replace />
  }
  if (asked !== undefined && (asked === 'profile' || !SECTIONS.includes(section))) {
    return <Navigate to="/settings" replace />
  }
  return (
    <main className="mx-auto grid w-full max-w-[1040px] flex-1 animate-fade grid-cols-1 items-start gap-6 px-4 py-10 md:grid-cols-[200px_minmax(0,1fr)] md:gap-16 md:px-12 md:py-12">
      <nav
        aria-label={t('title')}
        className="flex min-w-0 flex-col gap-0.5 md:sticky md:top-24"
        data-testid="settings-nav"
      >
        <h1 className="mb-3 font-serif text-[34px] font-medium tracking-tight md:mb-[18px]">
          {t('title')}
        </h1>
        {/* One row that scrolls below md, a column beside the section from md up. */}
        <div className="-mx-4 flex gap-0.5 overflow-x-auto px-4 [scrollbar-width:none] md:mx-0 md:flex-col md:overflow-visible md:px-0">
          {SECTIONS.map((s) => (
            <NavLink
              key={s}
              to={hrefOf(s)}
              end
              data-testid={`settings-section-${s}`}
              className={({ isActive }) =>
                `shrink-0 rounded-lg px-3 py-2 font-medium whitespace-nowrap text-ink hover:bg-hover hover:no-underline md:-ml-3 ${isActive ? 'bg-hover' : ''}`
              }
            >
              {t(`sections.${s}`)}
            </NavLink>
          ))}
        </div>
      </nav>
      <div className="min-w-0 max-w-[640px]" data-testid="settings-content" data-section={section}>
        <h2 className="mb-1.5 font-serif text-[30px] font-medium">{t(`sections.${section}`)}</h2>
        {section === 'profile' ? <ProfileSection /> : null}
        {section === 'reading' ? <ReadingSection /> : null}
        {section === 'translation' ? <TranslationSection /> : null}
        {section === 'subscriptions' ? <SubscriptionsSection /> : null}
        {section === 'privacy' ? <PrivacySection /> : null}
        {section === 'invites' ? <InvitesSection /> : null}
        {section === 'account' ? <AccountSection /> : null}
      </div>
    </main>
  )
}

function Intro({ children }: { children: React.ReactNode }) {
  return <p className="mb-7 text-[14px] text-muted">{children}</p>
}

// ---------------------------------------------------------------------------------------------
// Profile

type SaveError = 'invalid_handle' | 'handle_taken'
type SaveState = { saved: boolean; error: SaveError | null }

function ProfileSection() {
  const t = useTranslations('settings')
  const profile = useTables().profile
  // Here, not in the form: saving changes the values the form is keyed by, and the answer has to
  // outlive the form it came from.
  const [state, setState] = useState<SaveState>({ saved: false, error: null })
  return (
    <>
      <Intro>{t('profileIntro')}</Intro>
      {/* Keyed by the values it edits, so a change from another device resets it to them, and a
          change to anything else (a privacy switch, the reading language) leaves an edit alone. */}
      {profile ? (
        <ProfileForm
          key={[profile.handle, profile.displayName, profile.bio].join('\u0000')}
          profile={profile}
          state={state}
          onState={setState}
        />
      ) : null}
    </>
  )
}

/** The quiet pill the Settings buttons share. */
const PILL =
  'rounded-full border border-thumb px-3.5 py-[7px] text-[13px] font-medium whitespace-nowrap text-ink hover:border-ink disabled:opacity-60'

type GravatarHint = 'shown' | 'none' | 'checking' | 'off'

/**
 * The member's picture (ADR 0033): one they upload, cropped in a dialog here, else their Gravatar
 * (on until they turn it off), else their initial. One picture at a time, and only the control that
 * decides it: while there is an upload, the Gravatar switch decides nothing, so it is not shown,
 * and a line says what removing the upload goes back to. Without one, the switch and Refresh (the
 * switch sent on again: a new address past the 30-day caches, and Gravatar asked again at once),
 * with a hint saying whether there is a Gravatar and why not.
 */
function PictureSettings({ profile }: { profile: ProfileRow }) {
  const t = useTranslations('settings')
  const { store, engine } = useStore()
  const [cropping, setCropping] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const hint: GravatarHint = !profile.gravatar
    ? 'off'
    : profile.gravatarFound === null
      ? 'checking'
      : profile.gravatarFound
        ? 'shown'
        : 'none'
  // What removing an upload goes back to: the Gravatar only if it is on and Gravatar has one.
  const fallback = hint === 'shown' ? 'pictureFallbackGravatar' : 'pictureFallbackInitial'

  async function remove() {
    setBusy(true)
    setFailed(false)
    try {
      const res = await api('/api/v1/avatar', { method: 'DELETE' })
      if (res.ok) void engine.pull()
      else setFailed(true)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="flex items-center gap-[18px] pb-6">
        <PersonAvatar
          handle={profile.handle}
          displayName={profile.displayName}
          avatar={profile.avatar}
          size={64}
          me
        />
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <label
              className={`${PILL} cursor-pointer focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent`}
              data-testid="profile-picture-upload"
            >
              {profile.avatarUploaded ? t('pictureReplace') : t('pictureUpload')}
              <input
                type="file"
                accept="image/*"
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  // Cleared, so choosing the same file again opens the dialog again.
                  e.target.value = ''
                  if (file) setCropping(file)
                }}
                data-testid="profile-picture-input"
              />
            </label>
            {profile.avatarUploaded ? (
              <button
                type="button"
                onClick={() => void remove()}
                disabled={busy}
                className={PILL}
                data-testid="profile-picture-remove"
              >
                {t('pictureRemove')}
              </button>
            ) : null}
          </div>
          {profile.avatarUploaded ? (
            <p className="m-0 text-[12.5px] text-muted" data-testid="profile-picture-fallback">
              {t(fallback)}
            </p>
          ) : null}
        </div>
      </div>
      {failed ? (
        <p role="alert" className="-mt-3 pb-4 text-[13px] text-danger">
          {t('pictureErrors.failed')}
        </p>
      ) : null}
      {profile.avatarUploaded ? null : (
        <SettingRow label={t('gravatar')} hint={t(`gravatarHints.${hint}`)}>
          <div
            className="flex items-center gap-3"
            data-testid="profile-gravatar-row"
            data-hint={hint}
          >
            {profile.gravatar ? (
              <button
                type="button"
                onClick={() => store.mutate({ type: 'setAvatar', gravatar: true })}
                className={PILL}
                data-testid="profile-gravatar-refresh"
              >
                {t('gravatarRefresh')}
              </button>
            ) : null}
            <Switch
              checked={profile.gravatar}
              onChange={(on) => store.mutate({ type: 'setAvatar', gravatar: on })}
              label={t('gravatar')}
              testId="profile-gravatar"
            />
          </div>
        </SettingRow>
      )}
      {cropping ? <AvatarCrop file={cropping} onClose={() => setCropping(null)} /> : null}
    </>
  )
}

const BIO_MAX = 280

function ProfileForm({
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
  const [busy, setBusy] = useState(false)
  const field =
    'w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-[15px] text-ink outline-none focus:border-muted'

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      // The privacy switches own public_subscriptions now: a form loaded before a switch moved
      // must not write the old value back.
      const { status, body } = await apiJson<{ error?: string }>('/api/v1/profile', {
        method: 'PUT',
        body: { handle, displayName, bio },
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
    <form onSubmit={(e) => void submit(e)} className="flex flex-col" data-testid="settings-form">
      <PictureSettings profile={profile} />
      <div className="flex flex-col gap-5 border-t border-line pt-6">
        <label className="flex flex-col gap-1.5">
          <span className="font-medium">{t('name')}</span>
          <input
            name="displayName"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={80}
            className={field}
            data-testid="settings-display-name"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="font-medium">{t('handle')}</span>
          <div className="flex overflow-hidden rounded-lg border border-line bg-surface focus-within:border-muted">
            <span className="py-2.5 pl-3 text-[15px] text-muted">{window.location.host}/@</span>
            <input
              name="handle"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              required
              className="min-w-0 flex-1 bg-transparent py-2.5 pr-3 pl-px text-[15px] text-ink outline-none"
              data-testid="settings-handle"
            />
          </div>
          <span className="text-[12.5px] text-muted">{t('handleHint')}</span>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="font-medium">{t('bio')}</span>
          <textarea
            name="bio"
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            rows={3}
            maxLength={BIO_MAX}
            className={`${field} resize-y font-serif text-[17px] leading-[1.45]`}
          />
          <span className="text-[12.5px] text-muted">
            {t('charsLeft', { n: BIO_MAX - bio.length })}
          </span>
        </label>
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="submit"
            disabled={busy}
            className="rounded-full bg-ink px-[18px] py-[9px] font-medium text-paper hover:brightness-125 disabled:opacity-60"
            data-testid="settings-save"
          >
            {t('saveChanges')}
          </button>
          <Link
            to={`/@${profile.handle}`}
            className="rounded-full px-3 py-[9px] text-ink-2 hover:text-ink hover:no-underline"
            data-testid="profile-link"
          >
            {t('viewProfile')}
          </Link>
          {state.saved ? (
            <span className="text-[13px] text-accent" data-testid="settings-saved">
              {t('saved')}
            </span>
          ) : null}
          {state.error ? (
            <span className="text-[13px] text-danger" data-testid="settings-error">
              {t(`errors.${state.error}`)}
            </span>
          ) : null}
        </div>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------------------------
// Reading

function ReadingSection() {
  const t = useTranslations('settings')
  const ty = useTranslations('typography')
  const tables = useTables()
  const { store } = useStore()
  const { size, measure, theme } = typographyOf(tables)
  const prefs = readingPrefsOf(tables)
  const set = (key: string, value: string) => store.mutate({ type: 'setPref', key, value })
  return (
    <>
      <Intro>{t('readingIntro')}</Intro>
      <SettingRow label={t('textSize')} hint={t('textSizeHint')}>
        <Segmented
          label={t('textSize')}
          options={Object.keys(SIZES) as Size[]}
          value={size}
          render={(s) => s.toUpperCase()}
          onChoose={(s) => set(PREFS.size, s)}
          testId="size"
        />
      </SettingRow>
      <SettingRow label={t('measure')} hint={t('measureHint')}>
        <Segmented
          label={t('measure')}
          options={Object.keys(MEASURES) as Measure[]}
          value={measure}
          render={(m) => ty(`measures.${m}`)}
          onChoose={(m) => set(PREFS.measure, m)}
          testId="measure"
        />
      </SettingRow>
      <SettingRow label={t('theme')} hint={t('themeHint')}>
        <Segmented
          label={t('theme')}
          options={THEMES}
          value={theme}
          render={(th) => ty(`themes.${th}`)}
          onChoose={(th) => set(PREFS.theme, th)}
          testId="theme"
        />
      </SettingRow>
      <SettingRow label={t('markOnOpen')} hint={t('markOnOpenHint')}>
        <Switch
          checked={prefs.markOnOpen}
          onChange={(on) => store.mutate({ type: 'setPref', key: PREF_KEYS.markOnOpen, value: on })}
          label={t('markOnOpen')}
          testId="pref-mark-on-open"
        />
      </SettingRow>
      <SettingRow label={t('hideRead')} hint={t('hideReadHint')}>
        <Switch
          checked={prefs.hideRead}
          onChange={(on) => store.mutate({ type: 'setPref', key: PREF_KEYS.hideRead, value: on })}
          label={t('hideRead')}
          testId="pref-hide-read"
        />
      </SettingRow>
    </>
  )
}

// ---------------------------------------------------------------------------------------------
// Translation

const MODES: ReadingMode[] = ['side', 'trans', 'orig']

/** A native select, as each language choice here is: four or more do not fit a segmented row. */
const SELECT =
  'cursor-pointer rounded-lg border border-line bg-surface px-2.5 py-[7px] text-[13.5px] text-ink'

function TranslationSection() {
  const t = useTranslations('settings')
  const tt = useTranslations('translation')
  const tables = useTables()
  const { store } = useStore()
  const { locale, setLocale } = useUi()
  const readingLang = useReadingLang(locale)
  const names = LANGUAGE_NAMES[locale as UiLocale] ?? LANGUAGE_NAMES.en
  const prefs = readingPrefsOf(tables)
  return (
    <>
      <Intro>{t('translationIntro')}</Intro>
      {/* Each language in its own name, so it can be found whatever the page is in now. */}
      <SettingRow label={t('uiLocale')} hint={t('uiLocaleHint')}>
        <select
          value={locale}
          aria-label={t('uiLocale')}
          onChange={(e) => {
            const chosen = UI_LOCALES.find((l) => l === e.target.value)
            if (chosen) setLocale(chosen)
          }}
          className={SELECT}
          data-testid="ui-locale"
        >
          {UI_LOCALES.map((l) => (
            <option key={l} value={l} lang={l}>
              {asLabel(LANGUAGE_NAMES[l][l] ?? l, l)}
            </option>
          ))}
        </select>
      </SettingRow>
      <SettingRow label={t('translateInto')} hint={t('translateIntoHint')}>
        <select
          value={readingLang}
          aria-label={t('translateInto')}
          onChange={(e) => {
            const readingLang = READING_LANGUAGES.find((l) => l === e.target.value)
            if (readingLang) store.mutate({ type: 'setProfile', readingLang })
          }}
          className={SELECT}
          data-testid="settings-reading-lang"
        >
          {READING_LANGUAGES.map((code) => (
            <option key={code} value={code}>
              {asLabel(names[code] ?? code, locale)}
            </option>
          ))}
        </select>
      </SettingRow>
      <SettingRow label={t('autoTranslate')} hint={t('autoTranslateHint')}>
        <Switch
          checked={prefs.autoTranslate}
          onChange={(on) =>
            store.mutate({ type: 'setPref', key: PREF_KEYS.autoTranslate, value: on })
          }
          label={t('autoTranslate')}
          testId="pref-auto-translate"
        />
      </SettingRow>
      <SettingRow label={t('defaultView')} hint={t('defaultViewHint')}>
        <Segmented
          label={t('defaultView')}
          options={MODES}
          value={prefs.mode}
          render={(m) => tt(`modes.${m}`)}
          onChoose={(m) => store.mutate({ type: 'setPref', key: PREF_KEYS.mode, value: m })}
          testId="default-mode"
        />
      </SettingRow>
      <NeverTranslate never={prefs.never} readingLang={readingLang} names={names} />
    </>
  )
}

/**
 * Languages the member reads as written: chips to remove, and a native select to add from every
 * language Tela names plus any a post on this device is in. Tags compare exactly: zh-Hans and
 * zh-Hant are two languages here (AGENTS.md).
 */
function NeverTranslate({
  never,
  readingLang,
  names,
}: {
  never: readonly string[]
  readingLang: string
  names: Record<string, string>
}) {
  const t = useTranslations('settings')
  const tables = useTables()
  const { store } = useStore()
  const { locale } = useUi()
  const set = (value: string[]) => store.mutate({ type: 'setPref', key: PREF_KEYS.never, value })
  // The select only chooses; Add commits. Arrow keys on a closed select (Windows, Linux) and
  // type-ahead fire a change per step, which added a language at each one.
  const [pick, setPick] = useState('')
  // Add and a chip's ✕ remove themselves when pressed: focus goes to the select, which stays,
  // rather than to the page.
  const select = useRef<HTMLSelectElement>(null)
  const seen = new Set(Object.keys(names))
  for (const a of tables.articles.values()) if (a.sourceLang) seen.add(a.sourceLang)
  const name = (tag: string) => names[tag] ?? tag
  // A chip and an option start with the name; a sentence keeps it as it is ("français").
  const label = (tag: string) => asLabel(name(tag), locale)
  const pool = [...seen]
    .filter((tag) => tag !== readingLang && !never.includes(tag))
    .sort((a, b) => name(a).localeCompare(name(b)))
  const chosen = pool.includes(pick) ? pick : ''
  return (
    <div className="border-t border-line py-5" data-testid="never-translate">
      <div className="font-medium">{t('never')}</div>
      <div className="mt-[3px] text-[13px] text-muted">{t('neverHint')}</div>
      <div className="mt-3.5 flex flex-wrap gap-2">
        {never.map((tag) => (
          <span
            key={tag}
            className="flex items-center gap-1.5 rounded-full border border-line bg-surface py-[5px] pr-1.5 pl-3 text-[13px]"
            data-testid="never-chip"
          >
            {label(tag)}
            <button
              type="button"
              onClick={() => {
                select.current?.focus()
                set(never.filter((x) => x !== tag))
              }}
              aria-label={t('removeLanguage', { lang: name(tag) })}
              className="flex size-5 items-center justify-center rounded-full text-[12px] text-muted hover:bg-hover hover:text-ink"
              data-testid={`never-remove-${tag}`}
            >
              ✕
            </button>
          </span>
        ))}
        <select
          ref={select}
          value={chosen}
          aria-label={t('addLanguage')}
          onChange={(e) => setPick(e.target.value)}
          className="cursor-pointer rounded-full border border-dashed border-thumb bg-transparent px-3 py-[5px] text-[13px] text-muted hover:border-muted hover:text-ink"
          data-testid="never-add"
        >
          <option value="">{t('addLanguage')}</option>
          {pool.map((tag) => (
            <option key={tag} value={tag}>
              {label(tag)}
            </option>
          ))}
        </select>
        {chosen ? (
          <button
            type="button"
            onClick={() => {
              select.current?.focus()
              set([...never, chosen])
              setPick('')
            }}
            className="rounded-full border border-ink bg-ink px-3 py-[5px] text-[13px] font-medium text-paper"
            data-testid="never-add-confirm"
          >
            {t('add')}
          </button>
        ) : null}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Subscriptions

const DAY = 86_400_000

/**
 * The blogs left from this page, with the count of recent posts each had: the larger of the one
 * kept and what the device holds now. Left, taken back and left again before a pull returns its
 * posts, the device holds none of them, and that 0 would read as "quiet lately".
 */
export function leaving(
  left: ReadonlyMap<number, number>,
  feedId: number,
  held: number,
): ReadonlyMap<number, number> {
  return new Map(left).set(feedId, Math.max(left.get(feedId) ?? 0, held))
}

function SubscriptionsSection() {
  const t = useTranslations('settings')
  const td = useTranslations('discover')
  const tables = useTables()
  const now = useNow()
  const { store, engine } = useStore()
  // Blogs left from this page stay listed, dimmed, so a slip can be undone where it was made. The
  // subscription row is still there with its `deletedAt`: this is which rows to show, not a
  // second record of what is subscribed. Each keeps the count of posts it had when left, since
  // leaving drops the feed's posts from the device and would read as "quiet lately".
  const [left, setLeft] = useState<ReadonlyMap<number, number>>(new Map())

  const posted = new Map<number, number>()
  for (const a of tables.articles.values()) {
    if (a.sortAt >= now - 30 * DAY) posted.set(a.feedId, (posted.get(a.feedId) ?? 0) + 1)
  }
  const rows = [...tables.subscriptions.values()]
    .filter((s) => s.deletedAt === null || left.has(s.feedId))
    .map((s) => {
      const feed = tables.feeds.get(s.feedId)
      const site = feed ? tables.sites.get(feed.siteId) : undefined
      return {
        feedId: s.feedId,
        subscribed: s.deletedAt === null,
        title: feedTitle(tables, s.feedId) || '…',
        site,
        cadence: cadenceKey(Math.max(posted.get(s.feedId) ?? 0, left.get(s.feedId) ?? 0)),
      }
    })
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }))
  const count = rows.filter((r) => r.subscribed).length

  const toggle = (feedId: number, subscribed: boolean) => {
    if (subscribed) setLeft((l) => leaving(l, feedId, posted.get(feedId) ?? 0))
    store.mutate(subscribed ? { type: 'unsubscribe', feedId } : { type: 'subscribe', feedId })
  }

  return (
    <>
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <p className="text-[14px] text-muted" data-testid="subscription-count">
          {t('subscriptionsIntro', { n: count })}
        </p>
        <div className="flex gap-2">
          <OpmlImport onImported={() => void engine.pull()} />
          <ExportButton
            path="/api/v1/feeds/opml"
            fallbackName="tela-subscriptions.opml"
            label={t('opmlExport')}
            testId="opml-export"
          />
        </div>
      </div>
      <ul className="m-0 list-none p-0" data-testid="settings-subscriptions">
        {rows.map((r) => {
          const listed = r.site?.listing === 'listed' || r.site?.listing === 'featured'
          return (
            <li
              key={r.feedId}
              className={`flex items-center gap-3.5 border-t border-line py-3.5 ${r.subscribed ? '' : 'opacity-55'}`}
              data-testid="settings-subscription"
            >
              <SiteAvatar
                id={r.site?.id ?? r.feedId}
                title={r.title}
                faviconKey={r.site?.faviconKey ?? null}
                size={32}
              />
              <div className="min-w-0 flex-1">
                {r.site && listed ? (
                  <Link to={`/s/${r.site.id}`} className="font-medium text-ink hover:underline">
                    {r.title}
                  </Link>
                ) : (
                  <span className="font-medium">{r.title}</span>
                )}
                <div className="truncate text-[12.5px] text-muted">
                  {r.site ? `${displayHost(r.site.homeUrl)} · ` : ''}
                  {td(`cadence.${r.cadence}`)}
                </div>
              </div>
              {r.site?.primaryLang ? (
                <span className="rounded border border-line px-1.5 py-px text-[11px] text-muted">
                  {languageBadge(r.site.primaryLang)}
                </span>
              ) : null}
              <button
                type="button"
                onClick={() => toggle(r.feedId, r.subscribed)}
                data-testid="settings-subscription-toggle"
                className={`min-w-[104px] rounded-full border px-3 py-[5px] text-[12.5px] font-medium ${
                  r.subscribed ? 'border-thumb text-ink-2' : 'border-ink bg-ink text-paper'
                }`}
              >
                {r.subscribed ? t('unsubscribe') : t('subscribe')}
              </button>
            </li>
          )
        })}
      </ul>
      {rows.length === 0 ? <p className="text-muted">{t('noSubscriptions')}</p> : null}
    </>
  )
}

/** A file picker that imports as soon as a file is chosen, and says what came of it. */
function OpmlImport({ onImported }: { onImported: () => void }) {
  const t = useTranslations('settings')
  const ta = useTranslations('add')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ feeds: number } | { error: AddError } | null>(null)
  const choose = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    setResult(null)
    const answer = await importOpml(file)
    setBusy(false)
    setResult(answer)
    if ('feeds' in answer) onImported()
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <label
        className={`cursor-pointer rounded-full border border-thumb px-3.5 py-[7px] text-[13px] font-medium text-ink focus-within:border-ink hover:border-ink ${busy ? 'opacity-60' : ''}`}
      >
        {t('importOpml')}
        <input
          type="file"
          accept=".opml,.xml,text/xml,application/xml,text/x-opml"
          className="sr-only"
          disabled={busy}
          onChange={(e) => {
            void choose(e.target.files?.[0])
            e.target.value = ''
          }}
          data-testid="opml-file"
        />
      </label>
      {result ? (
        <span
          className={`text-[12.5px] ${'error' in result ? 'text-danger' : 'text-ink-2'}`}
          data-testid="opml-result"
        >
          {'error' in result ? ta(`errors.${result.error}`) : ta('imported', { n: result.feeds })}
        </span>
      ) : null}
    </div>
  )
}

function ExportButton({
  path,
  fallbackName,
  label,
  testId,
}: {
  path: string
  fallbackName: string
  label: string
  testId: string
}) {
  const [busy, setBusy] = useState(false)
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        setBusy(true)
        void saveDownload(path, fallbackName).finally(() => setBusy(false))
      }}
      className="rounded-full border border-thumb px-3.5 py-[7px] text-[13px] font-medium whitespace-nowrap text-ink hover:border-ink disabled:opacity-60"
      data-testid={testId}
    >
      {label}
    </button>
  )
}

// ---------------------------------------------------------------------------------------------
// Privacy

function PrivacySection() {
  const t = useTranslations('settings')
  const { store } = useStore()
  const profile = useTables().profile
  return (
    <>
      <Intro>{t('privacyIntro')}</Intro>
      <SettingRow label={t('showLikes')} hint={t('showLikesHint')}>
        <Switch
          checked={profile?.publicLikes ?? false}
          onChange={(on) => store.mutate({ type: 'setPrivacy', publicLikes: on })}
          label={t('showLikes')}
          testId="privacy-likes"
        />
      </SettingRow>
      <SettingRow label={t('showSubscriptions')} hint={t('showSubscriptionsHint')}>
        <Switch
          checked={profile?.publicSubscriptions ?? false}
          onChange={(on) => store.mutate({ type: 'setPrivacy', publicSubscriptions: on })}
          label={t('showSubscriptions')}
          testId="privacy-subscriptions"
        />
      </SettingRow>
      <p className="border-t border-line py-4 text-[13px] text-muted">{t('privacyDelay')}</p>
      <SettingRow label={t('yourData')} hint={t('yourDataHint')}>
        <ExportButton
          path="/api/v1/export"
          fallbackName="tela-export.json"
          label={t('download')}
          testId="data-export"
        />
      </SettingRow>
    </>
  )
}
