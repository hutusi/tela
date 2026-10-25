/**
 * The console's Settings area (ADR 0056): every setting named and its value said in words in each
 * of the console's languages, the editor's drafts checked by the rule tela-api applies, the
 * filters and search made here from tela-api's whole answer, and the area drawn from a fixture.
 */
import { describe, expect, test } from 'bun:test'
import { SETTING_KEYS, SETTINGS, type SettingKey, settingDefault } from '@tela/shared'
import { ADMIN_FILTERS, type AdminSettingRow } from '@tela/shared/admin'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { createTranslator } from 'use-intl'
import type { Translate } from '../src/admin/act'
import {
  checkDraft,
  draftOf,
  settingList,
  settingWords,
  useSettingsArea,
} from '../src/admin/areas/settings'
import { AdminContext } from '../src/admin/context'
import { ADMIN_MESSAGES, AdminI18n } from '../src/admin/i18n'
import { Ledger } from '../src/admin/ledger/ledger'
import { UiContext } from '../src/ui'
import { QUIET_ADMIN } from './admin-fixtures'

const LANGS = ['en', 'zh-Hans', 'zh-Hant'] as const

const translator = (locale: (typeof LANGS)[number], namespace: string): Translate =>
  createTranslator({
    locale,
    messages: { admin: ADMIN_MESSAGES[locale] },
    namespace,
  } as never) as unknown as Translate

/** A message use-intl found: one it did not comes back as its own key, namespace and all. */
const found = (
  t: Translate,
  namespace: string,
  key: string,
  values?: Record<string, string | number>,
) => {
  const text = t(key, values)
  return { key, found: text !== `${namespace}.${key}` && text !== key }
}

describe('the words', () => {
  test.each([...LANGS])(
    '%s names every setting, says what it does and words its values',
    (lang) => {
      const t = translator(lang, 'admin.running')
      const shell = translator(lang, 'admin.shell')
      expect(found(shell, 'admin.shell', 'nav.settings').found).toBe(true)
      expect(found(shell, 'admin.shell', 'about.settings').found).toBe(true)
      for (const filter of ADMIN_FILTERS.settings) {
        const key = `filters.settings.${filter}`
        expect(found(t, 'admin.running', key)).toEqual({ key, found: true })
      }
      for (const key of SETTING_KEYS) {
        const spec = SETTINGS[key]
        const parts = ['name', 'about']
        if (spec.kind === 'choice') parts.push(...spec.choices.map((c) => `choices.${c}`))
        else parts.push('none')
        if (spec.kind === 'limit') parts.push('value')
        for (const part of parts) {
          const path = `settings.keys.${key}.${part}`
          expect(found(t, 'admin.running', path, { n: 3, tokens: '3' })).toEqual({
            key: path,
            found: true,
          })
        }
      }
    },
  )

  const en = translator('en', 'admin.running')
  const hans = translator('zh-Hans', 'admin.running')
  const say = (key: SettingKey, value: unknown, t = en, locale = 'en') =>
    settingWords(t, key, value, locale)

  test('a value reads as what it does, null and 0 each in their own words', () => {
    expect(say('signup.mode', 'invite')).toBe('Invitation only')
    expect(say('signup.mode', 'open')).toBe('Open')
    expect(say('member.feedsPerDay', 20)).toBe('20 a day')
    expect(say('member.feedsPerDay', null)).toBe('No limit')
    expect(say('member.feedsPerDay', 0)).toBe('None')
    expect(say('member.maxSubscriptions', 300)).toBe('300 blogs')
    expect(say('member.maxSubscriptions', 1)).toBe('1 blog')
    expect(say('signup.maxPerDay', 0)).toBe('None: joining is paused')
    expect(say('alerts.signupsPerDay', 50)).toBe('More than 50 in a day')
    expect(say('alerts.signupsPerDay', null)).toBe('Never')
    expect(say('translation.siteDailyTokens', 10_000_000)).toBe('10M tokens a day')
    expect(say('translation.siteDailyTokens', 0)).toBe('None: translation waits')
    // Unset, the title budget is not unlimited: tela-jobs' var decides.
    expect(say('translation.backgroundDailyTokens', null)).toBe(
      "As tela-jobs' LLM_DAILY_BUDGET_TOKENS says",
    )
    expect(say('alerts.budgetPercents', [80, 100])).toBe('80%, 100%')
    expect(say('alerts.budgetPercents', [])).toBe('Never')
  })

  test('reads in Simplified Chinese', () => {
    expect(say('member.feedsPerDay', 20, hans, 'zh-Hans')).toBe('每天 20 个')
    expect(say('signup.mode', 'invite', hans, 'zh-Hans')).toBe('仅限邀请')
    expect(say('alerts.budgetPercents', [80, 100], hans, 'zh-Hans')).toBe('80%、100%')
    expect(say('translation.siteDailyTokens', 10_000_000, hans, 'zh-Hans')).toBe(
      '每天 1000万 token',
    )
  })
})

describe('a draft', () => {
  test('starts from what holds now, as an operator would type it', () => {
    expect(draftOf('signup.mode', 'open')).toEqual({ kind: 'choice', value: 'open' })
    expect(draftOf('member.feedsPerDay', 20)).toEqual({
      kind: 'limit',
      unlimited: false,
      text: '20',
    })
    expect(draftOf('member.feedsPerDay', null)).toEqual({
      kind: 'limit',
      unlimited: true,
      text: '',
    })
    expect(draftOf('alerts.budgetPercents', [80, 100])).toEqual({
      kind: 'percents',
      text: '80, 100',
    })
  })

  test('is checked by the rule tela-api applies, and says which words to show when it fails', () => {
    const limit = (text: string, unlimited = false) =>
      checkDraft('translation.siteDailyTokens', { kind: 'limit', unlimited, text })
    expect(limit('10,000,000')).toEqual({ ok: true, value: 10_000_000 })
    expect(limit(' 2 000 ')).toEqual({ ok: true, value: 2000 })
    expect(limit('0')).toEqual({ ok: true, value: 0 })
    expect(limit('', true)).toEqual({ ok: true, value: null })
    for (const bad of ['', '-3', '1.5', 'ten', '99999999999']) {
      expect(limit(bad)).toEqual({ ok: false, error: 'number' })
    }
    const percents = (text: string) =>
      checkDraft('alerts.budgetPercents', { kind: 'percents', text })
    expect(percents('100, 80')).toEqual({ ok: true, value: [80, 100] })
    expect(percents('50% 90%')).toEqual({ ok: true, value: [50, 90] })
    expect(percents('80，100')).toEqual({ ok: true, value: [80, 100] })
    expect(percents('')).toEqual({ ok: true, value: [] })
    for (const bad of ['0', '120', 'half']) {
      expect(percents(bad)).toEqual({ ok: false, error: 'percents' })
    }
    expect(checkDraft('signup.mode', { kind: 'choice', value: 'open' })).toEqual({
      ok: true,
      value: 'open',
    })
    expect(checkDraft('signup.mode', { kind: 'choice', value: 'closed' })).toEqual({
      ok: false,
      error: 'choice',
    })
  })
})

const ROWS: AdminSettingRow[] = SETTING_KEYS.map((key) => ({
  key,
  value: key === 'member.feedsPerDay' ? 30 : settingDefault(key),
  default: settingDefault(key),
  stored: key === 'member.feedsPerDay',
  updatedAt: key === 'member.feedsPerDay' ? 1_761_350_400_000 : null,
}))

describe('the list', () => {
  const name = (key: SettingKey) => (key === 'member.feedsPerDay' ? 'New feeds per member' : key)

  test('holds every setting, or those a stored row overrides, each with no action of its own', () => {
    const all = settingList(ROWS, 'all', '', name)
    expect(all.counts).toEqual({ all: SETTING_KEYS.length, changed: 1 })
    expect(all.rows.map((r) => r.id)).toEqual(SETTING_KEYS)
    expect(all.rows.every((r) => r.actions.length === 0)).toBe(true)
    expect(settingList(ROWS, 'changed', '', name).rows.map((r) => r.id)).toEqual([
      'member.feedsPerDay',
    ])
  })

  test('is searched by key and by the name the operator reads', () => {
    expect(settingList(ROWS, 'all', 'alerts.', name).rows.map((r) => r.id)).toEqual([
      'alerts.signupsPerDay',
      'alerts.budgetPercents',
    ])
    expect(settingList(ROWS, 'all', 'new FEEDS', name).rows.map((r) => r.id)).toEqual([
      'member.feedsPerDay',
    ])
    // The counts are the filters' sizes, whatever the search.
    expect(settingList(ROWS, 'all', 'nothing like it', name).counts.all).toBe(SETTING_KEYS.length)
  })
})

describe('the area', () => {
  function render(path: string, locale: 'en' | 'zh-Hans' = 'en') {
    function Settings() {
      const name = (key: SettingKey) => key
      return (
        <Ledger
          area="settings"
          spec={useSettingsArea()}
          initial={settingList(ROWS, 'all', '', name)}
        />
      )
    }
    return renderToString(
      <UiContext.Provider value={{ locale, setLocale() {} }}>
        <AdminI18n>
          <MemoryRouter initialEntries={[path]}>
            <AdminContext.Provider value={QUIET_ADMIN}>
              <Settings />
            </AdminContext.Provider>
          </MemoryRouter>
        </AdminI18n>
      </UiContext.Provider>,
    )
  }

  test('lists each setting by name with what holds now, its default and when it changed', () => {
    const html = render('/admin/settings')
    expect(html).toContain('Running')
    expect(html).toContain('What you can change while Tela runs')
    expect(html).toMatch(/aria-pressed="true"[^>]*data-filter="all"/)
    expect(html.match(/data-testid="admin-row"/g)).toHaveLength(SETTING_KEYS.length)
    for (const text of ['Who may join', 'Invitation only', '30 a day', '20 a day', 'Changed']) {
      expect(html).toContain(text)
    }
    // Nothing to check, and no row action: a setting is changed in its record.
    expect(html).not.toContain('type="checkbox"')
    expect(html).not.toContain('data-testid="admin-row-action"')
  })

  test('a record edits the value inline: a number and its No limit, then Save', () => {
    const html = render('/admin/settings?id=member.feedsPerDay')
    expect(html).toContain('data-testid="admin-record"')
    expect(html).toContain('New feeds per member')
    expect(html).toContain('Feeds new to Tela a member adds')
    expect(html).toContain('data-testid="admin-setting-form"')
    expect(html).toMatch(/data-testid="admin-setting-number"/)
    expect(html).toMatch(/value="30"/)
    expect(html).toContain('No limit')
    expect(html).toContain('data-testid="admin-setting-save"')
    // Changed from the default: the way back is offered.
    expect(html).toContain('Use the default')
  })

  test('the sign-up mode is a choice; a percent list is typed', () => {
    const mode = render('/admin/settings?id=signup.mode')
    expect(mode).toContain('data-testid="admin-setting-choice"')
    expect(mode).toContain('>Open</option>')
    expect(mode).not.toContain('Use the default')
    const alerts = render('/admin/settings?id=alerts.budgetPercents')
    expect(alerts).toMatch(/data-testid="admin-setting-percents"/)
    expect(alerts).toMatch(/value="80, 100"/)
  })

  test('reads in Simplified Chinese', () => {
    const html = render('/admin/settings?id=signup.mode', 'zh-Hans')
    for (const text of ['设置', '谁可以加入', '仅限邀请', '保存']) expect(html).toContain(text)
  })
})
