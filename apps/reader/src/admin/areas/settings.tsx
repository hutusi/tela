/**
 * The Settings area (ADR 0056): every runtime setting, what holds now, its default and when it was
 * changed, edited in the record and sent as `setting.set`, whose toast offers the undo. tela-api
 * answers the nine settings whole (`GET /api/v1/admin/settings`), so the filters and the search
 * are applied here, the search against each setting's name in the operator's language as well as
 * its key. A value is checked with `parseSetting`, the rule tela-api and the CLI apply, before it
 * is sent: a value the rule refuses is said here, in words, and nothing goes.
 */
import {
  parseSetting,
  SETTINGS,
  type SettingKey,
  type SettingValue,
  settingDefault,
} from '@tela/shared'
import type {
  AdminFilter,
  AdminList,
  AdminRowBase,
  AdminSettingRow,
  AdminSettings,
} from '@tela/shared/admin'
import { type FormEvent, useId, useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'use-intl'
import { Swatch } from '../../components/swatch'
import type { Translate } from '../act'
import { adminGet } from '../api'
import type { AnyAreaSpec, AreaSpec, RecordProps, Status } from '../area'
import { ActionButton } from '../components/buttons'
import { KeyValues, Note, Section, useWhen } from '../components/record'
import { TILE } from './system'

/** A setting as a ledger row: its key is its id. Nothing is acted on from the row itself. */
export type SettingLedgerRow = AdminSettingRow & AdminRowBase

/** A setting's group, its key's first part, for the tile's colour. */
const GROUPS = ['signup', 'member', 'translation', 'alerts']
const groupOf = (key: string) => Math.max(0, GROUPS.indexOf(key.split('.')[0] ?? '')) + 1

/** Two values are one when their JSON is: a list of percentages is compared by its numbers. */
export const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * The ledger's answer, made from tela-api's: the rows a filter holds that the search matches
 * (the key, or the name `nameOf` gives it), and each filter's size.
 */
export function settingList(
  settings: readonly AdminSettingRow[],
  filter: AdminFilter<'settings'>,
  q: string,
  nameOf: (key: SettingKey) => string,
): AdminList<SettingLedgerRow, 'settings'> {
  const rows = settings.map((s): SettingLedgerRow => ({ ...s, id: s.key, actions: [] }))
  const needle = q.trim().toLowerCase()
  const matches = (row: SettingLedgerRow) =>
    !needle ||
    row.key.toLowerCase().includes(needle) ||
    nameOf(row.key).toLowerCase().includes(needle)
  return {
    counts: { all: rows.length, changed: rows.filter((r) => r.stored).length },
    rows: rows.filter((r) => (filter === 'all' || r.stored) && matches(r)),
    truncated: false,
  }
}

/** Where a key's words live in `admin.running`: nested by the key's parts (use-intl reads dots). */
const words = (key: SettingKey, part: string) => `settings.keys.${key}.${part}`

/** A setting's value in words: "Invitation only", "20 a day", "10M tokens a day", "80%, 100%". */
export function settingWords(
  t: Translate,
  key: SettingKey,
  value: unknown,
  locale: string,
): string {
  const spec = SETTINGS[key]
  if (spec.kind === 'choice') {
    return typeof value === 'string' ? t(words(key, `choices.${value}`)) : String(value)
  }
  if (spec.kind === 'percents') {
    const list = Array.isArray(value) ? value : []
    if (list.length === 0) return t(words(key, 'none'))
    const percent = new Intl.NumberFormat(locale, { style: 'percent' })
    return list.map((p) => percent.format(Number(p) / 100)).join(t('settings.separator'))
  }
  if (value === null) return t(words(key, 'none'))
  const n = Number(value)
  const tokens = new Intl.NumberFormat(locale, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(n)
  return t(words(key, 'value'), { n, tokens })
}

/** What the editor holds while the operator types: a choice, a limit (or none), or a list. */
export type Draft =
  | { kind: 'choice'; value: string }
  | { kind: 'limit'; unlimited: boolean; text: string }
  | { kind: 'percents'; text: string }

/** The editor's start: the value that holds now, as the operator would type it. */
export function draftOf(key: SettingKey, value: unknown): Draft {
  const spec = SETTINGS[key]
  if (spec.kind === 'choice') return { kind: 'choice', value: String(value) }
  if (spec.kind === 'percents') {
    return { kind: 'percents', text: Array.isArray(value) ? value.join(', ') : '' }
  }
  return { kind: 'limit', unlimited: value === null, text: value === null ? '' : String(value) }
}

/** A whole number as typed, thousands separators and a percent sign aside; NaN for anything else. */
const wholeNumber = (text: string) => {
  const bare = text.replace(/[\s,_'%]/g, '')
  return /^\d+$/.test(bare) ? Number(bare) : Number.NaN
}

export type DraftError = 'number' | 'percents' | 'choice'

/**
 * The value a draft says, checked by the key's own rule (`parseSetting`), or which of the
 * console's words to say instead: the rule's own message is for the CLI, in English.
 */
export function checkDraft<K extends SettingKey>(
  key: K,
  draft: Draft,
): { ok: true; value: SettingValue<K> } | { ok: false; error: DraftError } {
  let raw: unknown
  if (draft.kind === 'choice') raw = draft.value
  else if (draft.kind === 'limit') raw = draft.unlimited ? null : wholeNumber(draft.text)
  else
    raw = draft.text
      .split(/[\s,，、;]+/)
      .filter(Boolean)
      .map(wholeNumber)
  const parsed = parseSetting(key, raw)
  if (parsed.ok) return parsed
  return { ok: false, error: draft.kind === 'limit' ? 'number' : draft.kind }
}

const FIELD =
  'w-full min-w-0 rounded-lg border border-line bg-field px-3 py-2 text-[14px] text-ink outline-none focus:border-muted'

/** The record's form: the value, a Save, and a way back to the default. */
function SettingEditor({
  row,
  act,
  busy,
}: Pick<RecordProps<SettingLedgerRow, null>, 'row' | 'act' | 'busy'>) {
  const t = useTranslations('admin.running')
  const locale = useLocale()
  const id = useId()
  const key = row.key
  const spec = SETTINGS[key]
  const [draft, setDraft] = useState<Draft>(() => draftOf(key, row.value))
  const [error, setError] = useState<string | null>(null)
  const number = new Intl.NumberFormat(locale)

  const send = (value: unknown) => {
    if (sameValue(value, row.value)) {
      setError(t('settings.unchanged'))
      return
    }
    setError(null)
    act('setting.set', [row.id], { value })
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    const checked = checkDraft(key, draft)
    if (!checked.ok) {
      setError(
        checked.error === 'number' && spec.kind === 'limit'
          ? t('settings.errors.number', { max: number.format(spec.max) })
          : t(`settings.errors.${checked.error}`),
      )
      return
    }
    send(checked.value)
  }
  const edit = (next: Draft) => {
    setDraft(next)
    setError(null)
  }

  const label = 'text-[12.5px] font-medium text-muted'
  return (
    <Section label={t('settings.change')}>
      <form className="flex flex-col gap-2.5" onSubmit={submit} data-testid="admin-setting-form">
        {draft.kind === 'choice' && spec.kind === 'choice' ? (
          <select
            aria-label={t(words(key, 'name'))}
            value={draft.value}
            onChange={(e) => edit({ kind: 'choice', value: e.target.value })}
            className={FIELD}
            data-testid="admin-setting-choice"
          >
            {spec.choices.map((choice) => (
              <option key={choice} value={choice}>
                {t(words(key, `choices.${choice}`))}
              </option>
            ))}
          </select>
        ) : null}
        {draft.kind === 'limit' ? (
          <>
            <label className="flex cursor-pointer items-center gap-2 text-[13.5px] text-ink">
              <input
                type="checkbox"
                checked={draft.unlimited}
                onChange={(e) => edit({ ...draft, unlimited: e.target.checked })}
                className="size-4 accent-ink"
                data-testid="admin-setting-unlimited"
              />
              {t(words(key, 'none'))}
            </label>
            {draft.unlimited ? null : (
              <>
                <label htmlFor={`${id}-n`} className={label}>
                  {t('settings.number')}
                </label>
                <input
                  id={`${id}-n`}
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  spellCheck={false}
                  value={draft.text}
                  aria-invalid={error !== null}
                  aria-describedby={error !== null ? `${id}-error` : undefined}
                  onChange={(e) => edit({ ...draft, text: e.target.value })}
                  className={`${FIELD} tabular-nums`}
                  data-testid="admin-setting-number"
                />
              </>
            )}
          </>
        ) : null}
        {draft.kind === 'percents' ? (
          <>
            <label htmlFor={`${id}-p`} className={label}>
              {t('settings.percents')}
            </label>
            <input
              id={`${id}-p`}
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={draft.text}
              aria-invalid={error !== null}
              aria-describedby={error !== null ? `${id}-error` : undefined}
              onChange={(e) => edit({ kind: 'percents', text: e.target.value })}
              className={`${FIELD} tabular-nums`}
              data-testid="admin-setting-percents"
            />
          </>
        ) : null}
        {error !== null ? (
          <p
            id={`${id}-error`}
            role="alert"
            className="m-0 text-[12.5px] text-ink-2"
            data-testid="admin-setting-error"
          >
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <ActionButton
            type="submit"
            look="primary"
            disabled={busy}
            data-testid="admin-setting-save"
          >
            {t('settings.save')}
          </ActionButton>
          {sameValue(row.value, row.default) ? null : (
            <ActionButton
              look="ghost"
              disabled={busy}
              onClick={() => send(settingDefault(key))}
              data-testid="admin-setting-default"
            >
              {t('settings.useDefault')}
            </ActionButton>
          )}
        </div>
      </form>
    </Section>
  )
}

function SettingRecord({ row, act, busy }: RecordProps<SettingLedgerRow, null>) {
  const t = useTranslations('admin.running')
  const locale = useLocale()
  const when = useWhen()
  return (
    <div className="flex flex-col gap-5">
      <p className="m-0 text-[13.5px] leading-relaxed text-ink-2">{t(words(row.key, 'about'))}</p>
      <KeyValues
        rows={[
          [t('settings.kv.now'), settingWords(t, row.key, row.value, locale)],
          [t('settings.kv.default'), settingWords(t, row.key, row.default, locale)],
          [
            t('settings.kv.changed'),
            row.stored && row.updatedAt !== null ? when(row.updatedAt) : t('settings.never'),
          ],
        ]}
      />
      {/* Keyed by the value: once a change lands, the form starts again from what holds now. */}
      <SettingEditor key={JSON.stringify(row.value)} row={row} act={act} busy={busy} />
      <Note>{t('settings.note')}</Note>
    </div>
  )
}

export function useSettingsArea(): AnyAreaSpec {
  const t = useTranslations('admin.running')
  const locale = useLocale()
  return useMemo(() => {
    const tr = t as unknown as Translate
    const name = (key: SettingKey) => tr(words(key, 'name'))
    const when = (at: number | null) =>
      at === null
        ? '—'
        : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(at)
    const status = (row: SettingLedgerRow): Status =>
      row.stored
        ? { tone: 'info', label: tr('settings.status.changed') }
        : { tone: 'neutral', label: tr('settings.status.default') }
    const spec: AreaSpec<'settings', SettingLedgerRow, null> = {
      area: 'settings',
      filterLabel: (filter) => tr(`filters.settings.${filter}`),
      searchHint: tr('settings.search'),
      load: async (filter, q, signal) => {
        const answer = await adminGet<AdminSettings>('settings', signal)
        return answer ? settingList(answer.settings, filter, q, name) : null
      },
      loadDetail: null,
      name: {
        label: tr('settings.name'),
        title: (row) => name(row.key),
        sub: (row) => row.key,
        tile: (row) => <Swatch id={groupOf(row.key)} title={name(row.key)} size={TILE} />,
      },
      columns: [
        {
          label: tr('settings.columns.now'),
          text: (row) => settingWords(tr, row.key, row.value, locale),
        },
        {
          label: tr('settings.columns.default'),
          text: (row) => settingWords(tr, row.key, row.default, locale),
        },
        {
          label: tr('settings.columns.changed'),
          text: (row) => (row.stored ? when(row.updatedAt) : '—'),
          number: (row) => (row.stored ? row.updatedAt : null),
        },
      ],
      status,
      Record: SettingRecord,
      bulk: [],
    }
    return spec
  }, [t, locale])
}
