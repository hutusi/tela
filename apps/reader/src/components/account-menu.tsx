/**
 * The member's avatar, and the menu it opens (Tela v2): who they are, their profile, their
 * subscriptions, the author's dashboard, settings, and signing out. A disclosure rather than an
 * ARIA menu: its items are links and a button, reached by Tab like any others.
 */
import { useEffect, useId, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { useTranslations } from 'use-intl'
import { useDismiss } from '../lib/use-dismiss'
import { useSession } from '../session'
import { useTables } from '../store/hooks'
import { PersonAvatar } from './person-avatar'

const ITEM =
  'rounded-md px-3 py-2 text-left text-[13.5px] text-ink hover:bg-paper hover:no-underline'

export function AccountMenu() {
  const t = useTranslations('nav')
  const { signOut } = useSession()
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
  // Wherever an item leads, the menu is done: close it when one is chosen (the page it names may be
  // the one shown, so the address need not change), and on any change of page.
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
          <PersonAvatar handle={handle} displayName={profile?.displayName ?? null} size={30} me />
        ) : (
          <span className="size-[30px] rounded-full bg-accent" />
        )}
      </button>
      {open ? (
        <div
          id={panel}
          className="absolute top-[calc(100%+10px)] right-0 z-[7] flex min-w-[220px] animate-fade flex-col rounded-xl border border-line bg-surface p-1.5 text-ink shadow-[0_12px_32px_rgba(0,0,0,.10)]"
          data-testid="account-panel"
        >
          <div className="mb-1 border-b border-line px-3 pt-2.5 pb-3">
            <div className="text-[14px] font-medium">{profile?.displayName ?? handle}</div>
            {handle ? <div className="text-[12.5px] text-muted">@{handle}</div> : null}
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
          <Link to="/dashboard" className={ITEM} onClick={done} data-testid="nav-dashboard">
            {t('dashboard')}
          </Link>
          <Link to="/settings" className={ITEM} onClick={done} data-testid="nav-settings">
            {t('settings')}
          </Link>
          <div className="my-1 h-px bg-line" />
          <button
            type="button"
            onClick={() => void signOut()}
            className={`${ITEM} text-muted hover:text-ink`}
            data-testid="sign-out"
          >
            {t('signOut')}
          </button>
        </div>
      ) : null}
    </div>
  )
}
