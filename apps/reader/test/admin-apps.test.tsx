/**
 * The console's Apps area (ADRs 0039, 0064, 0067), drawn on the server from fixtures: the ledger,
 * its record, the form that registers and edits an app, the review queue and its form, and a
 * report of an app in Reports; and their words in every catalogue.
 */
import { describe, expect, test } from 'bun:test'
import { APP_STATUSES, type UiLocale } from '@tela/shared'
import {
  ADMIN_FILTERS,
  type AdminAppRow,
  type AdminAppSettings,
  type AdminList,
  type AdminReportRow,
  parseAppSettings,
} from '@tela/shared/admin'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { createTranslator } from 'use-intl'
import { actionLook, promptFor, type Translate } from '../src/admin/act'
import { settingsOfRow, useAppsArea } from '../src/admin/areas/apps'
import { useReportsArea } from '../src/admin/areas/reports'
import { draftOf, settingsOf } from '../src/admin/components/app-form'
import { ActionPrompt } from '../src/admin/components/prompt'
import { AdminContext } from '../src/admin/context'
import { ADMIN_MESSAGES, AdminI18n } from '../src/admin/i18n'
import { Ledger } from '../src/admin/ledger/ledger'
import { UiContext } from '../src/ui'
import { QUIET_ADMIN } from './admin-fixtures'

function render(node: React.ReactNode, path: string, locale: UiLocale = 'en'): string {
  return renderToString(
    <UiContext.Provider value={{ locale, setLocale() {} }}>
      <AdminI18n>
        <MemoryRouter initialEntries={[path]}>
          <AdminContext.Provider value={QUIET_ADMIN}>{node}</AdminContext.Provider>
        </MemoryRouter>
      </AdminI18n>
    </UiContext.Provider>,
  )
}

/** The opening tag of the element with this test id. */
const tag = (html: string, testId: string) =>
  html.match(new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? ''

const DAY = 86_400_000
const now = Date.now()

const loom: AdminAppRow = {
  id: '3',
  actions: ['app.edit', 'app.suspend', 'app.endConnections'],
  appId: 3,
  clientId: 'tela_app_Q2xpZW50SWQ',
  name: 'Loom',
  developer: 'Loom Labs',
  contactEmail: 'dev@loom.example',
  homepageUrl: 'https://loom.example',
  privacyUrl: 'https://loom.example/privacy',
  redirectUris: ['http://127.0.0.1/callback', 'com.loom.desktop:/oauth'],
  maxScope: 'write',
  allowEmail: true,
  status: 'approved',
  owner: { id: 'u-mara', handle: 'mara', name: 'Mara' },
  perMemberPerMin: null,
  perAppPerMin: 0,
  maxConnections: null,
  createdAt: now - 30 * DAY,
  approvedAt: now - 20 * DAY,
  suspendedAt: null,
  connections: 12,
  lastUsedAt: now - 2 * 3_600_000,
  registeredBy: null,
  termsAt: null,
  reviewedAt: now - 20 * DAY,
  reviewedBy: { id: 'u-ops', handle: 'ops', name: null },
  reviewRequestedAt: null,
  reviewNote: null,
  reviewWantsEmail: false,
}

const weft: AdminAppRow = {
  ...loom,
  id: '4',
  appId: 4,
  clientId: 'tela_app_V2VmdA',
  name: 'Weft CLI',
  developer: 'Weft Co',
  actions: ['app.edit', 'app.suspend'],
  connections: 0,
  lastUsedAt: null,
}

/** Mara's own app, registered in Settings → Developer, live, and asking for a review. */
const quill: AdminAppRow = {
  ...loom,
  id: '5',
  appId: 5,
  clientId: 'tela_app_UXVpbGw',
  name: 'Quill',
  developer: 'Mara Makes',
  actions: ['app.review', 'app.dismissReview', 'app.edit', 'app.suspend'],
  allowEmail: false,
  registeredBy: { id: 'u-mara', handle: 'mara', name: 'Mara' },
  termsAt: now - 3 * DAY,
  reviewedAt: null,
  reviewedBy: null,
  reviewRequestedAt: now - DAY,
  reviewNote: 'A quiet reader for the desktop.',
  reviewWantsEmail: true,
}

const LIST: AdminList<AdminAppRow, 'apps'> = {
  counts: { review: 1, approved: 2, draft: 1, suspended: 0 },
  rows: [loom, weft],
  truncated: false,
}

const QUEUE: AdminList<AdminAppRow, 'apps'> = { ...LIST, rows: [quill] }

function Apps({ list = LIST }: { list?: AdminList<AdminAppRow, 'apps'> }) {
  return <Ledger area="apps" spec={useAppsArea()} initial={list} />
}

describe('the Apps ledger', () => {
  test('lists each app with its developer, who is connected, and when it was last used', () => {
    const html = render(<Apps />, '/admin/apps')
    expect(html).toContain('Members')
    // It opens on the review queue (ADR 0067).
    expect(html).toMatch(/aria-pressed="true"[^>]*data-filter="review"/)
    for (const label of ['To review', 'Approved', 'Drafts', 'Cut off'])
      expect(html).toContain(label)
    expect(html).toContain('Search by name, developer, client ID or address')
    for (const text of ['Loom', 'Loom Labs', '12 members', 'Weft CLI', 'Nobody', 'Never']) {
      expect(html).toContain(text)
    }
    // Registering is offered beside the search; nothing is acted on in bulk.
    expect(html).toContain('data-action="app.create"')
    expect(html).toContain('>Register app<')
  })

  test('a record shows its client id under its name, and Cut off as a danger', () => {
    const html = render(<Apps />, '/admin/apps?id=3')
    expect(html).toContain('data-testid="admin-record"')
    expect(html).toContain('tela_app_Q2xpZW50SWQ')
    expect(html).toContain('data-action="app.edit"')
    expect(html).toMatch(
      /text-danger[^"]*"[^>]*data-testid="admin-record-action" data-action="app.suspend"/,
    )
    expect(html).toContain('>End all connections<')
    // Its settings, before the detail arrives: what the row carries.
    expect(html).toContain('com.loom.desktop:/oauth')
    expect(html).toContain('Read and write')
    expect(html).toMatch(/@(<!-- -->)?mara/)
    expect(html).toContain('120 a minute (the default)')
    expect(html).toContain('None')
    expect(html).toContain('never who they are')
    // The operator's own, reviewed.
    expect(html).toContain('The operator')
    expect(html).toMatch(/by @(<!-- -->)?ops/)
    expect(html).not.toContain('data-testid="admin-app-request"')
  })

  test('an app in the queue shows who registered it and what they asked', () => {
    const html = render(<Apps list={QUEUE} />, '/admin/apps?id=5')
    expect(html).toContain('data-testid="admin-app-request"')
    expect(html).toContain('A quiet reader for the desktop.')
    expect(html).toContain('Asks to see members’ email addresses')
    expect(html).toContain('Not reviewed')
    expect(html).toContain('Rules accepted')
    expect(html).toMatch(/@(<!-- -->)?mara/)
    // Review first, as the likeliest answer; its request can be dismissed instead.
    expect(html).toMatch(/data-testid="admin-record-action" data-action="app.review"/)
    expect(html).toContain('>Dismiss the request<')
  })
})

describe('a review', () => {
  test('asks whether the app may see email addresses, starting from what it asked', () => {
    expect(promptFor('app.review')).toEqual({ input: 'review' })
    expect(promptFor('app.dismissReview')).toBeNull()
    const html = render(
      <ActionPrompt
        prompt={{
          action: 'app.review',
          ids: ['5'],
          where: 'record',
          initial: { allowEmail: true },
        }}
        busy={false}
        onAnswer={() => {}}
        onCancel={() => {}}
      />,
      '/admin/apps?id=5',
    )
    expect(html).toContain('data-kind="review"')
    expect(html).toContain('Let it ask to see members’ email addresses')
    expect(tag(html, 'app-review-email')).toContain('checked=""')
    expect(html).toContain('>Review<')
    const unchecked = render(
      <ActionPrompt
        prompt={{
          action: 'app.review',
          ids: ['5'],
          where: 'record',
          initial: { allowEmail: false },
        }}
        busy={false}
        onAnswer={() => {}}
        onCancel={() => {}}
      />,
      '/admin/apps?id=5',
    )
    expect(tag(unchecked, 'app-review-email')).not.toContain('checked=""')
  })
})

describe('a report of an app', () => {
  const REPORTED: AdminReportRow = {
    id: 'app:tela_app_UXVpbGw',
    actions: ['report.resolve', 'report.dismiss'],
    target: {
      kind: 'app',
      key: 'tela_app_UXVpbGw',
      label: 'Quill',
      path: null,
      member: { id: 'u-mara', handle: 'mara', name: 'Mara', standing: 'ok' },
      siteId: null,
      appId: 5,
      actions: [
        { action: 'app.suspend', id: '5' },
        { action: 'app.endConnections', id: '5' },
        { action: 'member.suspend', id: 'u-mara' },
        { action: 'member.delete', id: 'u-mara' },
      ],
    },
    state: 'open',
    reason: 'impersonation',
    reasons: ['impersonation'],
    details: null,
    reporters: 1,
    firstAt: now - DAY,
    lastAt: now - DAY,
    decidedAt: null,
    decidedBy: null,
  }

  function Reports() {
    return (
      <Ledger
        area="reports"
        spec={useReportsArea()}
        initial={{
          counts: { open: 1, resolved: 0, dismissed: 0 },
          rows: [REPORTED],
          truncated: false,
        }}
      />
    )
  }

  test('names it and its developer, opens its record, and acts on both', () => {
    const html = render(<Reports />, `/admin/reports?id=${encodeURIComponent(REPORTED.id)}`)
    expect(html).toContain('Quill')
    expect(html).toMatch(/App · @(<!-- -->)?mara/)
    expect(html).toContain('Developer')
    expect(html).toContain('data-testid="report-open-app"')
    // An app has no public page to link, and says nothing of one.
    expect(html).not.toContain('Not shown to anyone now')
    for (const action of ['app.suspend', 'app.endConnections', 'member.suspend']) {
      expect(html).toContain(`data-action="${action}"`)
    }
  })
})

describe('the app form', () => {
  test('registers an app from an empty form', () => {
    const html = render(
      <ActionPrompt
        prompt={{ action: 'app.create', ids: [], where: 'create' }}
        busy={false}
        onAnswer={() => {}}
        onCancel={() => {}}
      />,
      '/admin/apps',
    )
    expect(html).toContain('data-kind="app"')
    expect(html).toContain('Redirect URIs')
    expect(html).toContain('Never localhost.')
    expect(html).toContain('>Register<')
    expect(html).toContain('value=""')
  })

  test('edits from what the app holds', () => {
    const html = render(
      <ActionPrompt
        prompt={{
          action: 'app.edit',
          ids: ['3'],
          where: 'record',
          initial: { app: settingsOfRow(loom) },
        }}
        busy={false}
        onAnswer={() => {}}
        onCancel={() => {}}
      />,
      '/admin/apps?id=3',
    )
    expect(html).toContain('value="Loom"')
    expect(html).toContain('value="dev@loom.example"')
    expect(html).toContain('http://127.0.0.1/callback\ncom.loom.desktop:/oauth')
    expect(html).toContain('value="mara"')
    expect(html).toContain('value="0"')
    expect(html).toContain('>Save<')
    expect(tag(html, 'app-form-owner')).not.toContain('readOnly=""')
  })

  test('a member’s app keeps its developer as its owner', () => {
    const html = render(
      <ActionPrompt
        prompt={{
          action: 'app.edit',
          ids: ['5'],
          where: 'record',
          initial: { app: { ...settingsOfRow(quill), ownerLocked: true } },
        }}
        busy={false}
        onAnswer={() => {}}
        onCancel={() => {}}
      />,
      '/admin/apps?id=5',
    )
    expect(tag(html, 'app-form-owner')).toContain('readOnly=""')
    expect(tag(html, 'app-form-owner')).toContain('value="mara"')
    expect(html).toContain('stays theirs to test')
  })

  test('reads back as the settings it started from', () => {
    const settings: AdminAppSettings = settingsOfRow(loom)
    expect(parseAppSettings(settingsOf(draftOf(settings)))).toEqual({ ok: true, value: settings })
    // A limit left empty is the default, and a blank line among the redirects is no redirect.
    const draft = { ...draftOf(settings), perAppPerMin: '', redirectUris: 'com.a.b:/x\n\n' }
    expect(settingsOf(draft)).toMatchObject({ perAppPerMin: null, redirectUris: ['com.a.b:/x'] })
  })
})

describe('asking first', () => {
  test('registering and editing ask for the settings; cutting off and ending ask for a yes', () => {
    expect(promptFor('app.create')).toEqual({ input: 'app' })
    expect(promptFor('app.edit')).toEqual({ input: 'app' })
    expect(promptFor('app.suspend')).toEqual({ confirm: true })
    expect(promptFor('app.endConnections')).toEqual({ confirm: true })
    // Approving and restoring give something back: at once, with an undo.
    expect(promptFor('app.approve')).toBeNull()
    expect(promptFor('app.restore')).toBeNull()
    expect(actionLook('app.suspend', 1)).toBe('danger')
    expect(actionLook('app.endConnections', 2)).toBe('danger')
  })
})

describe('the words', () => {
  test.each(['en', 'zh-Hans', 'zh-Hant'] as const)('%s names everything the area shows', (lang) => {
    const t = createTranslator({
      locale: lang,
      messages: { admin: ADMIN_MESSAGES[lang] },
      namespace: 'admin.members',
    }) as unknown as Translate
    const keys = [
      ...ADMIN_FILTERS.apps.map((f) => `apps.filters.${f}`),
      ...APP_STATUSES.flatMap((s) => [`apps.status.${s}`, `apps.notes.${s}`]),
      'apps.scope.read',
      'apps.scope.write',
      'apps.operator',
      'apps.notReviewed',
      'apps.notes.unreviewed',
      ...['registeredBy', 'terms', 'reviewed'].map((k) => `apps.kv.${k}`),
      ...['label', 'noNote', 'wantsEmail', 'noEmail'].map((k) => `apps.request.${k}`),
      ...['body', 'email', 'submit'].map((k) => `apps.review.${k}`),
      'apps.form.ownerLocked',
      'reports.openApp',
      'reports.kv.developer',
      ...Object.keys(settingsOfRow(loom)).flatMap((f) => [
        `apps.form.${f}`,
        `apps.form.errors.${f}`,
      ]),
    ]
    for (const key of keys) {
      expect({ key, text: t(key) }).not.toEqual({ key, text: `admin.members.${key}` })
    }
  })
})
