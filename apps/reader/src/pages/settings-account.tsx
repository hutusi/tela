/**
 * Settings → Invites and Settings → Account (ADR 0034). Unlike the rest of Settings, these read
 * live RPC answers on purpose, never the synced tables: an invite list holds other people's state
 * and is counted by the server, and how a member signs in is security state. Every call is in
 * `lib/account-api.ts`.
 */
import { groupInviteCode } from '@tela/shared'
import { useEffect, useId, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useTranslations } from 'use-intl'
import { ResponsiveDialog } from '../components/modal'
import { SETTING_HINT, SETTING_LABEL, SettingRow } from '../components/setting-row'
import {
  type Account,
  type AccountError,
  type ConfirmError,
  configuredProviders,
  confirmWithCode,
  createInvite,
  type DeleteError,
  deleteAccount,
  getAccount,
  type InviteError,
  type Invites,
  inviteLink,
  linkProvider,
  listInvites,
  PROVIDERS,
  type Provider,
  requestDeleteCode,
  revokeInvite,
  sendConfirmCode,
  setPassword,
  signOutEverywhere,
  unlinkProvider,
} from '../lib/account-api'
import { useOpenSignup } from '../lib/door-config'
import { monthYear } from '../lib/format'
import { useLive } from '../lib/use-live'
import { PASSWORD_MAX, PASSWORD_MIN } from '../lib/use-sign-in'
import { useSession } from '../session'
import { useTables } from '../store/hooks'
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
  return <p className="mb-[18px] text-[14px] text-muted md:mb-7">{children}</p>
}

// ---------------------------------------------------------------------------------------------
// Invites

export function InvitesSection() {
  const t = useTranslations('invites')
  // While sign-up is open nobody needs a code (ADR 0056): the section, which Settings no longer
  // lists then, says so to whoever reaches its address, and the codes wait, kept, for invitations
  // to come back.
  const open = useOpenSignup()
  if (open) {
    return (
      <div data-testid="invites-open">
        <Intro>{t('open')}</Intro>
      </div>
    )
  }
  return <InviteList />
}

function InviteList() {
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
        {/* An address can be longer than a phone is wide: it breaks rather than push the page. */}
        <span
          className="min-w-0 text-[14px] text-ink-2 [overflow-wrap:anywhere]"
          data-testid="account-email"
        >
          {account.email}
        </span>
      </SettingRow>
      <PasswordRow
        has={account.hasPassword}
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
      <DeleteAccountRow email={account.email} />
    </>
  )
}

/**
 * Settings › Account › Delete account (ADR 0058): a row that opens a dialog saying plainly what
 * goes and what stays, then asks for a code mailed to the member's address, as every change to an
 * account is confirmed. Deleted, the tab forgets its copy and starts over at `/`: tela-api has
 * ended the session and cleared the cookies, and every other tab is signed out at its next call.
 */
function DeleteAccountRow({ email }: { email: string }) {
  const t = useTranslations('account')
  const [open, setOpen] = useState(false)
  const opener = useRef<HTMLButtonElement>(null)
  return (
    <SettingRow label={t('delete.label')} hint={t('delete.hint')} testId="account-delete-row">
      <button
        ref={opener}
        type="button"
        onClick={() => setOpen(true)}
        className={`${QUIET} text-danger hover:border-danger`}
        data-testid="account-delete"
      >
        {t('delete.open')}
      </button>
      {open ? (
        <DeleteAccountDialog email={email} opener={opener} onClose={() => setOpen(false)} />
      ) : null}
    </SettingRow>
  )
}

function DeleteAccountDialog({
  email,
  opener,
  onClose,
}: {
  email: string
  opener: React.RefObject<HTMLButtonElement | null>
  onClose: () => void
}) {
  const t = useTranslations('account')
  const door = useTranslations('door')
  const { closed } = useSession()
  const handle = useTables().profile?.handle ?? ''
  const titleId = useId()
  const [sent, setSent] = useState(false)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<DeleteError | null>(null)

  const run = async (step: () => Promise<DeleteError | null>, then: () => void | Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      const failed = await step()
      if (failed) setError(failed)
      else await then()
    } catch {
      setError('failed')
    } finally {
      setBusy(false)
    }
  }

  const send = () => run(requestDeleteCode, () => setSent(true))
  const confirm = (e: React.FormEvent) => {
    e.preventDefault()
    void run(
      () => deleteAccount(code.trim()),
      () => closed(),
    )
  }

  return (
    <ResponsiveDialog
      labelledBy={titleId}
      opener={opener}
      onClose={onClose}
      testId="account-delete-dialog"
    >
      <div className="flex flex-col gap-4">
        <h2
          id={titleId}
          className="m-0 font-serif text-[24px] leading-tight font-medium tracking-[-0.01em] md:text-[28px]"
        >
          {t('delete.title')}
        </h2>
        <p className="m-0 text-[14px] text-ink-2">{t('delete.goes')}</p>
        <p className="m-0 text-[14px] text-ink-2">
          {t('delete.stays', { handle: handle ? `@${handle}` : '' })}
        </p>
        <p className="m-0 text-[13.5px] text-muted">
          {t.rich('delete.export', {
            link: (chunks) => (
              <Link to="/settings/privacy" className="text-ink underline" onClick={onClose}>
                {chunks}
              </Link>
            ),
          })}
        </p>
        {sent ? (
          <form onSubmit={confirm} className="flex flex-col gap-3">
            <p className="m-0 text-[13.5px] text-muted">{t('delete.sent', { email })}</p>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              aria-label={door('codePlaceholder')}
              placeholder={door('codePlaceholder')}
              // biome-ignore lint/a11y/noAutofocus: the code is what the dialog asks for now.
              autoFocus
              className={`${FIELD} max-w-[180px] font-mono tracking-widest`}
              data-testid="account-delete-code"
            />
            <div className="flex flex-wrap gap-2.5">
              <button
                type="submit"
                disabled={busy || code.trim().length === 0}
                className="rounded-full bg-danger px-[18px] py-[9px] text-[13.5px] font-medium whitespace-nowrap text-paper hover:brightness-110 disabled:opacity-60"
                data-testid="account-delete-confirm"
              >
                {t('delete.confirm')}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded-full px-3 py-[9px] text-[13.5px] text-ink-2 hover:text-ink"
              >
                {t('cancel')}
              </button>
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap gap-2.5">
            <button
              type="button"
              onClick={() => void send()}
              disabled={busy}
              className={PRIMARY}
              data-testid="account-delete-send"
            >
              {t('delete.send')}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full px-3 py-[9px] text-[13.5px] text-ink-2 hover:text-ink"
            >
              {t('cancel')}
            </button>
          </div>
        )}
        {error ? (
          <p
            role="alert"
            className="m-0 text-[13px] text-danger"
            data-testid="account-delete-error"
          >
            {t(`delete.errors.${error}`)}
          </p>
        ) : null}
      </div>
    </ResponsiveDialog>
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
    <div className="border-t border-line py-4 sm:py-5" data-testid="account-password">
      {/* Laid out as a SettingRow, which has no room for the form under it. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 sm:gap-x-8">
        <div className={SETTING_LABEL}>
          <div className="font-medium">{t('password')}</div>
          <div className={SETTING_HINT} data-testid="account-password-state">
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
