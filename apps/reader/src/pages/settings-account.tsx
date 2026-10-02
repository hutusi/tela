/**
 * Settings → Invites and Settings → Account (ADR 0034). Unlike the rest of Settings, these read
 * live RPC answers on purpose, never the synced tables: an invite list holds other people's state
 * and is counted by the server, and how a member signs in is security state. Every call is in
 * `lib/account-api.ts`.
 */
import { groupInviteCode } from '@tela/shared'
import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useTranslations } from 'use-intl'
import { SettingRow } from '../components/setting-row'
import {
  type Account,
  type AccountError,
  type ConfirmError,
  configuredProviders,
  confirmWithCode,
  createInvite,
  getAccount,
  type InviteError,
  type Invites,
  inviteLink,
  linkProvider,
  listInvites,
  PROVIDERS,
  type Provider,
  revokeInvite,
  sendConfirmCode,
  setPassword,
  signOutEverywhere,
  unlinkProvider,
} from '../lib/account-api'
import { monthYear } from '../lib/format'
import { PASSWORD_MAX, PASSWORD_MIN } from '../lib/use-sign-in'
import { useSession } from '../session'
import { useUi } from '../ui'

/** The quiet pill the Settings buttons share, and a muted one for taking something back. */
const QUIET =
  'rounded-full border border-thumb px-3.5 py-[7px] text-[13px] font-medium whitespace-nowrap hover:border-ink disabled:opacity-60'
const PILL = `${QUIET} text-ink`
const MUTED_PILL = `${QUIET} text-muted hover:text-ink`
/** The filled button for the one action a panel is for. */
const PRIMARY =
  'rounded-full bg-ink px-[18px] py-[9px] text-[13.5px] font-medium whitespace-nowrap text-paper hover:brightness-125 disabled:opacity-60'
const FIELD =
  'w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-[15px] text-ink outline-none focus:border-muted'

function Intro({ children }: { children: React.ReactNode }) {
  return <p className="mb-7 text-[14px] text-muted">{children}</p>
}

/** Load once on mount, and again on `reload()`; a page left mid-call drops the answer. */
function useLive<T>(load: (signal?: AbortSignal) => Promise<T | null>) {
  const [value, setValue] = useState<T | null>(null)
  const [failed, setFailed] = useState(false)
  const reload = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const answer = await load(signal)
        if (signal?.aborted) return
        setValue(answer)
        setFailed(answer === null)
      } catch {
        // Signed out or another account: api() has told the session. Offline: say it failed.
        if (!signal?.aborted) setFailed(true)
      }
    },
    [load],
  )
  useEffect(() => {
    const controller = new AbortController()
    void reload(controller.signal)
    return () => controller.abort()
  }, [reload])
  return { value, failed, reload }
}

// ---------------------------------------------------------------------------------------------
// Invites

export function InvitesSection() {
  const t = useTranslations('invites')
  const { value: invites, failed, reload } = useLive<Invites>(listInvites)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<InviteError | null>(null)

  const left = invites ? Math.max(0, invites.allowance - invites.codes.length) : 0

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const made = await createInvite()
      if (!made.ok) setError(made.error)
      await reload()
    } catch {
      setError('failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Intro>{t('intro')}</Intro>
      <div className="flex flex-wrap items-center justify-between gap-4 pb-5">
        <p className="m-0 text-[14px] text-ink-2" data-testid="invites-left">
          {invites ? t('left', { n: left }) : null}
        </p>
        <button
          type="button"
          onClick={() => void create()}
          disabled={busy || !invites || left === 0}
          className={PRIMARY}
          data-testid="invite-create"
        >
          {t('create')}
        </button>
      </div>
      {error ? (
        <p role="alert" className="pb-4 text-[13px] text-danger" data-testid="invites-error">
          {t(`errors.${error}`)}
        </p>
      ) : null}
      {failed && !invites ? (
        <p role="alert" className="pb-4 text-[13px] text-danger">
          {t('errors.load')}
        </p>
      ) : null}
      <ul className="m-0 list-none p-0" data-testid="invites">
        {invites?.codes
          .slice()
          .reverse()
          .map((invite) => (
            <InviteRow
              key={invite.code}
              code={invite.code}
              handle={invite.handle}
              joined={invite.joinedAt !== null}
              onChange={() => void reload()}
            />
          ))}
      </ul>
      {invites && invites.codes.length === 0 ? (
        <p className="border-t border-line pt-5 text-muted">{t('none')}</p>
      ) : null}
    </>
  )
}

function InviteRow({
  code,
  handle,
  joined,
  onChange,
}: {
  code: string
  handle: string | null
  joined: boolean
  onChange: () => void
}) {
  const t = useTranslations('invites')
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const link = inviteLink(code)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // No clipboard (an insecure origin, a denied permission): the link is on screen to select.
      setCopied(false)
    }
  }

  const revoke = async () => {
    setBusy(true)
    setFailed(false)
    try {
      if (!(await revokeInvite(code))) setFailed(true)
      onChange()
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <li
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line py-4"
      data-testid="invite"
      data-code={code}
      data-status={joined ? 'joined' : 'unused'}
    >
      <div className="min-w-0 flex-1 basis-60">
        <div className="font-medium tracking-wide" data-testid="invite-code">
          {groupInviteCode(code)}
        </div>
        {joined ? (
          <div className="mt-[3px] text-[13px] text-muted" data-testid="invite-status">
            {handle
              ? t.rich('joinedBy', {
                  handle: `@${handle}`,
                  who: (chunks) => (
                    <Link to={`/@${handle}`} className="text-ink hover:underline">
                      {chunks}
                    </Link>
                  ),
                })
              : t('joined')}
          </div>
        ) : (
          <div
            className="mt-[3px] truncate text-[13px] text-muted select-all"
            data-testid="invite-link"
          >
            {link}
          </div>
        )}
        {failed ? (
          <div role="alert" className="mt-1 text-[13px] text-danger">
            {t('errors.failed')}
          </div>
        ) : null}
      </div>
      {joined ? null : (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void copy()}
            className={PILL}
            data-testid="invite-copy"
          >
            {copied ? t('copied') : t('copy')}
          </button>
          <button
            type="button"
            onClick={() => void revoke()}
            disabled={busy}
            className={MUTED_PILL}
            data-testid="invite-revoke"
          >
            {t('revoke')}
          </button>
        </div>
      )}
    </li>
  )
}

// ---------------------------------------------------------------------------------------------
// Account

export function AccountSection() {
  const t = useTranslations('account')
  const { locale } = useUi()
  const { signOut } = useSession()
  const [search] = useSearchParams()
  const { value: account, failed, reload } = useLive<Account>(getAccount)
  const [providers, setProviders] = useState<Record<Provider, boolean>>({
    google: false,
    github: false,
  })
  // A refusal for want of a fresh session, from any control here: the banner asks for the code.
  const [stale, setStale] = useState(false)
  const [error, setError] = useState<AccountError | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    void configuredProviders().then((p) => {
      if (live) setProviders(p)
    })
    return () => {
      live = false
    }
  }, [])

  /** Run a change, and say what came of it: a refusal for freshness opens the confirmation. */
  const act = async (change: () => Promise<{ ok: true } | { ok: false; error: AccountError }>) => {
    setBusy(true)
    setError(null)
    try {
      const outcome = await change()
      if (outcome.ok) {
        await reload()
        return true
      }
      if (outcome.error === 'not_fresh') setStale(true)
      else setError(outcome.error)
      return false
    } catch {
      setError('failed')
      return false
    } finally {
      setBusy(false)
    }
  }

  const link = async (provider: Provider) => {
    setBusy(true)
    setError(null)
    try {
      const started = await linkProvider(provider)
      if (started.ok) {
        window.location.assign(started.url)
        return
      }
      if (started.error === 'not_fresh') setStale(true)
      else setError(started.error)
    } catch {
      setError('failed')
    } finally {
      setBusy(false)
    }
  }

  const everywhere = async () => {
    if (await act(signOutEverywhere)) await signOut()
  }

  // The provider's return, when linking did not work, names why in the address.
  const returned = search.get('error')

  if (!account) {
    return (
      <>
        <Intro>{t('intro')}</Intro>
        {failed ? (
          <p role="alert" className="text-[13px] text-danger">
            {t('errors.load')}
          </p>
        ) : null}
      </>
    )
  }

  return (
    <>
      <Intro>{t('intro')}</Intro>
      {!account.fresh || stale ? (
        <ConfirmIt
          email={account.email}
          onConfirmed={() => {
            setStale(false)
            setError(null)
            void reload()
          }}
        />
      ) : null}
      {error || returned ? (
        <p role="alert" className="pb-4 text-[13px] text-danger" data-testid="account-error">
          {error ? t(`errors.${error}`) : t('errors.link_failed')}
        </p>
      ) : null}
      <SettingRow label={t('email')} hint={t('emailHint')}>
        <span className="text-[14px] text-ink-2" data-testid="account-email">
          {account.email}
        </span>
      </SettingRow>
      <PasswordRow
        has={account.password}
        busy={busy}
        onSave={(input) => act(() => setPassword(input))}
      />
      {PROVIDERS.filter((p) => providers[p] || account.linked.some((l) => l.provider === p)).map(
        (provider) => {
          const linked = account.linked.find((l) => l.provider === provider)
          return (
            <SettingRow
              key={provider}
              label={t(`providers.${provider}`)}
              hint={
                linked
                  ? t('linkedSince', { date: monthYear(linked.since, locale) })
                  : t('notLinked')
              }
              testId={`account-provider-${provider}`}
            >
              {linked ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void act(() => unlinkProvider(linked.id))}
                  className={PILL}
                  data-testid={`account-unlink-${provider}`}
                >
                  {t('unlink')}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void link(provider)}
                  className={PILL}
                  data-testid={`account-link-${provider}`}
                >
                  {t('link')}
                </button>
              )}
            </SettingRow>
          )
        },
      )}
      <SettingRow label={t('everywhere')} hint={t('everywhereHint')}>
        <button
          type="button"
          disabled={busy}
          onClick={() => void everywhere()}
          className={PILL}
          data-testid="account-sign-out-everywhere"
        >
          {t('everywhereButton')}
        </button>
      </SettingRow>
    </>
  )
}

function PasswordRow({
  has,
  busy,
  onSave,
}: {
  has: boolean
  busy: boolean
  onSave: (input: { newPassword: string; currentPassword?: string }) => Promise<boolean>
}) {
  const t = useTranslations('account')
  const [open, setOpen] = useState(false)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [saved, setSaved] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaved(false)
    const ok = await onSave(
      has ? { newPassword: next, currentPassword: current } : { newPassword: next },
    )
    if (ok) {
      setOpen(false)
      setCurrent('')
      setNext('')
      setSaved(true)
    }
  }

  return (
    <div className="border-t border-line py-5" data-testid="account-password">
      <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3">
        <div className="min-w-0 flex-1 basis-60">
          <div className="font-medium">{t('password')}</div>
          <div className="mt-[3px] text-[13px] text-muted" data-testid="account-password-state">
            {has ? t('passwordSet') : t('passwordNone')}
          </div>
        </div>
        {open ? null : (
          <button
            type="button"
            onClick={() => {
              setOpen(true)
              setSaved(false)
            }}
            className={PILL}
            data-testid="account-password-open"
          >
            {has ? t('passwordChange') : t('passwordAdd')}
          </button>
        )}
      </div>
      {saved ? (
        <p className="mt-2 text-[13px] text-accent" data-testid="account-password-saved">
          {t('passwordSaved')}
        </p>
      ) : null}
      {open ? (
        <form onSubmit={(e) => void submit(e)} className="mt-4 flex flex-col gap-4">
          {has ? (
            <label className="flex flex-col gap-1.5">
              <span className="text-[14px] font-medium">{t('passwordCurrent')}</span>
              <input
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                required
                className={FIELD}
                data-testid="account-password-current"
              />
            </label>
          ) : null}
          <label className="flex flex-col gap-1.5">
            <span className="text-[14px] font-medium">{t('passwordNew')}</span>
            <input
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              minLength={PASSWORD_MIN}
              maxLength={PASSWORD_MAX}
              required
              className={FIELD}
              data-testid="account-password-new"
            />
            <span className="text-[12.5px] text-muted">
              {t('passwordHint', { min: PASSWORD_MIN })}
            </span>
          </label>
          <div className="flex gap-2.5">
            <button
              type="submit"
              disabled={busy}
              className={PRIMARY}
              data-testid="account-password-save"
            >
              {t('passwordSave')}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                setCurrent('')
                setNext('')
              }}
              className="rounded-full px-3 py-[9px] text-[13.5px] text-ink-2 hover:text-ink"
            >
              {t('cancel')}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  )
}

/**
 * "Confirm it's you": changing how a member signs in needs a session from the last day. A code
 * mailed to their own address, entered here, starts one for the same account, and the page stays.
 */
function ConfirmIt({ email, onConfirmed }: { email: string; onConfirmed: () => void }) {
  const t = useTranslations('account')
  // The code and its refusals read as they do in the sheet, where the same code signs in.
  const door = useTranslations('door')
  const [sent, setSent] = useState(false)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ConfirmError | null>(null)

  const send = async () => {
    setBusy(true)
    setError(null)
    try {
      const failed = await sendConfirmCode(email)
      if (failed) setError(failed)
      else setSent(true)
    } catch {
      setError('send_failed')
    } finally {
      setBusy(false)
    }
  }

  const confirm = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const failed = await confirmWithCode(email, code.trim())
      if (failed) setError(failed)
      else onConfirmed()
    } catch {
      setError('send_failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="mb-6 rounded-xl border border-line bg-surface p-5"
      data-testid="account-confirm-box"
    >
      <div className="font-medium">{t('confirmTitle')}</div>
      <p className="mt-1 mb-4 text-[13.5px] text-muted">
        {sent ? t('confirmSent', { email }) : t('confirmHint')}
      </p>
      {sent ? (
        <form onSubmit={(e) => void confirm(e)} className="flex flex-wrap gap-2.5">
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
            aria-label={door('codePlaceholder')}
            placeholder={door('codePlaceholder')}
            className={`${FIELD} max-w-[180px] font-mono tracking-widest`}
            data-testid="account-confirm-code"
          />
          <button
            type="submit"
            disabled={busy}
            className={PRIMARY}
            data-testid="account-confirm-submit"
          >
            {t('confirmSubmit')}
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => void send()}
          disabled={busy}
          className={PRIMARY}
          data-testid="account-confirm"
        >
          {t('confirm')}
        </button>
      )}
      {error ? (
        <p role="alert" className="mt-3 text-[13px] text-danger">
          {door(`errors.${error}`)}
        </p>
      ) : null}
    </div>
  )
}
