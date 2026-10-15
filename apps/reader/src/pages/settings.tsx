/**
 * Settings, in sections the URL names (`/settings/profile`, `/settings/reading`, …), so Back and a
 * link both land on the section meant (Tela v2). On a phone (below `md`, Tela Mobile 13) bare
 * `/settings` is the list of sections and each is a page of its own behind a back bar; from `md` up
 * it is Profile, beside the side column. Everything here is the synced tables: a change made on
 * another device shows here. Most settings are mutations and take effect at once; the handle,
 * name and bio are an RPC, since a handle has to be unique. Invites and Account are the exception,
 * live answers on purpose (`settings-account.tsx`).
 */
import {
  asLabel,
  LANGUAGE_NAMES,
  MAX_FOLDERS,
  READING_LANGUAGES,
  UI_LOCALES,
  type UiLocale,
} from '@tela/shared'
import type { PrivacyFlag, ProfileRow } from '@tela/sync'
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { Link, useLocation, useNavigate, useNavigationType, useParams } from 'react-router'
import { useTranslations } from 'use-intl'
import { AvatarCrop } from '../components/avatar-crop'
import {
  type Folder,
  FolderSection,
  type Manage,
  type ManagedRow,
  MoveSheet,
  NewFolderForm,
  useFolderDrag,
} from '../components/folders-manage'
import { BACK, CHEVRON_RIGHT, CLOSE, Glyph } from '../components/glyph'
import { PersonAvatar } from '../components/person-avatar'
import { Segmented } from '../components/segmented'
import { SETTING_HINT, SettingRow } from '../components/setting-row'
import { Switch } from '../components/switch'
import { linkingReturn } from '../lib/account-api'
import { canMakeFolder, filedIn, folderWith, groupRows, knownFolders } from '../lib/folders'
import { cadenceKey } from '../lib/format'
import type { ReadingMode } from '../lib/href'
import { newId } from '../lib/id'
import { type AddError, importOpml, saveDownload } from '../lib/opml'
import { PREF_KEYS, readingPrefsOf } from '../lib/prefs'
import { useTitle } from '../lib/title'
import { UNDO_HOLD_MS } from '../lib/toasts'
import {
  MEASURES,
  type Measure,
  PREFS,
  SIZES,
  type Size,
  THEMES,
  typographyOf,
} from '../lib/typography'
import { offerUndo } from '../lib/undo'
import { BELOW_MD, useMediaQuery } from '../lib/use-media'
import { api, apiJson } from '../store/api'
import { useNow, usePrivacyUnsettled, useReadingLang, useStore, useTables } from '../store/hooks'
import { feedTitle, folderIdOf } from '../store/selectors'
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

/** Profile too has an address of its own, so a link to it lands on it at any width. */
export const hrefOf = (section: Section) => `/settings/${section}`

export type SettingsView =
  | { kind: 'section'; section: Section }
  | { kind: 'list' }
  /** `wasList`: the entry being replaced is the list's, which a phone may come back to. */
  | { kind: 'redirect'; to: string; wasList?: true }

/**
 * What `/settings` or `/settings/:section` shows. Bare `/settings` is the list of sections on a
 * phone and goes to Profile's own address from `md` up, so no form is ever edited at the one
 * address whose page depends on the width: there, turning a phone across `md` would swap the form
 * for the list and lose what was typed.
 */
export function settingsView(
  asked: string | undefined,
  search: string,
  phone: boolean,
): SettingsView {
  if (asked === undefined) {
    // A link's return from Google or GitHub is Account's, at any width.
    if (linkingReturn(search)) return { kind: 'redirect', to: `/settings/account${search}` }
    return phone ? { kind: 'list' } : { kind: 'redirect', to: hrefOf('profile'), wasList: true }
  }
  const section = SECTIONS.find((s) => s === asked)
  return section ? { kind: 'section', section } : { kind: 'redirect', to: '/settings' }
}

/**
 * The right end of a phone section's back bar, where the section puts its own action: New folder
 * on Subscriptions (Tela Lists, screen 27). The section owns the action and its state; the bar
 * only holds it.
 */
const BarEnd = createContext<HTMLElement | null>(null)

/** A heading on the phone's pages: the list's, and each section's name (Tela Mobile 13). */
const PHONE_TITLE = 'font-serif text-[30px] leading-[1.1] font-medium tracking-[-0.015em]'

export function SettingsPage() {
  const t = useTranslations('settings')
  const { section: asked } = useParams()
  const { pathname, search, key, state } = useLocation()
  const navigate = useNavigate()
  // One layout or the other, not both with one hidden: each holds its own `settings-section-*`.
  const phone = useMediaQuery(BELOW_MD)
  const navigation = useNavigationType()
  const heading = useRef<HTMLHeadingElement>(null)
  const [barEnd, setBarEnd] = useState<HTMLDivElement | null>(null)
  useTitle(t('title'))
  // On a phone a section is a page of its own, so arriving by a row or a link starts it at its top
  // with focus on its name, as a new page would. Back, Forward and a load (`POP`) leave the page
  // where the browser keeps it, and so does a redirect. Only the phone's heading has the ref.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per entry navigated to
  useEffect(() => {
    if (navigation !== 'PUSH' || !heading.current) return
    window.scrollTo(0, 0)
    heading.current.focus({ preventScroll: true })
  }, [key])
  // Beside the side column the list's entry is handed to Profile, and that sticks to the entry: a
  // phone turned wide on the list, then narrow again, would come back (by Back, or the back bar
  // going back) to Profile where it left the list. Arriving at such an entry on a phone puts the
  // list back. Only on arriving, never as the width changes, so a form being edited there stays.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per entry navigated to
  useEffect(() => {
    if (navigation !== 'POP' || !phone || asked !== 'profile' || !wasList(state)) return
    if (!isCurrentEntry(pathname, search)) return
    navigate('/settings', { replace: true, state: { left: leftFor(state) } })
  }, [key])

  const view = settingsView(asked, search, phone)
  const redirectTo = view.kind === 'redirect' ? view.to : null
  const handOver = view.kind === 'redirect' && view.wasList === true
  // A redirect replaces the browser's current entry, so it waits until that entry is the one this
  // render is of. React Router moves the location in a transition while a change of width renders
  // at once: the list, pressed as the window widened, rendered wide at its old address after the
  // browser had moved to the row's section, and a <Navigate> there replaced the section's entry
  // with Profile. The render that is current redirects, or has no need to.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per entry and target
  useEffect(() => {
    if (redirectTo === null || !isCurrentEntry(pathname, search)) return
    const marked = handOver ? { wasList: true, left: leftFor(state) } : undefined
    navigate(redirectTo, { replace: true, state: marked })
  }, [key, redirectTo])

  if (view.kind === 'redirect') return null
  if (view.kind === 'list') return <SettingsList />
  const { section } = view

  if (phone) {
    return (
      <main className="w-full flex-1 animate-fade px-5 pb-10">
        {/* Under the header, as the reader's back bar is. A link, and Back only when the list
            is what lies behind: a section reached by its address has no list to go back to. */}
        <div
          className="-mx-5 flex h-[52px] items-center border-b border-line pr-2 pl-1"
          data-testid="settings-back-bar"
        >
          <Link
            to="/settings"
            onClick={(e) => {
              // Opened from the list: going back is Back, so a few sections visited leave the
              // history as list, section, not a list between each, and the list's own entry
              // knows which row to give focus back to. A click meant for a new tab stays a link.
              if (!plainClick(e) || !fromList(state)) return
              e.preventDefault()
              navigate(-1)
            }}
            aria-label={t('back')}
            className="flex h-11 min-w-0 items-center gap-0.5 rounded-md px-2.5 text-ink-2 hover:bg-hover hover:text-ink hover:no-underline"
            data-testid="settings-back"
          >
            <Glyph className="shrink-0">{BACK}</Glyph>
            <span className="truncate">{t('title')}</span>
          </Link>
          <div ref={setBarEnd} className="ml-auto flex shrink-0 items-center" />
        </div>
        <div className="pt-[22px]" data-testid="settings-content" data-section={section}>
          <h1 ref={heading} tabIndex={-1} className={`mb-1.5 outline-none ${PHONE_TITLE}`}>
            {t(`sections.${section}`)}
          </h1>
          <BarEnd.Provider value={barEnd}>
            <SectionContent section={section} />
          </BarEnd.Provider>
        </div>
      </main>
    )
  }

  return (
    <main className="mx-auto grid w-full max-w-[1040px] flex-1 animate-fade grid-cols-[200px_minmax(0,1fr)] items-start gap-16 px-12 py-12">
      <nav
        aria-label={t('title')}
        className="sticky top-24 flex min-w-0 flex-col gap-0.5"
        data-testid="settings-nav"
      >
        <h1 className="mb-[18px] font-serif text-[34px] font-medium tracking-tight">
          {t('title')}
        </h1>
        <div className="flex flex-col gap-0.5">
          {/* Current by the section shown, not by the address: Profile is shown at `/settings`
              and at `/settings/profile`, and a NavLink would light it at only one. */}
          {SECTIONS.map((s) => (
            <Link
              key={s}
              to={hrefOf(s)}
              aria-current={s === section ? 'page' : undefined}
              data-testid={`settings-section-${s}`}
              className={`-ml-3 rounded-lg px-3 py-2 font-medium whitespace-nowrap text-ink hover:bg-hover hover:no-underline ${s === section ? 'bg-hover' : ''}`}
            >
              {t(`sections.${s}`)}
            </Link>
          ))}
        </div>
      </nav>
      <div className="min-w-0 max-w-[640px]" data-testid="settings-content" data-section={section}>
        <h2 className="mb-1.5 font-serif text-[30px] font-medium">{t(`sections.${section}`)}</h2>
        <SectionContent section={section} />
      </div>
    </main>
  )
}

/** A section opened from the phone's list, whose back bar can then go back rather than on. */
const fromList = (state: unknown) =>
  typeof state === 'object' && state !== null && 'fromList' in state && state.fromList === true

/** Whether the browser's entry is the address a render is of, not one it has since moved past. */
const isCurrentEntry = (pathname: string, search: string) =>
  window.location.pathname === pathname && window.location.search === search

/** Profile's entry that was the list's until the side column handed it over. */
const wasList = (state: unknown) =>
  typeof state === 'object' && state !== null && 'wasList' in state && state.wasList === true

/** A click the browser follows in this tab: the main button, with no key asking for another. */
const plainClick = (e: React.MouseEvent) =>
  e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey

/** The section the list was left for, kept in the list's own history entry. */
const leftFor = (state: unknown): string | null =>
  typeof state === 'object' && state !== null && 'left' in state && typeof state.left === 'string'
    ? state.left
    : null

/** The phone's `/settings` (Tela Mobile 13): the sections as rows, each opening its own page. */
function SettingsList() {
  const t = useTranslations('settings')
  const { key, state } = useLocation()
  const navigate = useNavigate()
  const navigation = useNavigationType()
  const heading = useRef<HTMLHeadingElement>(null)
  const rows = useRef(new Map<Section, HTMLAnchorElement>())
  // Arriving by a link starts at the heading, as a new page would; coming back to the list (Back,
  // the section's back bar, or the list put back in an entry Profile had) puts focus on the row
  // that was left, where the member was. The row is in the list entry's own state, so it travels
  // with that entry and nothing else claims it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per entry navigated to
  useEffect(() => {
    if (navigation === 'PUSH') {
      window.scrollTo(0, 0)
      heading.current?.focus({ preventScroll: true })
      return
    }
    const left = SECTIONS.find((s) => s === leftFor(state))
    if (left) rows.current.get(left)?.focus()
  }, [key])
  return (
    <main className="w-full flex-1 animate-fade px-5 pt-6 pb-10">
      <h1 ref={heading} tabIndex={-1} className={`mb-3 outline-none ${PHONE_TITLE}`}>
        {t('title')}
      </h1>
      <nav aria-label={t('title')} data-testid="settings-nav">
        <ul className="m-0 list-none p-0">
          {SECTIONS.map((s) => (
            <li key={s} className="border-t border-line">
              <Link
                ref={(el) => {
                  if (el) rows.current.set(s, el)
                  else rows.current.delete(s)
                }}
                to={hrefOf(s)}
                state={{ fromList: true }}
                onClick={(e) => {
                  if (plainClick(e)) navigate('/settings', { replace: true, state: { left: s } })
                }}
                className="flex min-h-12 items-center justify-between gap-3 py-3 text-[15px] font-medium text-ink hover:no-underline"
                data-testid={`settings-section-${s}`}
              >
                {t(`sections.${s}`)}
                <Glyph className="shrink-0 text-muted">{CHEVRON_RIGHT}</Glyph>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </main>
  )
}

function SectionContent({ section }: { section: Section }) {
  return (
    <>
      {section === 'profile' ? <ProfileSection /> : null}
      {section === 'reading' ? <ReadingSection /> : null}
      {section === 'translation' ? <TranslationSection /> : null}
      {section === 'subscriptions' ? <SubscriptionsSection /> : null}
      {section === 'privacy' ? <PrivacySection /> : null}
      {section === 'invites' ? <InvitesSection /> : null}
      {section === 'account' ? <AccountSection /> : null}
    </>
  )
}

/** A section's first line. Closer to its rows on a phone, as Tela Mobile 13 draws it. */
function Intro({ children }: { children: React.ReactNode }) {
  return <p className="mb-[18px] text-[14px] text-muted md:mb-7">{children}</p>
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
      {/* Linked unless the account holds a language of its own (ADR 0040): the first option is
          null, which follows the interface, and one that merely equals it is a choice. */}
      <SettingRow label={t('translateInto')} hint={t('translateIntoHint')}>
        <select
          value={tables.profile?.readingLang ?? ''}
          aria-label={t('translateInto')}
          onChange={(e) => {
            if (e.target.value === '') {
              store.mutate({ type: 'setProfile', readingLang: null })
              return
            }
            const readingLang = READING_LANGUAGES.find((l) => l === e.target.value)
            if (readingLang) store.mutate({ type: 'setProfile', readingLang })
          }}
          className={SELECT}
          data-testid="settings-reading-lang"
        >
          <option value="">{t('translateIntoInterface')}</option>
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
  // A chip or an option starts with the name; the remove button's label names it mid-sentence.
  const name = (tag: string) => names[tag] ?? tag
  const label = (tag: string) => asLabel(name(tag), locale)
  const pool = [...seen]
    .filter((tag) => tag !== readingLang && !never.includes(tag))
    .sort((a, b) => name(a).localeCompare(name(b)))
  const chosen = pool.includes(pick) ? pick : ''
  return (
    <div className="border-t border-line py-4 sm:py-5" data-testid="never-translate">
      <div className="font-medium">{t('never')}</div>
      <div className={SETTING_HINT}>{t('neverHint')}</div>
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
              <Glyph size={12} className="block">
                {CLOSE}
              </Glyph>
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

/**
 * The member's subscriptions in their folders (ADR 0048, Tela Lists): a section per folder, by
 * name, then the blogs in none, with New folder beside Import and Export (in the back bar on a
 * phone). Moving a blog, by its folder button or by dragging it from `md` up, is a `fileFeed`;
 * deleting a folder is held while its toast offers Undo (ADR 0046), and its blogs are in no folder.
 */
function SubscriptionsSection() {
  const t = useTranslations('settings')
  const tt = useTranslations('toast')
  const tables = useTables()
  const now = useNow()
  const { store, engine } = useStore()
  const phone = useMediaQuery(BELOW_MD)
  const barEnd = useContext(BarEnd)
  // Blogs left from this page stay listed, dimmed, so a slip can be undone where it was made. The
  // subscription row is still there with its `deletedAt`: this is which rows to show, not a
  // second record of what is subscribed. Each keeps the count of posts it had when left, since
  // leaving drops the feed's posts from the device and would read as "quiet lately".
  const [left, setLeft] = useState<ReadonlyMap<number, number>>(new Map())
  // New folder's form, keyed so that pressing New folder again starts it afresh.
  const [creating, setCreating] = useState<number | null>(null)
  // The blog whose Move to sheet is open, on a phone, and the folder button it opened from.
  const [moving, setMoving] = useState<ManagedRow | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  const focusMove = useRef<number | null>(null)
  const newFolder = useRef<HTMLButtonElement>(null)
  const unfiledHeading = useRef<HTMLHeadingElement>(null)
  const limitId = useId()
  // Where focus goes once the control that had it has gone: New folder after its form closes, and
  // the blogs in none (or New folder, with no folder left) after a folder is deleted.
  const refocus = useRef<'new' | 'deleted' | null>(null)
  useLayoutEffect(() => {
    const was = refocus.current
    if (was === null) return
    refocus.current = null
    ;((was === 'deleted' ? unfiledHeading.current : null) ?? newFolder.current)?.focus()
  })
  // Wide, the sheet is not shown; turned narrow again, it would open by itself.
  useEffect(() => {
    if (!phone) setMoving(null)
  }, [phone])

  const posted = new Map<number, number>()
  for (const a of tables.articles.values()) {
    if (a.sortAt >= now - 30 * DAY) posted.set(a.feedId, (posted.get(a.feedId) ?? 0) + 1)
  }
  const rows: ManagedRow[] = [...tables.subscriptions.values()]
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
  const grouped = groupRows(tables, now, rows)
  const folders: Folder[] = grouped.folders.map(({ id, name }) => ({ id, name }))
  // A name, and the limit, also reckon with a folder whose deletion is still held.
  const known = knownFolders(tables, store.confirmedFolders())
  const canMake = canMakeFolder(known)

  // Each reads the device's rows as they are when it runs, not as this render saw them.
  const folderOf = (feedId: number) => folderIdOf(store.getSnapshot().tables, feedId)
  const move = (feedId: number, folderId: string | null) => {
    if (folderOf(feedId) !== folderId) store.mutate({ type: 'fileFeed', feedId, folderId })
  }
  const drag = useFolderDrag(folderOf, move)
  const toggle = (feedId: number, subscribed: boolean) => {
    if (subscribed) setLeft((l) => leaving(l, feedId, posted.get(feedId) ?? 0))
    store.mutate(subscribed ? { type: 'unsubscribe', feedId } : { type: 'subscribe', feedId })
  }
  const remove = (folder: Folder) => {
    // Its blogs as they are filed now, before the delete leaves them in none.
    const filed = filedIn(store.getSnapshot().tables, folder.id)
    const held = store.mutate({ type: 'deleteFolder', id: folder.id }, { holdMs: UNDO_HOLD_MS })
    if (!held) return
    refocus.current = 'deleted'
    // Sent already, the folder is made again under a new id with the same blogs in it.
    offerUndo(store, t('folders.deleted', { name: folder.name }), tt('undo'), [held.mid], () =>
      store.mutateMany(folderWith(folder.name, filed), { after: held.at }),
    )
  }
  const manage: Manage = {
    phone,
    folders,
    known,
    move,
    openSheet: (row, from) => {
      opener.current = from
      setCreating(null)
      setMoving(row)
    },
    rename: (folder, name) => store.mutate({ type: 'putFolder', id: folder.id, name }),
    remove,
    toggle,
    focusMove,
    drag,
  }
  const closeForm = () => {
    refocus.current = 'new'
    setCreating(null)
  }

  const newFolderButton = (
    <button
      ref={newFolder}
      type="button"
      disabled={!canMake}
      aria-describedby={canMake ? undefined : limitId}
      onClick={() => setCreating((n) => (n ?? 0) + 1)}
      className={
        phone
          ? 'flex min-h-11 shrink-0 items-center rounded-md px-2.5 text-[13.5px] font-medium whitespace-nowrap text-ink hover:bg-hover disabled:opacity-60'
          : 'rounded-full bg-ink px-[15px] py-2 text-[13px] font-medium whitespace-nowrap text-paper hover:brightness-125 disabled:opacity-60'
      }
      data-testid="new-folder"
    >
      {t('folders.new')}
    </button>
  )

  return (
    <>
      {/* A phone's New folder is at the right of the back bar (screen 27). */}
      {phone && barEnd ? createPortal(newFolderButton, barEnd) : null}
      <div className="mb-2.5 flex flex-wrap items-end justify-between gap-4">
        <p className="text-[14px] text-muted" data-testid="subscription-count">
          {folders.length > 0
            ? t('subscriptionsInFolders', { blogs: count, folders: folders.length })
            : t('subscriptionsIntro', { n: count })}
        </p>
        <div className="flex flex-wrap items-start gap-2">
          <OpmlImport onImported={() => void engine.pull()} />
          <ExportButton
            path="/api/v1/feeds/opml"
            fallbackName="tela-subscriptions.opml"
            label={t('opmlExport')}
            testId="opml-export"
          />
          {phone ? null : newFolderButton}
        </div>
      </div>
      {rows.length > 0 ? (
        <p className="mb-2 text-[13px] leading-normal text-muted">
          {t(phone ? 'folders.helpPhone' : 'folders.help')}
        </p>
      ) : null}
      {canMake ? null : (
        <p id={limitId} className="mb-2 text-[13px] text-muted" data-testid="new-folder-limit">
          {t('folders.limit', { max: MAX_FOLDERS })}
        </p>
      )}
      {creating !== null && canMake ? (
        <NewFolderForm
          key={creating}
          folders={known}
          onCreate={(name) => {
            store.mutate({ type: 'putFolder', id: newId(), name })
            closeForm()
          }}
          onCancel={closeForm}
        />
      ) : null}
      <div data-testid="settings-subscriptions">
        {grouped.folders.map((g) => (
          <FolderSection key={g.id} folder={g} rows={g.rows} heading manage={manage} />
        ))}
        {rows.length > 0 ? (
          <FolderSection
            folder={null}
            rows={grouped.unfiled}
            heading={folders.length > 0}
            manage={manage}
            headingRef={unfiledHeading}
          />
        ) : null}
      </div>
      {rows.length === 0 ? <p className="mt-6 text-muted">{t('noSubscriptions')}</p> : null}
      {phone && moving ? (
        <MoveSheet
          row={moving}
          current={folderIdOf(tables, moving.feedId)}
          folders={folders}
          known={known}
          opener={opener}
          canCreate={canMake}
          limitHint={t('folders.limit', { max: MAX_FOLDERS })}
          onChoose={(folderId) => {
            focusMove.current = moving.feedId
            move(moving.feedId, folderId)
            setMoving(null)
          }}
          onCreate={(name) => {
            focusMove.current = moving.feedId
            store.mutateMany(folderWith(name, [moving.feedId]))
            setMoving(null)
          }}
          onClose={() => setMoving(null)}
        />
      ) : null}
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

/**
 * One privacy switch. A hide goes at once; a show waits while this device's last change to the
 * switch is still on its way (issue #16): it names the version the server held, which the device
 * knows only once that change has come back in a pull. Online that is well under a second.
 */
function PrivacySwitch({
  flag,
  label,
  testId,
}: {
  flag: PrivacyFlag
  label: string
  testId: string
}) {
  const t = useTranslations('settings')
  const { store } = useStore()
  const on = useTables().profile?.[flag] ?? false
  const waits = usePrivacyUnsettled(flag) && !on
  const why = useId()
  return (
    <>
      {waits ? (
        <span id={why} className="sr-only">
          {t('privacyWaits')}
        </span>
      ) : null}
      <Switch
        checked={on}
        disabled={waits}
        describedBy={waits ? why : undefined}
        onChange={(next) => store.setPrivacy(flag, next)}
        label={label}
        testId={testId}
      />
    </>
  )
}

function PrivacySection() {
  const t = useTranslations('settings')
  return (
    <>
      <Intro>{t('privacyIntro')}</Intro>
      <SettingRow label={t('showLikes')} hint={t('showLikesHint')}>
        <PrivacySwitch flag="publicLikes" label={t('showLikes')} testId="privacy-likes" />
      </SettingRow>
      <SettingRow label={t('showSubscriptions')} hint={t('showSubscriptionsHint')}>
        <PrivacySwitch
          flag="publicSubscriptions"
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
