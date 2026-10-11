/**
 * The member's avatar, and the menu it opens (Tela v5): who they are, their profile, their
 * subscriptions, the Dashboard for a writer or For writers for anyone else, settings, the admin
 * console for an operator, inviting friends last, and signing out. A disclosure rather than an
 * ARIA menu: its items are links and buttons, reached by Tab like any others.
 *
 * Below `sm` it is a phone's menu, 8px from each edge with rows to touch, and it opens with what
 * the header has no room for there: the language, which opens its list in place of the menu, the
 * theme, and search.
 */
import type { Tables } from '@tela/sync'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { useTranslations } from 'use-intl'
import { useDismiss } from '../lib/use-dismiss'
import { useSession } from '../session'
import { useTables } from '../store/hooks'
import { BACK, CHECK, CHEVRON_RIGHT, Glyph } from './glyph'
import { endonym, useMemberLanguage } from './language-menu'
import { PersonAvatar } from './person-avatar'
import { ThemeSwitch } from './theme-menu'

/** A row: 44px to touch on a phone, the desktop's 13.5px list from `sm` up (the panel's size). */
const ITEM =
  'flex min-h-11 items-center rounded-lg px-3.5 text-left text-ink hover:bg-paper hover:no-underline sm:min-h-0 sm:rounded-md sm:px-3 sm:py-2'

/** A rule between groups of rows: an `<hr>`, so a screen reader hears where one ends. */
const DIVIDER = 'my-1 shrink-0 border-line'

/** A writer: a member whose device holds a verified claim on a blog. */
export function writes(tables: Pick<Tables, 'claims'>): boolean {
  for (const claim of tables.claims.values()) if (claim.status === 'verified') return true
  return false
}

export function AccountMenu() {
  const t = useTranslations('nav')
  const profile = useTables().profile
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const panel = useId()
  useDismiss(
    open,
    (by) => {
      setOpen(false)
      if (by === 'escape') button.current?.focus()
    },
    box,
  )
  // Wherever an item leads, the menu is done: close it when one is chosen (the page it names may
  // be the one shown, so the address need not change), and on any change of page.
  const done = () => setOpen(false)
  const location = useLocation()
  // biome-ignore lint/correctness/useExhaustiveDependencies: on every navigation, by its address
  useEffect(() => setOpen(false), [location.pathname, location.search])

  const handle = profile?.handle ?? null
  const name = profile?.displayName ?? (handle ? `@${handle}` : '')
  return (
    <div ref={box} className="relative shrink-0">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        aria-label={t('account')}
        title={name}
        onClick={() => setOpen((o) => !o)}
        data-testid="account-menu"
        data-handle={handle ?? ''}
        className="flex size-[30px] items-center justify-center rounded-full hover:shadow-[0_0_0_3px_var(--color-line)]"
      >
        {handle ? (
          <PersonAvatar
            handle={handle}
            displayName={profile?.displayName ?? null}
            avatar={profile?.avatar}
            size={30}
            me
          />
        ) : (
          <span className="size-[30px] rounded-full bg-accent" />
        )}
      </button>
      {/* Mounted only while open, so it opens on the menu every time, never on the languages. */}
      {open ? <AccountPanel id={panel} done={done} /> : null}
    </div>
  )
}

/**
 * The panel. On a phone it is fixed 8px from each edge under the 56px header; from `sm` up it
 * hangs under the avatar, 220px wide, as before. Either way it stops 8px above the window's foot
 * and scrolls inside itself on a short screen, a phone turned sideways (640 × 350) included: the
 * header is sticky, so scrolling the page never brings a row below the foot into reach.
 */
function AccountPanel({ id, done }: { id: string; done: () => void }) {
  const [view, setView] = useState<'menu' | 'language'>('menu')
  // Where focus goes when the view changes: the row that was chosen is gone, and focus with it.
  const moved = useRef(false)
  const languageRow = useRef<HTMLButtonElement>(null)
  const back = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    if (!moved.current) return
    moved.current = false
    ;(view === 'language' ? back : languageRow).current?.focus()
  }, [view])
  const show = (next: 'menu' | 'language') => {
    moved.current = true
    setView(next)
  }
  return (
    <div
      id={id}
      className="fixed top-16 right-2 left-2 z-[7] flex max-h-[calc(100dvh-72px)] animate-fade flex-col overflow-y-auto rounded-[14px] border border-line bg-surface p-1.5 text-[15px] text-ink shadow-[0_12px_32px_rgba(0,0,0,.10)] sm:absolute sm:top-[calc(100%+10px)] sm:right-0 sm:left-auto sm:max-h-[calc(100dvh-61px)] sm:min-w-[220px] sm:rounded-xl sm:text-[13.5px]"
      data-testid="account-panel"
      data-view={view}
    >
      {view === 'language' ? (
        <LanguageList back={back} onBack={() => show('menu')} done={done} />
      ) : (
        <Menu languageRow={languageRow} onLanguage={() => show('language')} done={done} />
      )}
    </div>
  )
}

/**
 * The menu, in the order of Tela v5 at every width, with one divider, before Sign out; on a
 * phone the rows for the language, the theme and search come first, set off by one of their own
 * (mobile screen 07). A writer gets the Dashboard (`writes`), anyone else the page that tells
 * them what claiming a blog gives them.
 */
function Menu({
  languageRow,
  onLanguage,
  done,
}: {
  languageRow: React.RefObject<HTMLButtonElement | null>
  onLanguage: () => void
  done: () => void
}) {
  const t = useTranslations('nav')
  const tm = useTranslations('menu')
  const ts = useTranslations('settings')
  const { signOut } = useSession()
  const tables = useTables()
  const profile = tables.profile
  const writer = writes(tables)
  const language = useMemberLanguage()
  const handle = profile?.handle ?? null
  return (
    <>
      <div className="mb-1 border-b border-line px-3.5 pt-3 pb-3.5 sm:px-3 sm:pt-2.5 sm:pb-3">
        <div className="font-medium sm:text-[14px]">{profile?.displayName ?? handle}</div>
        {handle ? <div className="text-[13px] text-muted sm:text-[12.5px]">@{handle}</div> : null}
      </div>
      {/* A phone's header has room for none of these. */}
      <div className="flex flex-col sm:hidden">
        <button
          ref={languageRow}
          type="button"
          onClick={onLanguage}
          data-testid="account-language"
          className="flex min-h-12 items-center justify-between gap-3 rounded-lg px-3.5 text-left hover:bg-paper"
        >
          <span>{language.apart ? ts('translateInto') : tm('language')}</span>
          <span className="flex items-center gap-1 text-ink-2">
            <span lang={language.value}>{endonym(language.value)}</span>
            <Glyph size={14}>{CHEVRON_RIGHT}</Glyph>
          </span>
        </button>
        <div
          className="flex min-h-12 items-center justify-between gap-3 pr-1.5 pl-3.5"
          data-testid="account-theme-row"
        >
          <span>{tm('theme')}</span>
          <ThemeSwitch label={tm('theme')} testId="account-theme" />
        </div>
        <Link to="/search" className={ITEM} onClick={done} data-testid="account-search">
          {tm('search')}
        </Link>
        <hr className={DIVIDER} />
      </div>
      {handle ? (
        <Link to={`/@${handle}`} className={ITEM} onClick={done} data-testid="nav-profile">
          {t('yourProfile')}
        </Link>
      ) : null}
      <Link
        to="/settings/subscriptions"
        className={ITEM}
        onClick={done}
        data-testid="nav-subscriptions"
      >
        {t('subscriptions')}
      </Link>
      {writer ? (
        <Link to="/dashboard" className={ITEM} onClick={done} data-testid="nav-dashboard">
          {t('dashboard')}
        </Link>
      ) : (
        <Link to="/writers" className={ITEM} onClick={done} data-testid="nav-for-writers">
          {t('writers')}
        </Link>
      )}
      <Link to="/settings" className={ITEM} onClick={done} data-testid="nav-settings">
        {t('settings')}
      </Link>
      {profile?.isAdmin ? (
        <Link to="/admin" className={ITEM} onClick={done} data-testid="nav-admin">
          {t('admin')}
        </Link>
      ) : null}
      <Link to="/settings/invites" className={ITEM} onClick={done} data-testid="nav-invites">
        {t('invites')}
      </Link>
      <hr className={DIVIDER} />
      <button
        type="button"
        onClick={() => void signOut()}
        className={`${ITEM} text-muted hover:text-ink`}
        data-testid="sign-out"
      >
        {t('signOut')}
      </button>
    </>
  )
}

/**
 * The phone's language list, in place of the menu (Tela v5): the circle's choice exactly
 * (`useMemberLanguage`, ADR 0040), linked or set apart, and named as the circle's panel names it
 * then. A choice closes the menu, as it closes the circle's.
 */
function LanguageList({
  back,
  onBack,
  done,
}: {
  back: React.RefObject<HTMLButtonElement | null>
  onBack: () => void
  done: () => void
}) {
  const t = useTranslations('nav')
  const tm = useTranslations('menu')
  const ts = useTranslations('settings')
  const { apart, options, value, choose } = useMemberLanguage()
  return (
    <>
      <button
        ref={back}
        type="button"
        onClick={onBack}
        data-testid="account-language-back"
        className="mb-1 flex min-h-12 shrink-0 items-center gap-1.5 border-b border-line px-2.5 text-left font-medium"
      >
        <Glyph>{BACK}</Glyph>
        {apart ? ts('translateInto') : tm('language')}
      </button>
      {options.map((code) => (
        <button
          key={code}
          type="button"
          lang={code}
          aria-pressed={code === value}
          onClick={() => {
            choose(code)
            done()
          }}
          data-testid={`account-language-${code}`}
          className={`flex min-h-12 items-center justify-between gap-3 rounded-lg px-3.5 text-left hover:bg-hover ${code === value ? 'bg-hover font-medium' : ''}`}
        >
          {endonym(code)}
          {code === value ? <Glyph>{CHECK}</Glyph> : null}
        </button>
      ))}
      <hr className={DIVIDER} />
      <p className="m-0 px-3.5 pt-2.5 pb-1 text-[13px] leading-[1.45] text-muted">
        {apart ? tm('apartHint') : tm('languageHint')}
      </p>
      <Link
        to="/settings/translation"
        className={ITEM}
        onClick={done}
        data-testid="account-language-settings"
      >
        {t('languageSettings')}
      </Link>
    </>
  )
}
