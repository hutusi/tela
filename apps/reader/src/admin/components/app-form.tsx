/**
 * An app's settings as a form (ADR 0064), for registering one and editing it: inline, where the
 * action was asked, like every question the console asks. What tela-api would refuse is refused
 * here first, by the same rule (`parseAppSettings`), and the first field that is wrong is named
 * and given focus. A long form scrolls inside itself, so it never pushes a record's actions off
 * the panel it sits in.
 */
import {
  APP_DEFAULT_PER_APP_PER_MIN,
  APP_DEFAULT_PER_MEMBER_PER_MIN,
  APP_NAME_MAX,
  APP_REDIRECTS_MAX,
  APP_TEXT_MAX,
  APP_URL_MAX,
  type AppScope,
} from '@tela/shared'
import {
  type AdminActArgs,
  type AdminAppSettings,
  type AppField,
  parseAppSettings,
} from '@tela/shared/admin'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslations } from 'use-intl'
import { ActionButton } from './buttons'

const FIELD =
  'w-full min-w-0 rounded-lg border border-line bg-field px-3 py-2 text-[14px] text-ink outline-none focus:border-muted aria-[invalid=true]:border-danger'
const LABEL = 'text-[12.5px] font-medium text-muted'
const HINT = 'm-0 text-[12px] leading-snug text-muted'

/** What the form holds: every field as typed, numbers and lists included. */
type Draft = Record<Exclude<AppField, 'maxScope' | 'allowEmail'>, string> & {
  maxScope: AppScope
  allowEmail: boolean
}

const EMPTY: Draft = {
  name: '',
  developer: '',
  contactEmail: '',
  homepageUrl: '',
  privacyUrl: '',
  redirectUris: '',
  maxScope: 'read',
  allowEmail: false,
  owner: '',
  perMemberPerMin: '',
  perAppPerMin: '',
  maxConnections: '',
}

/**
 * What Edit starts from: an app's settings, and whether its owner is fixed, as a member's app's is
 * (ADR 0067). tela-api keeps that owner whatever is sent; the form shows it cannot be changed.
 */
export type AppFormStart = AdminAppSettings & { ownerLocked?: boolean }

/** The form's start: an app's settings as they are, for Edit; empty for a new app. */
export function draftOf(app: unknown): Draft {
  const parsed = parseAppSettings(app)
  if (!parsed.ok) return EMPTY
  const s = parsed.value
  const count = (n: number | null) => (n === null ? '' : String(n))
  return {
    name: s.name,
    developer: s.developer,
    contactEmail: s.contactEmail,
    homepageUrl: s.homepageUrl ?? '',
    privacyUrl: s.privacyUrl ?? '',
    redirectUris: s.redirectUris.join('\n'),
    maxScope: s.maxScope,
    allowEmail: s.allowEmail,
    owner: s.owner ?? '',
    perMemberPerMin: count(s.perMemberPerMin),
    perAppPerMin: count(s.perAppPerMin),
    maxConnections: count(s.maxConnections),
  }
}

/** A number as typed: empty for none (the default), anything else as the number it reads as. */
const countOf = (text: string): number | null => (text.trim() === '' ? null : Number(text.trim()))

/** The settings the form says, as tela-api reads them: one redirect a line, blank lines dropped. */
export function settingsOf(draft: Draft): unknown {
  return {
    name: draft.name,
    developer: draft.developer,
    contactEmail: draft.contactEmail,
    homepageUrl: draft.homepageUrl,
    privacyUrl: draft.privacyUrl,
    redirectUris: draft.redirectUris
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
    maxScope: draft.maxScope,
    allowEmail: draft.allowEmail,
    owner: draft.owner,
    perMemberPerMin: countOf(draft.perMemberPerMin),
    perAppPerMin: countOf(draft.perAppPerMin),
    maxConnections: countOf(draft.maxConnections),
  }
}

export function AppForm({
  initial,
  editing,
  busy,
  onAnswer,
  onCancel,
}: {
  initial: AdminActArgs | undefined
  /** Editing an app that exists, rather than registering one. */
  editing: boolean
  busy: boolean
  onAnswer: (args: AdminActArgs) => void
  onCancel: () => void
}) {
  const t = useTranslations('admin.members')
  const id = useId()
  const [draft, setDraft] = useState<Draft>(() => draftOf(initial?.app))
  const ownerLocked = (initial?.app as AppFormStart | undefined)?.ownerLocked === true
  const [wrong, setWrong] = useState<AppField | null>(null)
  const form = useRef<HTMLFormElement>(null)
  useEffect(() => {
    form.current?.querySelector<HTMLElement>('input, textarea')?.focus()
  }, [])

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((now) => ({ ...now, [key]: value }))
    if (wrong === key) setWrong(null)
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    const parsed = parseAppSettings(settingsOf(draft))
    if (!parsed.ok) {
      setWrong(parsed.field)
      form.current?.querySelector<HTMLElement>(`[data-field="${parsed.field}"]`)?.focus()
      return
    }
    const app: AdminAppSettings = parsed.value
    onAnswer({ app })
  }

  const text = (
    field: Exclude<AppField, 'maxScope' | 'allowEmail'>,
    options: {
      type?: string
      max?: number
      hint?: string
      mono?: boolean
      readOnly?: boolean
    } = {},
  ) => (
    <div className="flex flex-col gap-1">
      <label htmlFor={`${id}-${field}`} className={LABEL}>
        {t(`apps.form.${field}`)}
      </label>
      <input
        id={`${id}-${field}`}
        type={options.type ?? 'text'}
        inputMode={options.type === 'number' ? 'numeric' : undefined}
        min={options.type === 'number' ? 0 : undefined}
        step={options.type === 'number' ? 1 : undefined}
        autoComplete="off"
        spellCheck={false}
        maxLength={options.max}
        readOnly={options.readOnly}
        value={draft[field]}
        onChange={(e) => set(field, e.target.value)}
        aria-invalid={wrong === field}
        aria-describedby={options.hint ? `${id}-${field}-hint` : undefined}
        className={`${FIELD} ${options.mono ? 'font-mono' : ''} ${options.readOnly ? 'text-muted' : ''}`}
        data-field={field}
        data-testid={`app-form-${field}`}
      />
      {options.hint ? (
        <p id={`${id}-${field}-hint`} className={HINT}>
          {options.hint}
        </p>
      ) : null}
    </div>
  )

  return (
    <form
      ref={form}
      className="flex flex-col gap-3"
      data-testid="admin-input"
      data-kind="app"
      noValidate
      onSubmit={submit}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        onCancel()
      }}
    >
      <div className="-mx-1 flex max-h-[min(56dvh,560px)] flex-col gap-3 overflow-y-auto px-1 pb-1">
        {text('name', { max: APP_NAME_MAX })}
        {text('developer', { max: APP_TEXT_MAX })}
        {text('contactEmail', {
          type: 'email',
          max: APP_TEXT_MAX,
          hint: t('apps.form.contactHint'),
        })}
        {text('homepageUrl', { type: 'url', max: APP_URL_MAX })}
        {text('privacyUrl', { type: 'url', max: APP_URL_MAX, hint: t('apps.form.urlHint') })}
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-redirectUris`} className={LABEL}>
            {t('apps.form.redirectUris')}
          </label>
          <textarea
            id={`${id}-redirectUris`}
            rows={3}
            spellCheck={false}
            value={draft.redirectUris}
            onChange={(e) => set('redirectUris', e.target.value)}
            aria-invalid={wrong === 'redirectUris'}
            aria-describedby={`${id}-redirectUris-hint`}
            className={`${FIELD} resize-y font-mono text-[13px]`}
            data-field="redirectUris"
            data-testid="app-form-redirectUris"
          />
          <p id={`${id}-redirectUris-hint`} className={HINT}>
            {t('apps.form.redirectHint', { n: APP_REDIRECTS_MAX })}
          </p>
        </div>
        <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
          <legend className={`${LABEL} mb-1 p-0`}>{t('apps.form.maxScope')}</legend>
          {(['read', 'write'] as const).map((scope) => (
            <label key={scope} className="flex items-center gap-2 text-[14px] text-ink">
              <input
                type="radio"
                name={`${id}-scope`}
                checked={draft.maxScope === scope}
                onChange={() => set('maxScope', scope)}
                data-field={scope === 'read' ? 'maxScope' : undefined}
                data-testid={`app-form-scope-${scope}`}
              />
              {t(`apps.scope.${scope}`)}
            </label>
          ))}
        </fieldset>
        <label className="flex items-start gap-2 text-[14px] text-ink">
          <input
            type="checkbox"
            className="mt-[3px]"
            checked={draft.allowEmail}
            onChange={(e) => set('allowEmail', e.target.checked)}
            data-field="allowEmail"
            data-testid="app-form-allowEmail"
          />
          {t('apps.form.allowEmail')}
        </label>
        {text('owner', {
          max: 31,
          hint: ownerLocked ? t('apps.form.ownerLocked') : t('apps.form.ownerHint'),
          readOnly: ownerLocked,
        })}
        {text('perMemberPerMin', {
          type: 'number',
          hint: t('apps.form.limitHint', { n: APP_DEFAULT_PER_MEMBER_PER_MIN }),
        })}
        {text('perAppPerMin', {
          type: 'number',
          hint: t('apps.form.limitHint', { n: APP_DEFAULT_PER_APP_PER_MIN }),
        })}
        {text('maxConnections', { type: 'number', hint: t('apps.form.connectionsHint') })}
      </div>
      {wrong ? (
        <p role="alert" className="m-0 text-[13px] text-danger" data-testid="app-form-error">
          {t(`apps.form.errors.${wrong}`, {
            name: APP_NAME_MAX,
            text: APP_TEXT_MAX,
            n: APP_REDIRECTS_MAX,
          })}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <ActionButton type="submit" look="primary" disabled={busy} data-testid="admin-input-submit">
          {editing ? t('apps.form.save') : t('apps.form.register')}
        </ActionButton>
        <ActionButton look="ghost" onClick={onCancel}>
          {t('apps.form.cancel')}
        </ActionButton>
      </div>
    </form>
  )
}

/**
 * Reviewing an app (ADR 0067): what a review lifts, and whether the app may ask for the email
 * address from now on, which the operator answers each time, whatever the developer asked for. It
 * starts from what the app may do now, or what its developer asked.
 */
export function ReviewForm({
  initial,
  busy,
  onAnswer,
  onCancel,
}: {
  initial: AdminActArgs | undefined
  busy: boolean
  onAnswer: (args: AdminActArgs) => void
  onCancel: () => void
}) {
  const t = useTranslations('admin.members')
  const [allowEmail, setAllowEmail] = useState(initial?.allowEmail === true)
  const submit = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    submit.current?.focus()
  }, [])
  return (
    <form
      className="flex flex-col gap-3"
      data-testid="admin-input"
      data-kind="review"
      onSubmit={(e) => {
        e.preventDefault()
        if (!busy) onAnswer({ allowEmail })
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        onCancel()
      }}
    >
      <p className="m-0 text-[13.5px] leading-normal text-ink-2">{t('apps.review.body')}</p>
      <label className="flex items-start gap-2 text-[14px] text-ink">
        <input
          type="checkbox"
          className="mt-[3px]"
          checked={allowEmail}
          onChange={(e) => setAllowEmail(e.target.checked)}
          data-testid="app-review-email"
        />
        {t('apps.review.email')}
      </label>
      <div className="flex flex-wrap gap-2">
        <ActionButton
          ref={submit}
          type="submit"
          look="primary"
          disabled={busy}
          data-testid="admin-input-submit"
        >
          {t('apps.review.submit')}
        </ActionButton>
        <ActionButton look="ghost" onClick={onCancel}>
          {t('apps.form.cancel')}
        </ActionButton>
      </div>
    </form>
  )
}
