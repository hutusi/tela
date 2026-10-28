/**
 * Settings → Developer (ADR 0067), drawn on the server from fixtures: each app's status, review,
 * members against the cap and client ID; the actions each status offers and the questions they
 * ask first; the form, and the rules it checks before tela-api does. No effect runs in a server
 * render, so nothing is asked.
 */
import { describe, expect, test } from 'bun:test'
import { APP_STATUSES, type DeveloperApp, UI_LOCALES, type UiLocale } from '@tela/shared'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { createTranslator } from 'use-intl'
import { I18n, MESSAGES } from '../src/i18n'
import {
  API_GUIDE,
  AppForm,
  checkDraft,
  clearsReview,
  DEVELOPER_RULES,
  DeveloperApps,
  type Draft,
  draftOf,
  RowPanel,
} from '../src/pages/settings-developer'
import { UiContext } from '../src/ui'

function render(node: React.ReactNode, locale: UiLocale = 'en'): string {
  return renderToString(
    <UiContext.Provider value={{ locale, setLocale() {} }}>
      <I18n locale={locale}>
        <MemoryRouter initialEntries={['/settings/developer']}>{node}</MemoryRouter>
      </I18n>
    </UiContext.Provider>,
  ).replaceAll('<!-- -->', '')
}

const at = Date.UTC(2026, 9, 3, 12)

const LOOM: DeveloperApp = {
  appId: 7,
  clientId: 'tela_app_loom',
  name: 'Loom',
  developer: 'Loom Labs',
  contactEmail: 'dev@loom.example',
  homepageUrl: 'https://loom.example',
  privacyUrl: 'https://loom.example/privacy',
  redirectUris: ['http://127.0.0.1/callback', 'com.loom.app:/callback'],
  maxScope: 'write',
  status: 'approved',
  reviewed: false,
  reviewRequestedAt: null,
  reviewWantsEmail: false,
  connections: 37,
  cap: 100,
  createdAt: at,
  approvedAt: at,
  suspendedAt: null,
}

/** The opening tag of the element with this test id. */
const tag = (html: string, testId: string) =>
  html.match(new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? ''

const list = (apps: DeveloperApp[] | null, locale?: UiLocale, failed = false) =>
  render(
    <DeveloperApps
      apps={apps}
      failed={failed}
      accountEmail="mara@example.com"
      onChange={() => {}}
    />,
    locale,
  )

const panel = (mode: 'testing' | 'delete' | 'review', app = LOOM) =>
  render(
    <RowPanel
      app={app}
      mode={mode}
      busy={false}
      accountEmail={null}
      onTesting={() => {}}
      onDelete={() => {}}
      onReview={() => {}}
      onSaved={() => {}}
      onCancel={() => {}}
    />,
  )

describe('the list', () => {
  test('shows each app’s status, review, members against the cap, client ID and day', () => {
    const html = list([LOOM])
    expect(html.match(/data-testid="developer-app"/g)).toHaveLength(1)
    expect(html).toContain('href="https://loom.example"')
    expect(html).toContain('Live')
    expect(html).toContain('Anyone on Tela can connect it.')
    expect(html).toContain('Not reviewed')
    expect(html).toContain('37 of 100 members connected')
    expect(html).toContain('registered Oct 3, 2026')
    expect(html).toContain('tela_app_loom')
    expect(html).toContain('data-testid="developer-app-copy"')
    // The cap unreviewed apps share, said once, and the rules every app is held to.
    expect(html).toContain('share a cap: 100 members connected at once')
    expect(html).toContain(`href="${DEVELOPER_RULES}"`)
    expect(html).toContain('data-testid="developer-register"')
  })

  test('Testing is only its developer’s, and offers Live; Live offers going back', () => {
    const testing = list([{ ...LOOM, status: 'draft', connections: 1 }])
    expect(testing).toContain('Testing')
    expect(testing).toContain('Only you can connect it.')
    expect(testing).toContain('data-testid="developer-app-live"')
    expect(testing).not.toContain('data-testid="developer-app-testing"')
    const live = list([LOOM])
    expect(live).toContain('data-testid="developer-app-testing"')
    expect(live).not.toContain('data-testid="developer-app-live"')
    for (const html of [testing, live]) {
      expect(html).toContain('data-testid="developer-app-review-ask"')
      expect(html).toContain('data-testid="developer-app-edit"')
      expect(html).toContain('data-testid="developer-app-delete"')
    }
  })

  test('a cut-off app says so and offers nothing: it can be neither changed nor deleted', () => {
    const html = list([{ ...LOOM, status: 'suspended', suspendedAt: at }])
    expect(html).toContain('Cut off')
    expect(html).toContain('Tela has cut it off')
    expect(html).not.toContain('data-testid="developer-app-actions"')
  })

  test('a reviewed app has no cap and no review to ask for; one asked for says when', () => {
    const reviewed = list([{ ...LOOM, reviewed: true, cap: null, connections: 240 }])
    expect(reviewed).toContain('Reviewed by Tela')
    expect(reviewed).toContain('240 members connected')
    expect(reviewed).not.toContain(' of ')
    expect(reviewed).not.toContain('data-testid="developer-cap"')
    expect(reviewed).not.toContain('data-testid="developer-app-review-ask"')
    const asked = list([{ ...LOOM, reviewRequestedAt: at }])
    expect(asked).toContain('Not reviewed')
    expect(asked).toContain('· review requested Oct 3, 2026')
    expect(asked).not.toContain('data-testid="developer-app-review-ask"')
  })

  test('with no apps, says what an app is, where the guide is, and how an app starts', () => {
    const html = list([])
    expect(html).toContain('No apps yet')
    expect(html).toContain(`href="${API_GUIDE}"`)
    expect(html).toContain('An app starts in Testing, where only you can connect it')
    expect(html).toContain('can hold only a limited number of members')
    expect(html).toContain('data-testid="developer-register"')
    expect(html).not.toContain('data-testid="developer-app"')
  })

  test('a list that would not load says so, and offers no register before it knows', () => {
    const html = list(null, 'fr', true)
    expect(html).toContain('Impossible de charger vos applications')
    expect(html).not.toContain('data-testid="developer-register"')
  })
})

describe('the questions', () => {
  test('back to Testing says it disconnects everyone but the developer', () => {
    const html = panel('testing')
    expect(html).toContain('Put Loom back in Testing?')
    expect(html).toContain('Everyone but you is disconnected from it at once')
    expect(html).toContain('data-testid="developer-app-testing-yes"')
  })

  test('Delete says every connection ends, for good', () => {
    const html = panel('delete')
    expect(html).toContain('Delete Loom?')
    expect(html).toContain('disconnected at once')
    expect(html).toContain('This can’t be undone.')
    expect(html).toContain('data-testid="developer-app-delete-yes"')
  })

  test('a review request says what a review lifts, takes a note and the email wish', () => {
    const html = panel('review')
    expect(html).toContain('no longer held to the cap on members')
    expect(html).toContain('ask members for their email address')
    expect(tag(html, 'developer-review-note')).toContain('maxLength="500"')
    expect(html).toContain('It needs members’ email addresses')
    expect(html).toContain('data-testid="developer-review-send"')
  })
})

describe('the form', () => {
  test('registering asks every field, shows the account’s address, and the rules to accept', () => {
    const html = render(
      <AppForm app={null} accountEmail="mara@example.com" onDone={() => {}} onCancel={() => {}} />,
    )
    for (const field of [
      'name',
      'developer',
      'contactEmail',
      'homepageUrl',
      'privacyUrl',
      'redirectUris',
      'scope-read',
      'scope-write',
      'terms',
    ]) {
      expect(html).toContain(`data-testid="developer-form-${field}"`)
    }
    expect(tag(html, 'developer-form-contactEmail')).toContain('placeholder="mara@example.com"')
    expect(tag(html, 'developer-form-scope-read')).toContain('checked=""')
    expect(html).toContain(`href="${DEVELOPER_RULES}"`)
    expect(html).toContain('Only Tela’s own apps may use the word “Tela”.')
    expect(html).toContain('>Register<')
  })

  test('editing starts from the app as it is, with no rules to accept again', () => {
    const html = render(
      <AppForm app={LOOM} accountEmail={null} onDone={() => {}} onCancel={() => {}} />,
    )
    expect(tag(html, 'developer-form-name')).toContain('value="Loom"')
    expect(tag(html, 'developer-form-contactEmail')).toContain('value="dev@loom.example"')
    expect(tag(html, 'developer-form-contactEmail')).toContain(
      'placeholder="Your account’s email address"',
    )
    expect(html).toContain('http://127.0.0.1/callback\ncom.loom.app:/callback')
    expect(tag(html, 'developer-form-scope-write')).toContain('checked=""')
    expect(html).not.toContain('data-testid="developer-form-terms"')
    expect(html).not.toContain('data-testid="developer-form-clears-review"')
    expect(html).toContain('>Save<')
  })
})

describe('what the form checks first', () => {
  const draft = (over: Partial<Draft> = {}): Draft => ({ ...draftOf(LOOM), ...over })
  const creating = { creating: true, accepted: true, accountEmail: null }
  const editing = { creating: false, accepted: false, accountEmail: 'mara@example.com' }

  test('a name or developer that says Tela is refused, as tela-api would', () => {
    expect(checkDraft(draft({ name: 'TelaSync' }), creating)).toEqual({ ok: false, field: 'name' })
    expect(checkDraft(draft({ developer: 'Ｔｅｌａ Labs' }), creating)).toEqual({
      ok: false,
      field: 'developer',
    })
    expect(checkDraft(draft({ name: 'Hotela' }), creating).ok).toBe(true)
  })

  test('the redirect URIs are one a line, blank lines dropped', () => {
    const checked = checkDraft(draft({ redirectUris: '\n http://127.0.0.1/cb \n\n' }), creating)
    expect(checked.ok && checked.settings.redirectUris).toEqual(['http://127.0.0.1/cb'])
    expect(checkDraft(draft({ redirectUris: 'https://loom.example/cb' }), creating)).toEqual({
      ok: false,
      field: 'redirectUris',
    })
  })

  test('registering needs the rules accepted, after every field is right', () => {
    expect(checkDraft(draft(), { ...creating, accepted: false })).toEqual({
      ok: false,
      field: 'terms',
    })
    expect(checkDraft(draft({ name: '' }), { ...creating, accepted: false })).toEqual({
      ok: false,
      field: 'name',
    })
  })

  test('an empty contact address is the account’s: left to tela-api for a new app', () => {
    const fresh = checkDraft(draft({ contactEmail: ' ' }), creating)
    expect(fresh.ok && fresh.ownAddress).toBe(true)
    const edited = checkDraft(draft({ contactEmail: '' }), editing)
    expect(edited.ok && edited.settings.contactEmail).toBe('mara@example.com')
    // An edit with no address to send is wrong, not sent empty.
    expect(checkDraft(draft({ contactEmail: '' }), { ...editing, accountEmail: null })).toEqual({
      ok: false,
      field: 'contactEmail',
    })
    expect(checkDraft(draft({ contactEmail: 'not an address' }), creating)).toEqual({
      ok: false,
      field: 'contactEmail',
    })
  })

  test('a new name, developer, homepage, privacy policy, redirect URIs or scope clears a review; the contact does not', () => {
    const reviewed = { ...LOOM, reviewed: true }
    expect(clearsReview(reviewed, draft())).toBe(false)
    expect(clearsReview(reviewed, draft({ name: ' Loom ' }))).toBe(false)
    expect(clearsReview(reviewed, draft({ contactEmail: 'other@loom.example' }))).toBe(false)
    expect(clearsReview(reviewed, draft({ developer: 'Loom Ltd' }))).toBe(true)
    expect(clearsReview(reviewed, draft({ homepageUrl: '' }))).toBe(true)
    expect(clearsReview(reviewed, draft({ privacyUrl: 'https://loom.example/p2' }))).toBe(true)
    expect(clearsReview(reviewed, draft({ name: 'Loom 2' }))).toBe(true)
    expect(clearsReview(reviewed, draft({ maxScope: 'read' }))).toBe(true)
    expect(clearsReview(reviewed, draft({ redirectUris: 'http://127.0.0.1/callback' }))).toBe(true)
    // Nothing to clear on an app Tela has not reviewed.
    expect(clearsReview(LOOM, draft({ name: 'Loom 2' }))).toBe(false)
  })
})

describe('its words', () => {
  test.each([...UI_LOCALES])('every status and every field’s refusal resolves in %s', (locale) => {
    const t = createTranslator({
      locale,
      messages: MESSAGES[locale as UiLocale],
      namespace: 'developer',
    }) as unknown as (key: string, values?: Record<string, unknown>) => string
    const keys = [
      ...APP_STATUSES.flatMap((s) => [`status.${s}`, `statusBody.${s}`]),
      ...[
        'name',
        'nameTela',
        'developer',
        'developerTela',
        'contactEmail',
        'homepageUrl',
        'privacyUrl',
        'redirectUris',
        'maxScope',
        'terms',
      ].map((f) => `form.errors.${f}`),
      ...['failed', 'rate_limited', 'privacy_required', 'cut_off', 'reported'].map(
        (e) => `errors.${e}`,
      ),
    ]
    for (const key of keys) {
      const text = t(key, { name: 50, text: 300, n: 10, limit: 5 })
      expect({ key, text }).not.toEqual({ key, text: `developer.${key}` })
    }
    expect(t('errors.app_limit', { limit: 5 })).toContain('5')
  })
})
