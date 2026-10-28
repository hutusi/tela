/**
 * Settings → Developer (ADR 0067): the apps a member registered for Tela's API, as on GitHub. Each
 * shows its status (Testing, where only its developer connects it; Live; or Cut off by Tela),
 * whether Tela reviewed it, how many members it holds against the cap an unreviewed app shares, and
 * its client ID to copy. A live answer, like Connected apps, never the synced tables: an app's
 * record, its contact address included, is on no device (`lib/developer-api.ts`).
 *
 * The form is the reader's own, not the console's (`admin/components/app-form.tsx` is in the
 * admin chunk, with the admin's catalogues): what tela-api would refuse is refused here first, by
 * the same rule (`parseDeveloperApp`), and the first field that is wrong says why and takes focus.
 * Everything that costs other members something asks first, inline: back to Testing and Delete end
 * their connections, and an edit to the name, the redirect URIs or the scope clears Tela's review.
 */
import {
  APP_NAME_MAX,
  APP_REDIRECTS_MAX,
  APP_TEXT_MAX,
  APP_URL_MAX,
  type AppScope,
  type DeveloperApp,
  type DeveloperAppField,
  type DeveloperAppSettings,
  mentionsTela,
  parseDeveloperApp,
  REVIEW_NOTE_MAX,
} from '@tela/shared'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslations } from 'use-intl'
import { CHECK, Glyph } from '../components/glyph'
import { type Account, getAccount } from '../lib/account-api'
import {
  type DeveloperOutcome,
  type DeveloperProblem,
  deleteApp,
  editApp,
  listDeveloperApps,
  registerApp,
  requestReview,
  setLive,
} from '../lib/developer-api'
import { useLive } from '../lib/use-live'
import { useUi } from '../ui'
import { dayOf } from './settings-apps'

/** How Tela's API works, for developers (the repository is public). */
export const API_GUIDE = 'https://github.com/hutusi/tela/blob/main/docs/api/README.md'
/** The rules a developer accepts when they register an app. */
export const DEVELOPER_RULES = 'https://github.com/hutusi/tela/blob/main/docs/api/policy.md'

const QUIET =
  'rounded-full border border-thumb px-3.5 py-[7px] text-[13px] font-medium whitespace-nowrap hover:border-ink disabled:opacity-60'
const PILL = `${QUIET} text-ink`
const MUTED_PILL = `${QUIET} text-muted hover:text-ink`
const DANGER_PILL = `${QUIET} text-danger hover:border-danger`
/** The small pill beside the client ID. */
const COPY_PILL =
  'rounded-full border border-thumb px-2.5 py-[3px] text-[12.5px] font-medium whitespace-nowrap text-muted hover:border-ink hover:text-ink'
/** The filled button for the one action a panel is for. */
const PRIMARY =
  'rounded-full bg-ink px-[18px] py-[9px] text-[13.5px] font-medium whitespace-nowrap text-paper hover:brightness-125 disabled:opacity-60'
const FIELD =
  'w-full min-w-0 rounded-lg border border-line bg-surface px-3 py-2.5 text-[15px] text-ink outline-none focus:border-muted aria-[invalid=true]:border-danger'
const LABEL = 'text-[13px] font-medium text-ink-2'
const HINT = 'm-0 text-[12.5px] leading-snug text-muted'
const LINK = 'text-ink underline'

/** The status pill's dot, a token per status; its words always say it too. */
const DOT = { draft: 'bg-info', approved: 'bg-ok', suspended: 'bg-danger' } as const

function Intro({ children }: { children: React.ReactNode }) {
  return <p className="mb-[18px] text-[14px] text-muted md:mb-7">{children}</p>
}

const external = (href: string) => (chunks: React.ReactNode) => (
  <a href={href} target="_blank" rel="noopener noreferrer" className={LINK}>
    {chunks}
  </a>
)

// ---------------------------------------------------------------------------------------------
// The form's rules, pure so they are tested on their own

/** What the form holds: every field as typed, the redirect URIs one a line. */
export type Draft = Record<Exclude<DeveloperAppField, 'maxScope'>, string> & { maxScope: AppScope }

/** A field the form can name as wrong: a setting, or the developer rules left unaccepted. */
export type FormField = DeveloperAppField | 'terms'

/** The form's start: an app's settings as they are, for Edit; empty for a new app. */
export function draftOf(app: DeveloperAppSettings | null): Draft {
  return {
    name: app?.name ?? '',
    developer: app?.developer ?? '',
    contactEmail: app?.contactEmail ?? '',
    homepageUrl: app?.homepageUrl ?? '',
    privacyUrl: app?.privacyUrl ?? '',
    redirectUris: app?.redirectUris.join('\n') ?? '',
    maxScope: app?.maxScope ?? 'read',
  }
}

/** The redirect URIs as typed: one a line, blank lines dropped. */
const linesOf = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

/** An empty contact address while a new app is checked: tela-api fills in the account's. */
const STAND_IN = 'member@example.com'

export type Checked =
  | {
      ok: true
      settings: DeveloperAppSettings
      /** The contact address was left empty: the account's own. */
      ownAddress: boolean
    }
  | { ok: false; field: FormField }

/**
 * The form checked as tela-api will check it, or the first field that is wrong. An empty contact
 * address is the account's: a new app leaves it to tela-api, which knows it; an edit sends the
 * address Settings was told, and with none to send it is wrong.
 */
export function checkDraft(
  draft: Draft,
  {
    creating,
    accepted,
    accountEmail,
  }: { creating: boolean; accepted: boolean; accountEmail: string | null },
): Checked {
  const ownAddress = draft.contactEmail.trim() === ''
  let contactEmail = draft.contactEmail
  if (ownAddress) contactEmail = creating ? STAND_IN : (accountEmail ?? '')
  const parsed = parseDeveloperApp({
    ...draft,
    contactEmail,
    redirectUris: linesOf(draft.redirectUris),
  })
  if (!parsed.ok) return parsed
  if (creating && !accepted) return { ok: false, field: 'terms' }
  return { ok: true, settings: parsed.value, ownAddress }
}

/**
 * Whether saving the form clears the app's review (ADR 0067): a reviewed app whose name, redirect
 * URIs or scope changes is reviewed again before its cap and email ban are lifted.
 */
export function clearsReview(app: DeveloperApp, draft: Draft): boolean {
  if (!app.reviewed) return false
  const uris = linesOf(draft.redirectUris)
  return (
    draft.name.trim() !== app.name ||
    draft.developer.trim() !== app.developer ||
    (draft.homepageUrl.trim() || null) !== app.homepageUrl ||
    (draft.privacyUrl.trim() || null) !== app.privacyUrl ||
    draft.maxScope !== app.maxScope ||
    uris.length !== app.redirectUris.length ||
    uris.some((uri, i) => uri !== app.redirectUris[i])
  )
}

// ---------------------------------------------------------------------------------------------
// The section

export function DeveloperSection() {
  const { value, failed, reload } = useLive<DeveloperApp[]>(listDeveloperApps)
  // Only for the contact address an empty field stands for, which the form shows in that field.
  const { value: account } = useLive<Account>(getAccount)
  return (
    <DeveloperApps
      apps={value}
      failed={failed}
      accountEmail={account?.email ?? null}
      onChange={() => void reload()}
    />
  )
}

/** The section as its answer has it: on its way (null), failed, empty, or a row per app. */
export function DeveloperApps({
  apps,
  failed,
  accountEmail,
  onChange,
}: {
  apps: DeveloperApp[] | null
  failed: boolean
  accountEmail: string | null
  onChange: () => void
}) {
  const t = useTranslations('developer')
  const [registering, setRegistering] = useState(false)
  // Unreviewed apps share one cap, which tela-api sends with each: said once, under the list.
  const cap = apps?.find((app) => !app.reviewed && app.cap !== null)?.cap ?? null
  return (
    <>
      <Intro>{t.rich('intro', { guide: external(API_GUIDE) })}</Intro>
      {failed && !apps ? (
        <p role="alert" className="pb-4 text-[13px] text-danger" data-testid="developer-error">
          {t('errors.load')}
        </p>
      ) : null}
      {apps && !registering ? (
        <div className="pb-5">
          <button
            type="button"
            onClick={() => setRegistering(true)}
            className={PRIMARY}
            data-testid="developer-register"
          >
            {t('register')}
          </button>
        </div>
      ) : null}
      {registering ? (
        <div className="border-t border-line py-5" data-testid="developer-new">
          <AppForm
            app={null}
            accountEmail={accountEmail}
            onDone={() => {
              setRegistering(false)
              onChange()
            }}
            onCancel={() => setRegistering(false)}
          />
        </div>
      ) : null}
      {apps && apps.length === 0 && !registering ? (
        <div className="border-t border-line pt-5" data-testid="developer-none">
          <p className="m-0 font-medium text-ink">{t('none')}</p>
          <p className="mt-1.5 mb-0 text-[14px] text-ink-2">
            {t.rich('noneBody', { guide: external(API_GUIDE) })}
          </p>
          <p className="mt-2.5 mb-0 text-[14px] text-ink-2">{t('noneLimits')}</p>
        </div>
      ) : null}
      {apps && apps.length > 0 ? (
        <ul className="m-0 list-none p-0" data-testid="developer-apps">
          {apps.map((app) => (
            <AppRow key={app.appId} app={app} accountEmail={accountEmail} onChange={onChange} />
          ))}
        </ul>
      ) : null}
      {apps ? (
        <div className="border-t border-line pt-4 text-[13px] text-muted">
          {cap === null ? null : (
            <p className="mt-0 mb-2" data-testid="developer-cap">
              {t('capNote', { cap })}
            </p>
          )}
          <p className="m-0">{t.rich('rules', { rules: external(DEVELOPER_RULES) })}</p>
        </div>
      ) : null}
    </>
  )
}

/** What a row has open under it: a question, the review request, or the form. */
export type RowMode = 'testing' | 'delete' | 'review' | 'edit'

export function AppRow({
  app,
  accountEmail,
  onChange,
}: {
  app: DeveloperApp
  accountEmail: string | null
  onChange: () => void
}) {
  const t = useTranslations('developer')
  const { locale } = useUi()
  const [mode, setMode] = useState<RowMode | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<DeveloperProblem | null>(null)
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(app.clientId)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // No clipboard (an insecure origin, a denied permission): the ID is on screen to select.
      setCopied(false)
    }
  }

  /** Run a change, close what was open once it lands, and say why if tela-api refused it. */
  const run = async (change: () => Promise<DeveloperOutcome>) => {
    setBusy(true)
    setProblem(null)
    try {
      const outcome = await change()
      if (outcome.ok) {
        setMode(null)
        onChange()
      } else setProblem(outcome.problem)
    } catch {
      setProblem({ error: 'failed' })
    } finally {
      setBusy(false)
    }
  }

  const open = (next: RowMode) => {
    setProblem(null)
    setMode(next)
  }

  const goLive = () => {
    // The consent page links the policy, so Live needs one: said at once, without asking.
    if (app.privacyUrl === null) setProblem({ error: 'privacy_required' })
    else void run(() => setLive(app.appId, true))
  }

  const cut = app.status === 'suspended'
  const reviewAsked = !app.reviewed && app.reviewRequestedAt !== null
  return (
    <li
      className="border-t border-line py-4"
      data-testid="developer-app"
      data-id={app.appId}
      data-status={app.status}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div
          className="min-w-0 font-medium [overflow-wrap:anywhere] text-ink"
          data-testid="developer-app-name"
        >
          {app.homepageUrl ? (
            <a
              href={app.homepageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-ink hover:underline"
            >
              {app.name}
            </a>
          ) : (
            app.name
          )}
        </div>
        <span
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-thumb px-2.5 py-0.5 text-[12.5px] text-ink-2"
          data-testid="developer-app-status"
        >
          <span aria-hidden="true" className={`size-[7px] rounded-full ${DOT[app.status]}`} />
          {t(`status.${app.status}`)}
        </span>
      </div>
      <div className="mt-1 text-[13.5px] text-ink-2">{t(`statusBody.${app.status}`)}</div>
      <div
        className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[13px] text-muted"
        data-testid="developer-app-review"
      >
        {app.reviewed ? (
          <span className="inline-flex items-center gap-1 text-ink-2">
            <Glyph size={14}>{CHECK}</Glyph>
            {t('reviewed')}
          </span>
        ) : (
          <span>{t('notReviewed')}</span>
        )}
        {reviewAsked && app.reviewRequestedAt !== null ? (
          <span>· {t('reviewAsked', { date: dayOf(app.reviewRequestedAt, locale) })}</span>
        ) : null}
      </div>
      <div className="mt-[3px] text-[13px] text-muted" data-testid="developer-app-connections">
        {app.cap === null
          ? t('connections', { n: app.connections })
          : t('connectionsOf', { n: app.connections, cap: app.cap })}
        {' · '}
        {t('registered', { date: dayOf(app.createdAt, locale) })}
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <span className="text-[13px] text-muted">{t('clientId')}</span>
        <code
          className="min-w-0 font-mono text-[13px] [overflow-wrap:anywhere] text-ink select-all"
          data-testid="developer-app-client-id"
        >
          {app.clientId}
        </code>
        <button
          type="button"
          onClick={() => void copy()}
          className={COPY_PILL}
          data-testid="developer-app-copy"
        >
          {copied ? t('copied') : t('copy')}
        </button>
      </div>
      {/* Cut off, the app has nothing left to change: its status line says why. */}
      {mode === 'edit' || cut ? null : (
        <div className="mt-3 flex flex-wrap gap-2" data-testid="developer-app-actions">
          {app.status === 'draft' ? (
            <button
              type="button"
              disabled={busy}
              onClick={goLive}
              className={PILL}
              data-testid="developer-app-live"
            >
              {t('actions.live')}
            </button>
          ) : null}
          {app.status === 'approved' ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => open('testing')}
              className={PILL}
              data-testid="developer-app-testing"
            >
              {t('actions.testing')}
            </button>
          ) : null}
          {!app.reviewed && !reviewAsked ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => open('review')}
              className={PILL}
              data-testid="developer-app-review-ask"
            >
              {t('actions.review')}
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => open('edit')}
            className={MUTED_PILL}
            data-testid="developer-app-edit"
          >
            {t('actions.edit')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => open('delete')}
            className={MUTED_PILL}
            data-testid="developer-app-delete"
          >
            {t('actions.delete')}
          </button>
        </div>
      )}
      {problem ? (
        <p
          role="alert"
          className="mt-2 mb-0 text-[13px] text-danger"
          data-testid="developer-app-error"
        >
          <ProblemText problem={problem} />
        </p>
      ) : null}
      {mode === null ? null : (
        <RowPanel
          app={app}
          mode={mode}
          busy={busy}
          accountEmail={accountEmail}
          onTesting={() => void run(() => setLive(app.appId, false))}
          onDelete={() => void run(() => deleteApp(app.appId))}
          onReview={(note, wantsEmail) =>
            void run(() => requestReview(app.appId, note, wantsEmail))
          }
          onSaved={() => {
            setMode(null)
            onChange()
          }}
          onCancel={() => setMode(null)}
        />
      )}
    </li>
  )
}

/** What a row has open: each question names what it costs, and the review says what it lifts. */
export function RowPanel({
  app,
  mode,
  busy,
  accountEmail,
  onTesting,
  onDelete,
  onReview,
  onSaved,
  onCancel,
}: {
  app: DeveloperApp
  mode: RowMode
  busy: boolean
  accountEmail: string | null
  onTesting: () => void
  onDelete: () => void
  onReview: (note: string | null, wantsEmail: boolean) => void
  onSaved: () => void
  onCancel: () => void
}) {
  const t = useTranslations('developer')
  if (mode === 'edit') {
    return (
      <div className="mt-4" data-testid="developer-app-form">
        <AppForm app={app} accountEmail={accountEmail} onDone={onSaved} onCancel={onCancel} />
      </div>
    )
  }
  if (mode === 'review') {
    return <ReviewForm busy={busy} onSend={onReview} onCancel={onCancel} />
  }
  const testing = mode === 'testing'
  return (
    <div
      className="mt-3 flex flex-col gap-2.5 rounded-xl border border-line bg-surface p-3.5"
      data-testid={`developer-app-confirm-${mode}`}
    >
      <p className="m-0 text-[13.5px] text-ink-2">
        {testing ? t('testingConfirm', { name: app.name }) : t('deleteConfirm', { name: app.name })}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={testing ? onTesting : onDelete}
          className={DANGER_PILL}
          data-testid={`developer-app-${mode}-yes`}
        >
          {testing ? t('testingYes') : t('deleteYes')}
        </button>
        <button type="button" disabled={busy} onClick={onCancel} className={MUTED_PILL}>
          {t('cancel')}
        </button>
      </div>
    </div>
  )
}

/** Asking Tela for a review: what it lifts, a note, and whether the app needs email addresses. */
export function ReviewForm({
  busy,
  onSend,
  onCancel,
}: {
  busy: boolean
  onSend: (note: string | null, wantsEmail: boolean) => void
  onCancel: () => void
}) {
  const t = useTranslations('developer')
  const id = useId()
  const [note, setNote] = useState('')
  const [wantsEmail, setWantsEmail] = useState(false)
  return (
    <form
      className="mt-3 flex flex-col gap-3 rounded-xl border border-line bg-surface p-3.5"
      data-testid="developer-app-review-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (!busy) onSend(note.trim() === '' ? null : note.trim(), wantsEmail)
      }}
    >
      <p className="m-0 text-[13.5px] text-ink-2">{t('reviewIntro')}</p>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-note`} className={LABEL}>
          {t('reviewNote')}
        </label>
        <textarea
          id={`${id}-note`}
          rows={3}
          maxLength={REVIEW_NOTE_MAX}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          aria-describedby={`${id}-note-hint`}
          className={`${FIELD} resize-y bg-paper text-[14px]`}
          data-testid="developer-review-note"
        />
        <p id={`${id}-note-hint`} className={HINT}>
          {t('reviewNoteHint', { n: REVIEW_NOTE_MAX })}
        </p>
      </div>
      <label className="flex items-start gap-2 text-[14px] text-ink">
        <input
          type="checkbox"
          className="mt-[3px]"
          checked={wantsEmail}
          onChange={(e) => setWantsEmail(e.target.checked)}
          data-testid="developer-review-email"
        />
        {t('reviewEmail')}
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className={PILL} data-testid="developer-review-send">
          {t('reviewSend')}
        </button>
        <button type="button" disabled={busy} onClick={onCancel} className={MUTED_PILL}>
          {t('cancel')}
        </button>
      </div>
    </form>
  )
}

/** Why tela-api refused a change, in the member's words. */
function ProblemText({ problem }: { problem: DeveloperProblem }) {
  const t = useTranslations('developer')
  switch (problem.error) {
    case 'invalid':
      return <>{t('errors.failed')}</>
    case 'app_limit':
      return <>{t('errors.app_limit', { limit: problem.limit })}</>
    default:
      return <>{t(`errors.${problem.error}`)}</>
  }
}

// ---------------------------------------------------------------------------------------------
// The form

/** Register an app (`app` null) or edit one. Sends it itself, and says why tela-api refused. */
export function AppForm({
  app,
  accountEmail,
  onDone,
  onCancel,
}: {
  app: DeveloperApp | null
  accountEmail: string | null
  onDone: () => void
  onCancel: () => void
}) {
  const t = useTranslations('developer.form')
  const id = useId()
  const creating = app === null
  const [draft, setDraft] = useState<Draft>(() => draftOf(app))
  const [accepted, setAccepted] = useState(false)
  const [wrong, setWrong] = useState<FormField | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<DeveloperProblem | null>(null)
  const form = useRef<HTMLFormElement>(null)
  useEffect(() => {
    form.current?.querySelector<HTMLElement>('input, textarea')?.focus()
  }, [])

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((now) => ({ ...now, [key]: value }))
    if (wrong === key) setWrong(null)
  }
  const refuse = (field: FormField) => {
    setWrong(field)
    form.current?.querySelector<HTMLElement>(`[data-field="${field}"]`)?.focus()
  }

  const clearing = app !== null && clearsReview(app, draft)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    const checked = checkDraft(draft, { creating, accepted, accountEmail })
    if (!checked.ok) return refuse(checked.field)
    setBusy(true)
    setProblem(null)
    try {
      let outcome: Awaited<ReturnType<typeof editApp>>
      if (app === null) {
        const { contactEmail, ...rest } = checked.settings
        outcome = await registerApp({
          ...rest,
          ...(checked.ownAddress ? {} : { contactEmail }),
          acceptTerms: true,
        })
      } else outcome = await editApp(app.appId, checked.settings)
      if (outcome.ok) onDone()
      else if (outcome.problem.error === 'invalid') refuse(outcome.problem.field)
      else setProblem(outcome.problem)
    } catch {
      setProblem({ error: 'failed' })
    } finally {
      setBusy(false)
    }
  }

  /** Why a field is wrong; a name or developer that says "Tela" is told why that is refused. */
  const why = (field: FormField) => {
    if (field === 'name' && mentionsTela(draft.name)) return t('errors.nameTela')
    if (field === 'developer' && mentionsTela(draft.developer)) return t('errors.developerTela')
    return t(`errors.${field}`, { name: APP_NAME_MAX, text: APP_TEXT_MAX, n: APP_REDIRECTS_MAX })
  }

  const described = (field: FormField, hint: boolean) =>
    [hint ? `${id}-${field}-hint` : null, wrong === field ? `${id}-${field}-error` : null]
      .filter(Boolean)
      .join(' ') || undefined

  const error = (field: FormField) =>
    wrong === field ? (
      <p
        id={`${id}-${field}-error`}
        role="alert"
        className="m-0 text-[13px] text-danger"
        data-testid="developer-form-error"
        data-field-error={field}
      >
        {why(field)}
      </p>
    ) : null

  const text = (
    field: Exclude<DeveloperAppField, 'maxScope' | 'redirectUris'>,
    options: { type?: string; max: number; hint?: string; placeholder?: string },
  ) => (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`${id}-${field}`} className={LABEL}>
        {t(field)}
      </label>
      <input
        id={`${id}-${field}`}
        type={options.type ?? 'text'}
        autoComplete="off"
        spellCheck={false}
        maxLength={options.max}
        placeholder={options.placeholder}
        value={draft[field]}
        onChange={(e) => set(field, e.target.value)}
        aria-invalid={wrong === field}
        aria-describedby={described(field, options.hint !== undefined)}
        className={FIELD}
        data-field={field}
        data-testid={`developer-form-${field}`}
      />
      {options.hint ? (
        <p id={`${id}-${field}-hint`} className={HINT}>
          {options.hint}
        </p>
      ) : null}
      {error(field)}
    </div>
  )

  return (
    <form
      ref={form}
      className="flex flex-col gap-4"
      data-testid="developer-form"
      data-creating={creating}
      noValidate
      onSubmit={(e) => void submit(e)}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        onCancel()
      }}
    >
      {creating ? <p className="m-0 font-medium text-ink">{t('title')}</p> : null}
      {text('name', { max: APP_NAME_MAX, hint: t('nameHint') })}
      {text('developer', { max: APP_TEXT_MAX, hint: t('developerHint') })}
      {text('contactEmail', {
        type: 'email',
        max: APP_TEXT_MAX,
        hint: t('contactHint'),
        placeholder: accountEmail ?? t('contactPlaceholder'),
      })}
      {text('homepageUrl', { type: 'url', max: APP_URL_MAX })}
      {text('privacyUrl', { type: 'url', max: APP_URL_MAX, hint: t('urlHint') })}
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-redirectUris`} className={LABEL}>
          {t('redirectUris')}
        </label>
        <textarea
          id={`${id}-redirectUris`}
          rows={3}
          spellCheck={false}
          value={draft.redirectUris}
          onChange={(e) => set('redirectUris', e.target.value)}
          aria-invalid={wrong === 'redirectUris'}
          aria-describedby={described('redirectUris', true)}
          className={`${FIELD} resize-y font-mono text-[13px]`}
          data-field="redirectUris"
          data-testid="developer-form-redirectUris"
        />
        <p id={`${id}-redirectUris-hint`} className={HINT}>
          {t('redirectHint', { n: APP_REDIRECTS_MAX })}
        </p>
        {error('redirectUris')}
      </div>
      <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
        <legend className={`${LABEL} mb-1.5 p-0`}>{t('maxScope')}</legend>
        {(['read', 'write'] as const).map((scope) => (
          <label key={scope} className="flex items-center gap-2 text-[14px] text-ink">
            <input
              type="radio"
              name={`${id}-scope`}
              checked={draft.maxScope === scope}
              onChange={() => set('maxScope', scope)}
              data-field={scope === 'read' ? 'maxScope' : undefined}
              data-testid={`developer-form-scope-${scope}`}
            />
            {t(`scope.${scope}`)}
          </label>
        ))}
        {error('maxScope')}
      </fieldset>
      {creating ? (
        <div className="flex flex-col gap-1.5">
          <label className="flex items-start gap-2 text-[14px] text-ink">
            <input
              type="checkbox"
              className="mt-[3px]"
              checked={accepted}
              onChange={(e) => {
                setAccepted(e.target.checked)
                if (wrong === 'terms') setWrong(null)
              }}
              aria-invalid={wrong === 'terms'}
              aria-describedby={described('terms', false)}
              data-field="terms"
              data-testid="developer-form-terms"
            />
            <span>{t.rich('terms', { rules: external(DEVELOPER_RULES) })}</span>
          </label>
          {error('terms')}
        </div>
      ) : null}
      {clearing ? (
        <p
          role="status"
          className="m-0 rounded-xl border border-thumb px-3 py-2 text-[13px] text-ink-2"
          data-testid="developer-form-clears-review"
        >
          {t('clearsReview')}
        </p>
      ) : null}
      {problem ? (
        <p
          role="alert"
          className="m-0 text-[13px] text-danger"
          data-testid="developer-form-problem"
        >
          <ProblemText problem={problem} />
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={busy}
          className={PRIMARY}
          data-testid="developer-form-submit"
        >
          {creating ? t('register') : clearing ? t('saveClearing') : t('save')}
        </button>
        <button type="button" disabled={busy} onClick={onCancel} className={MUTED_PILL}>
          {t('cancel')}
        </button>
      </div>
    </form>
  )
}
