/**
 * The front door (ADRs 0034, 0035, 0036): one form for logging in and joining, shown as a sheet
 * over whatever page the visitor is on, and as the page itself at `/login`.
 *
 * - `FrontDoorProvider` holds the sheet. The header's Log in and Join are links to `/login` and
 *   `/join`, and open the sheet instead once the script runs (`useFrontDoor`); the edge renders
 *   without a provider, so there they stay links.
 * - `DoorForm` is the form, and `useSignIn` (`lib/use-sign-in.ts`) what it does.
 * - The sheet is a native modal `<dialog>`, as `AvatarCrop` is: the browser traps focus and Esc
 *   cancels it.
 *
 * Google and GitHub are offered only once tela-api says they are configured
 * (`/api/v1/public/auth`, remembered on the device so the next sheet shows them at once).
 *
 * A claim (For writers) is a join or a log-in that makes the visitor's card on the way in
 * (`lib/claim-card.ts`). Where signing in outlives the sheet (Google's or GitHub's round trip, a
 * session not yet known), `FrontDoorProvider` finishes the card once the tab is the member's, and
 * a refusal reopens the sheet with the card as it was.
 */
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router'
import { useTranslations } from 'use-intl'
import { type CardClaim, claimPath, finishCard, takeClaim } from '../lib/claim-card'
import {
  type DoorMode,
  doorRoutes,
  errorReturn,
  type MailLink,
  PASSWORD_MAX,
  PASSWORD_MIN,
  PROVIDERS,
  type Provider,
  providerError,
  type SignInError,
  takeInvite,
  useSignIn,
  withoutDoor,
} from '../lib/use-sign-in'
import { useSession } from '../session'
import { LogoMark } from './logo'

/**
 * What the sheet opens for. `claim` is a join (or, switched, a log-in) that makes the card For
 * writers showed and goes on to claim its blog: it lands on `/claim?url=…`.
 */
export type DoorRequest = (
  | { mode: 'login'; next?: string | undefined }
  | { mode: 'join'; code?: string | undefined }
  | {
      mode: 'claim'
      handle: string
      name: string
      blog: string
      code?: string | undefined
      /** The door it opens on: join, unless it comes back from a log-in a provider refused. */
      start?: DoorMode | undefined
    }
) & {
  /** What the page arrived saying: a provider's refusal. */
  error?: SignInError | undefined
  /** The visitor closed it (Esc, ✕), rather than signing in. */
  onClose?: () => void
}

type Opened = DoorRequest & { at: string; key: number }

const DoorContext = createContext<((request: DoorRequest) => void) | null>(null)
/** Whether the open sheet is carrying a sign-in through, and so says where a member goes. */
const SheetDecides = createContext(false)

/**
 * A member on a page that is only for visitors (`/`, `/join`) goes on to their reading, unless the
 * sheet is still signing them in or a navigation is already under way.
 *
 * The sheet sends whoever it signs in on itself (Discover for a join, `next` for a log-in), and
 * they are a member before it has finished: the password a joiner chose is saved after the
 * sign-in, and a refusal is told in the sheet. Until the sheet lets go (it leaves, or is closed),
 * the page under it stays as it was, `children`: a redirect rendered meanwhile closed the sheet,
 * and the warning with it, and beat the sheet's own destination whenever the save was slow.
 *
 * Once the sheet goes, the router renders its navigation as a transition, after the sheet's own
 * closing: a redirect rendered in between replaced where the sheet sent them. The address bar has
 * moved by then, and only the router's location lags.
 */
export function ToReading({ children }: { children?: React.ReactNode }) {
  const { pathname } = useLocation()
  const decides = useContext(SheetDecides)
  if (decides) return <>{children}</>
  if (window.location.pathname !== pathname) return null
  return <Navigate to="/reading" replace />
}

/** Open the sheet; null where there is none (the edge's render), so a link stays a link. */
export function useFrontDoor(): ((request: DoorRequest) => void) | null {
  return useContext(DoorContext)
}

/**
 * A click on a link to `/login` or `/join` that should open the sheet instead: a plain primary
 * click. Any modifier means a new tab or window, which gets the page.
 */
export function opensSheet(e: React.MouseEvent): boolean {
  return (
    !e.defaultPrevented && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey
  )
}

/** The providers tela-api offers, as last heard on this device. */
const PROVIDERS_KEY = 'tela.auth-providers'

function heardProviders(): Provider[] {
  try {
    const kept: unknown = JSON.parse(localStorage.getItem(PROVIDERS_KEY) ?? '[]')
    return PROVIDERS.filter((p) => Array.isArray(kept) && kept.includes(p))
  } catch {
    return []
  }
}

/**
 * Google and GitHub, when tela-api has them: a 404 is a tela-api that predates the endpoint, and
 * offers neither. Anything else that fails keeps what the device last heard.
 */
function useProviders(): Provider[] {
  const [providers, setProviders] = useState<Provider[]>(heardProviders)
  useEffect(() => {
    let live = true
    fetch('/api/v1/public/auth', { credentials: 'same-origin' })
      .then(async (res) => {
        if (res.status === 404) return []
        if (!res.ok) return null
        const flags = (await res.json()) as Partial<Record<Provider, unknown>>
        return PROVIDERS.filter((p) => flags[p] === true)
      })
      .then((heard) => {
        if (!live || heard === null) return
        setProviders(heard)
        try {
          localStorage.setItem(PROVIDERS_KEY, JSON.stringify(heard))
        } catch {
          // Not remembered: the next sheet asks again before it shows them.
        }
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])
  return providers
}

const FIELD =
  'h-11 w-full rounded-[10px] border border-thumb px-3.5 text-[15px] text-ink outline-none placeholder:text-muted focus:border-ink'
const PRIMARY =
  'h-11 rounded-full bg-primary px-4 text-[15px] font-medium text-on-primary hover:brightness-125 disabled:opacity-60'
const QUIET =
  'h-11 rounded-full border border-thumb bg-surface px-4 font-medium text-ink hover:border-ink disabled:opacity-60'
const TEXT_BUTTON =
  'self-center p-1 text-[13px] text-ink-2 underline underline-offset-2 hover:text-ink disabled:opacity-60'
const SWITCH = 'font-medium text-ink underline underline-offset-2 hover:text-ink'

export type DoorFormProps = {
  mode: DoorMode
  /** In the sheet (on `surface`, heading h2) or as the page (on `paper`, heading h1). */
  place: 'sheet' | 'page'
  /** The heading, when the page wants its own. */
  title?: string
  titleId?: string
  next: string
  /** Where a member found already in goes; `next` without it. */
  settledNext?: string | undefined
  newcomer: string
  errorReturn: (provider: Provider) => string
  invite?: string | undefined
  link?: MailLink | null | undefined
  error?: SignInError | null | undefined
  replace?: boolean | undefined
  onDone?: (() => void) | undefined
  /** Log in ↔ join inside the sheet; without it, a link to the other page. */
  onSwitch?: (mode: DoorMode) => void
  /** Told whether a request is out, so the sheet does not close under it. */
  busyRef?: { current: boolean }
  /** Told what closing the sheet does instead, if anything: past an unsaved password, go on. */
  closeRef?: { current: (() => void) | null }
  /**
   * Told whether the form is carrying a sign-in through, so the page under the sheet leaves the
   * member to it meanwhile (`ToReading`).
   */
  onCarrying?: ((carrying: boolean) => void) | undefined
  /** For writers' card, made on the way in. */
  claim?: CardClaim | undefined
}

export function DoorForm(props: DoorFormProps) {
  const t = useTranslations('door')
  const { mode, place } = props
  const door = useSignIn({
    next: props.next,
    settledNext: props.settledNext,
    newcomer: props.newcomer,
    errorReturn: props.errorReturn,
    link: props.link,
    error: props.error,
    replace: props.replace,
    onDone: props.onDone,
    claim: props.claim,
  })
  const providers = useProviders()
  const [email, setEmail] = useState(props.link?.email ?? '')
  const [password, setPassword] = useState('')
  // Log in opens on the password (ADR 0043); the code is one press away.
  const [usePassword, setUsePassword] = useState(true)
  const [invite, setInvite] = useState(props.invite ?? '')
  const [otp, setOtp] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const { step, busy, connecting } = door
  const form = useRef<HTMLFormElement>(null)
  const sentId = useId()
  // A new step starts with its own fields empty.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on each change of step, by its kind
  useEffect(() => {
    setOtp('')
    setNewPassword('')
  }, [step.kind])
  // …and takes the focus to its first field, or with none its button, as the sheet does when it
  // opens: the field that held it is gone, and focus left on the page says nothing to a screen
  // reader. Once the request is back, since a button is disabled until then.
  const focused = useRef(step.kind)
  useEffect(() => {
    if (busy || focused.current === step.kind) return
    focused.current = step.kind
    const el = form.current
    const target =
      el?.querySelector<HTMLElement>('[data-autofocus]') ??
      el?.querySelector<HTMLElement>('button[type="submit"]')
    target?.focus()
  }, [step.kind, busy])
  if (props.busyRef) props.busyRef.current = busy
  if (props.closeRef) props.closeRef.current = step.kind === 'unsaved' ? door.goOn : null
  const { onCarrying } = props
  const { carrying } = door
  useEffect(() => {
    onCarrying?.(carrying)
    return () => onCarrying?.(false)
  }, [onCarrying, carrying])
  if (door.settled) return null

  const joining = mode === 'join'
  const field = `${FIELD} ${place === 'sheet' ? 'bg-paper' : 'bg-surface'}`
  const Heading = place === 'sheet' ? 'h2' : 'h1'
  const title =
    props.title ?? (step.kind === 'link' ? null : t(joining ? 'join.title' : 'login.title'))

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (step.kind === 'link') void door.confirmLink(newPassword)
    else if (step.kind === 'code')
      void door.verify(step.email, otp, step.joining ? newPassword : '')
    else if (step.kind === 'reset') void door.reset(step.email, otp, newPassword)
    else if (step.kind === 'unsaved') door.goOn()
    else if (joining) void door.join(invite, email)
    else if (usePassword) void door.logIn(email, password)
    else void door.sendCode(email)
  }

  const primary =
    step.kind === 'link'
      ? t(step.link.reset ? 'resetConfirm' : step.link.join ? 'joinConfirm' : 'linkConfirm')
      : step.kind === 'code' || step.kind === 'unsaved'
        ? t('verify')
        : step.kind === 'reset'
          ? t('resetConfirm')
          : usePassword && !joining
            ? t('logIn')
            : t('sendCode')

  const newPasswordField = (testId: string, placeholder: string, required: boolean) => (
    <input
      key={testId}
      name="new-password"
      type="password"
      required={required}
      minLength={PASSWORD_MIN}
      maxLength={PASSWORD_MAX}
      autoComplete="new-password"
      value={newPassword}
      onChange={(e) => setNewPassword(e.target.value)}
      placeholder={placeholder}
      aria-label={placeholder}
      data-testid={testId}
      className={field}
    />
  )
  // Joining chooses a password, at the code step or from the mail's link (ADR 0043).
  const joinPassword = (
    <>
      {newPasswordField('join-password', t('choosePassword'), true)}
      <p className="text-[12.5px] leading-snug text-muted">
        {t('passwordHint', { min: PASSWORD_MIN })}
      </p>
    </>
  )
  const codeField = (
    <input
      key="code"
      name="code"
      inputMode="numeric"
      autoComplete="one-time-code"
      required
      value={otp}
      onChange={(e) => setOtp(e.target.value)}
      placeholder={t('codePlaceholder')}
      aria-label={t('codePlaceholder')}
      aria-describedby={sentId}
      data-testid="login-code"
      data-autofocus
      className={`${field} font-mono text-lg tracking-widest`}
    />
  )

  return (
    <div className="flex flex-col gap-5">
      {place === 'sheet' ? <LogoMark size={34} /> : null}
      {title ? (
        <div>
          <Heading
            id={props.titleId}
            className={`font-serif font-medium leading-[1.1] tracking-tight ${place === 'sheet' ? 'text-[32px]' : 'text-[34px]'}`}
          >
            {title}
          </Heading>
          {step.kind === 'start' ? (
            <p className="mt-1.5 text-[14.5px] leading-normal text-ink-2">
              {t(joining ? 'join.intro' : 'login.intro')}
            </p>
          ) : null}
        </div>
      ) : null}
      <form ref={form} onSubmit={submit} className="flex flex-col gap-3" data-testid="login-form">
        {step.kind === 'start' ? (
          <>
            {joining ? (
              <input
                name="invite"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                required
                value={invite}
                onChange={(e) => setInvite(e.target.value)}
                placeholder={t('invite')}
                aria-label={t('invite')}
                data-testid="join-code"
                {...(invite ? {} : { 'data-autofocus': true })}
                className={`${field} font-mono tracking-wider`}
              />
            ) : null}
            {providers.length > 0 ? (
              <>
                <div className="flex flex-col gap-2">
                  {providers.map((p) => (
                    <button
                      key={p}
                      type="button"
                      disabled={busy}
                      onClick={() => void door.provider(p, joining ? invite : '')}
                      data-testid={`door-${p}`}
                      className={QUIET}
                    >
                      {t(p)}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-2.5 text-[12px] text-muted">
                  <span className="h-px flex-1 bg-line" />
                  {t('or')}
                  <span className="h-px flex-1 bg-line" />
                </div>
              </>
            ) : null}
            <input
              name="email"
              type="email"
              required
              // Beside a password, the account's name, so a password manager fills the pair.
              autoComplete={usePassword && !joining ? 'username' : 'email'}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t('emailPlaceholder')}
              aria-label={t('email')}
              data-testid="login-email"
              {...(joining && !invite ? {} : { 'data-autofocus': true })}
              className={field}
            />
            {usePassword && !joining ? (
              <>
                <input
                  name="password"
                  type="password"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t('password')}
                  aria-label={t('password')}
                  data-testid="login-password"
                  className={field}
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void door.forgot(email)}
                  data-testid="login-forgot"
                  className="self-end text-[13px] text-ink-2 hover:text-ink disabled:opacity-60"
                >
                  {t('forgot')}
                </button>
              </>
            ) : null}
          </>
        ) : step.kind === 'code' ? (
          <>
            {/* A join always mails a code; a log-in mails one only to an account or an invitation,
                and says nothing of which. */}
            <p id={sentId} className="text-sm text-ink-2">
              {t(step.joining ? 'joinSent' : 'codeSent', { email: step.email })}
            </p>
            {codeField}
            {step.joining ? joinPassword : null}
          </>
        ) : step.kind === 'reset' ? (
          <>
            <p id={sentId} className="text-sm text-ink-2">
              {t('resetSent', { email: step.email })}
            </p>
            {codeField}
            {newPasswordField('login-new-password', t('newPassword', { min: PASSWORD_MIN }), true)}
          </>
        ) : step.kind === 'link' ? (
          <>
            <p className="text-[17px] leading-snug text-ink" data-testid="login-link-as">
              {t.rich(step.link.reset ? 'resetAs' : step.link.join ? 'joinAs' : 'linkAs', {
                email: step.link.email,
                b: (chunks) => <b className="font-medium break-all">{chunks}</b>,
              })}
            </p>
            {connecting ? null : (
              <p className="text-sm leading-relaxed text-ink-2">
                {t(step.link.reset ? 'resetHint' : 'linkHint')}
              </p>
            )}
            {step.link.reset
              ? newPasswordField(
                  'login-new-password',
                  t('newPassword', { min: PASSWORD_MIN }),
                  true,
                )
              : step.link.join
                ? joinPassword
                : null}
          </>
        ) : (
          <p className="text-sm leading-relaxed text-ink-2" data-testid="door-unsaved">
            {t('unsaved')}
          </p>
        )}
        {connecting ? (
          <p className="text-sm text-ink-2" data-testid="login-connecting">
            {t('connecting')}
          </p>
        ) : door.error ? (
          <p role="alert" className="text-[13px] text-danger" data-testid="door-error">
            {t(`errors.${door.error}`, { min: PASSWORD_MIN })}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={busy || connecting}
          data-testid="login-submit"
          className={`${PRIMARY} mt-0.5`}
        >
          {primary}
        </button>
        {step.kind === 'start' && !joining ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => setUsePassword((on) => !on)}
            data-testid="login-mode"
            className={TEXT_BUTTON}
          >
            {t(usePassword ? 'useCode' : 'usePassword')}
          </button>
        ) : null}
        {(step.kind === 'code' || step.kind === 'reset' || step.kind === 'link') && !connecting ? (
          <button
            type="button"
            disabled={busy}
            onClick={door.restart}
            data-testid="login-link-other"
            className={TEXT_BUTTON}
          >
            {t('otherAddress')}
          </button>
        ) : null}
      </form>
      {step.kind === 'start' && joining ? (
        <div className="flex flex-col gap-1.5 text-[13px] leading-relaxed text-muted">
          <p>{t('noCode')}</p>
          <p>
            {/* In a tab of their own: the sheet, and the invite code in it, stay where they are. */}
            {t.rich('agree', {
              terms: (chunks) => (
                <a href="/terms" target="_blank" rel="noopener" data-testid="door-terms">
                  {chunks}
                </a>
              ),
              privacy: (chunks) => (
                <a href="/privacy" target="_blank" rel="noopener" data-testid="door-privacy">
                  {chunks}
                </a>
              ),
            })}
          </p>
        </div>
      ) : null}
      {step.kind === 'start' ? (
        <p className="flex justify-center gap-1.5 border-t border-line pt-3.5 text-[13px] text-muted">
          <span>{t(joining ? 'haveAccount' : 'newHere')}</span>
          {props.onSwitch ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => props.onSwitch?.(joining ? 'login' : 'join')}
              data-testid="door-switch"
              className={SWITCH}
            >
              {t(joining ? 'toLogin' : 'toJoin')}
            </button>
          ) : (
            <Link to={joining ? '/login' : '/join'} data-testid="door-switch" className={SWITCH}>
              {t(joining ? 'toLogin' : 'toJoin')}
            </Link>
          )}
        </p>
      ) : null}
    </div>
  )
}

function Sheet({
  request,
  onClose,
  onDone,
  onCarrying,
}: {
  request: Opened
  onClose: () => void
  onDone: () => void
  onCarrying: (carrying: boolean) => void
}) {
  const t = useTranslations('door')
  const dialog = useRef<HTMLDialogElement>(null)
  const busy = useRef(false)
  const goOn = useRef<(() => void) | null>(null)
  const titleId = useId()
  const first: DoorMode =
    request.mode === 'login'
      ? 'login'
      : request.mode === 'claim'
        ? (request.start ?? 'join')
        : 'join'
  const [mode, setMode] = useState<DoorMode>(first)

  useEffect(() => {
    const el = dialog.current
    // Once: React may run this twice in development, and an open dialog refuses a second.
    if (el && !el.open) el.showModal()
    // The field to type in first, rather than the dialog's first button.
    el?.querySelector<HTMLElement>('[data-autofocus]')?.focus()
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: on each switch, by the mode
  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus()
  }, [mode])

  const card: CardClaim | undefined =
    request.mode === 'claim'
      ? { handle: request.handle, name: request.name, url: request.blog }
      : undefined
  const { next, newcomer, settledNext } = doorRoutes(
    mode,
    request.mode === 'login' ? (request.next ?? null) : null,
    card ? claimPath(card.url) : null,
  )
  const close = () => {
    if (busy.current) return
    // Past a password that was not saved, the member is in: closing goes on as Continue does, not
    // back to the page under the sheet, which would send them somewhere else.
    if (goOn.current) goOn.current()
    else onClose()
  }
  return (
    <dialog
      ref={dialog}
      // Esc: closing the dialog is closing the door, unless a request is out.
      onCancel={(e) => {
        e.preventDefault()
        close()
      }}
      aria-labelledby={titleId}
      className="m-auto max-h-[calc(100dvh-32px)] w-[min(420px,calc(100vw-32px))] overflow-y-auto rounded-2xl border border-line bg-surface p-6 text-ink shadow-[0_30px_80px_rgba(0,0,0,.25)] backdrop:bg-[rgba(0,0,0,.45)] sm:p-8"
      data-testid="front-door"
    >
      <DoorForm
        key={mode}
        mode={mode}
        place="sheet"
        {...(card
          ? { title: card.handle ? t('claimTitle', { handle: card.handle }) : t('claimCard') }
          : {})}
        titleId={titleId}
        next={next}
        settledNext={settledNext}
        newcomer={newcomer}
        // The address as it is now, not as the router last read it: a page may have taken a code
        // or an error out of it since (`/join?code=`).
        errorReturn={(p) => errorReturn(window.location.pathname, window.location.search, mode, p)}
        invite={mode === 'join' && request.mode !== 'login' ? request.code : undefined}
        error={mode === first ? request.error : null}
        replace={request.at === '/join'}
        onDone={onDone}
        onSwitch={setMode}
        busyRef={busy}
        closeRef={goOn}
        onCarrying={onCarrying}
        claim={card}
      />
      {/* After the form, so the dialog's first focus is a field, not this. */}
      <button
        type="button"
        onClick={close}
        aria-label={t('close')}
        data-testid="door-close"
        className="absolute top-3.5 right-3.5 flex size-8 items-center justify-center rounded-lg text-[16px] text-muted hover:bg-paper hover:text-ink"
      >
        <span aria-hidden="true">✕</span>
      </button>
    </dialog>
  )
}

/**
 * Holds the sheet for the whole app. A sheet belongs to the page it opened on, so leaving that
 * page (a link in it, Back, or wherever signing in went) closes it. A page that comes back from
 * Google or GitHub with `?door=` opens it again, saying why it came back.
 */
export function FrontDoorProvider({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  const { status } = useSession()
  const navigate = useNavigate()
  const go = useRef(navigate)
  go.current = navigate
  // The page as rendered, which a page's own effect opening the sheet is on.
  const here = useRef(location.pathname)
  here.current = location.pathname
  const opened = useRef(0)
  const [request, setRequest] = useState<Opened | null>(null)
  // Whether the open sheet's form is carrying a sign-in through (`DoorForm`'s `onCarrying`).
  const [carrying, setCarrying] = useState(false)
  const open = useCallback((next: DoorRequest) => {
    setRequest({ ...next, at: here.current, key: ++opened.current })
  }, [])

  useEffect(() => {
    if (request && request.at !== location.pathname) setRequest(null)
  }, [request, location.pathname])

  // Back from a provider that refused, or that the visitor cancelled. `/login` and `/join` read
  // their own query.
  useEffect(() => {
    if (location.pathname === '/login' || location.pathname === '/join') return
    const params = new URLSearchParams(location.search)
    const mode = params.get('door')
    if (mode !== 'login' && mode !== 'join') return
    const error = params.get('error')
    window.history.replaceState(
      window.history.state,
      '',
      withoutDoor(location.pathname, location.search),
    )
    const said = error ? { error: providerError(error) } : {}
    // A card on its way in comes back as it was, whichever door the provider was tried from.
    const card = takeClaim()
    const code = mode === 'join' ? (takeInvite() ?? undefined) : undefined
    if (card) {
      const { url: blog, ...named } = card
      open({ mode: 'claim', ...named, blog, start: mode, code, ...said })
    } else open(mode === 'join' ? { mode, code, ...said } : { mode, ...said })
  }, [location.pathname, location.search, open])

  const shown = request && request.at === location.pathname ? request : null
  // Until the sheet signing someone in lets go, it says where they go, not the page under it.
  const decides = shown !== null && carrying

  // A card whose sign-in outlived its sheet: back from Google or GitHub, reloaded as another
  // account, or the sheet closed while /me could not be reached. Finished once the tab is the
  // member's; an open claim sheet finishes its own.
  const claiming = shown?.mode === 'claim'
  useEffect(() => {
    if (status !== 'member' || claiming) return
    const card = takeClaim()
    if (!card) return
    void finishCard(card).then((to) => {
      const here = window.location.pathname + window.location.search
      if (to !== here) go.current(to, { replace: window.location.pathname === '/claim' })
    })
  }, [status, claiming])
  return (
    <DoorContext.Provider value={open}>
      <SheetDecides.Provider value={decides}>
        {children}
        {shown ? (
          <Sheet
            key={shown.key}
            request={shown}
            onClose={() => {
              setRequest(null)
              shown.onClose?.()
            }}
            onDone={() => setRequest(null)}
            onCarrying={setCarrying}
          />
        ) : null}
      </SheetDecides.Provider>
    </DoorContext.Provider>
  )
}
