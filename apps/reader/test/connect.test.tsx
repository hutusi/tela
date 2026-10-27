/**
 * The consent page (`/connect`) and Settings → Connected apps (ADR 0064), drawn on the server
 * from fixtures: what an app asks, what no app can do, whose account answers, and what a refused
 * request says instead of going anywhere. No effect runs in a server render, so nothing is asked.
 */
import { describe, expect, test } from 'bun:test'
import {
  CONNECT_ERRORS,
  type Connection,
  type ConnectRequest,
  UI_LOCALES,
  type UiLocale,
} from '@tela/shared'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { createTranslator } from 'use-intl'
import { I18n, MESSAGES } from '../src/i18n'
import { ConsentForm, NEVER, Refused, Sent } from '../src/pages/connect'
import { ConnectionList } from '../src/pages/settings-apps'
import { UiContext } from '../src/ui'

function render(node: React.ReactNode, locale: UiLocale = 'en', path = '/connect'): string {
  return renderToString(
    <UiContext.Provider value={{ locale, setLocale() {} }}>
      <I18n locale={locale}>
        <MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>
      </I18n>
    </UiContext.Provider>,
  )
}

const REQUEST: ConnectRequest = {
  app: {
    clientId: 'tela_app_abc',
    name: 'Loom',
    developer: 'Loom Labs',
    homepageUrl: 'https://loom.example',
    privacyUrl: 'https://loom.example/privacy',
    status: 'approved',
  },
  scope: 'write',
  email: true,
  redirect: { kind: 'loopback', target: '127.0.0.1:53682' },
}

const MARA = { handle: 'mara', displayName: 'Mara', avatar: null }

/** The opening tag of the element with this test id. */
const tag = (html: string, testId: string) =>
  html.match(new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? ''

const consent = (request: ConnectRequest, account: typeof MARA | null = MARA, locale?: UiLocale) =>
  render(
    <ConsentForm
      request={request}
      search="?client_id=tela_app_abc"
      account={account}
      onSwitch={() => {}}
      onRefused={() => {}}
      onSent={() => {}}
    />,
    locale,
  )

describe('the consent page', () => {
  test('says who asks, as whom, for what, and where the answer goes', () => {
    const html = consent(REQUEST)
    expect(html).toContain('Connect Loom to your Tela account?')
    expect(html).toContain('By Loom Labs')
    expect(html).toContain('href="https://loom.example"')
    // The account answering, and a way to answer as another.
    expect(html).toContain('Signed in as')
    expect(html.replaceAll('<!-- -->', '')).toContain('Mara · @mara')
    expect(html).toContain('data-testid="connect-switch"')
    // Write is asked for, and may be lowered to read.
    expect(html).toContain('data-testid="connect-level-write"')
    expect(html).toContain('data-testid="connect-level-read"')
    expect(tag(html, 'connect-level-write')).toContain('checked=""')
    expect(tag(html, 'connect-level-read')).not.toContain('checked=""')
    expect(html).toContain('ask for translations, which count toward your daily translations')
    expect(html).toContain('Let it see your email address')
    // What no app can do, whatever it is granted.
    for (const line of [
      'Delete your account',
      'Change how you sign in, or your password',
      'Download your data',
      'Do anything only the person who runs Tela can',
    ]) {
      expect(html).toContain(line)
    }
    expect(html).toContain('the app on this computer (127.0.0.1:53682)')
    expect(html).toContain('href="https://loom.example/privacy"')
    expect(html).toContain('its own responsibility')
    expect(html).toContain('>Approve<')
    expect(html).toContain('>Decline<')
    expect(html).not.toContain('data-testid="connect-draft"')
  })

  test('a read-only request offers nothing to lower, and no email line unless asked', () => {
    const html = consent({ ...REQUEST, scope: 'read', email: false })
    expect(html).not.toContain('type="radio"')
    expect(html).toContain('It can’t change anything, or ask for translations.')
    expect(html).not.toContain('data-testid="connect-email"')
  })

  test('a draft says it is not yet approved; a scheme returns to the app', () => {
    const html = consent({
      ...REQUEST,
      app: { ...REQUEST.app, status: 'draft', privacyUrl: null },
      redirect: { kind: 'scheme', target: 'com.loom.desktop' },
    })
    expect(html).toContain('data-testid="connect-draft"')
    expect(html).toContain('Not yet approved by Tela')
    expect(html).toContain('you go back to the app (com.loom.desktop)')
    expect(html).toContain('It has given Tela no privacy policy.')
  })

  test('cannot approve before it can say which account approves', () => {
    const html = consent(REQUEST, null)
    expect(html).not.toContain('data-testid="connect-account"')
    expect(tag(html, 'connect-approve')).toContain('disabled=""')
    expect(tag(html, 'connect-decline')).not.toContain('disabled=""')
  })

  test('a refused request says why and goes nowhere', () => {
    const html = render(<Refused error="invalid_redirect" onRetry={() => {}} />)
    expect(html).toContain('This app can’t connect')
    expect(html).toContain('somewhere it never registered')
    expect(html).toContain('Nothing was shared with the app.')
    expect(html).not.toContain('Try again')
    const offline = render(<Refused error="failed" onRetry={() => {}} />)
    expect(offline).toContain('Couldn’t reach Tela')
    expect(offline).toContain('Try again')
  })

  test('answered, it says where the browser is going', () => {
    expect(render(<Sent request={REQUEST} approved />)).toContain('Loom is connected')
    expect(render(<Sent request={REQUEST} approved={false} />)).toContain('You declined Loom')
  })

  test.each([...UI_LOCALES])(
    '%s has every refusal and every line of what no app can do',
    (locale) => {
      const t = createTranslator({
        locale,
        messages: MESSAGES[locale as UiLocale],
        namespace: 'connect',
      }) as unknown as (key: string) => string
      for (const key of [
        ...CONNECT_ERRORS.map((e) => `errors.${e}`),
        'errors.failed',
        ...NEVER.map((n) => `never.${n}`),
      ]) {
        expect({ key, text: t(key) }).not.toEqual({ key, text: `connect.${key}` })
      }
    },
  )
})

describe('Settings → Connected apps', () => {
  const at = Date.UTC(2026, 9, 3, 12)
  const LOOM: Connection = {
    id: 7,
    app: { name: 'Loom', developer: 'Loom Labs', homepageUrl: 'https://loom.example' },
    scope: 'write',
    email: true,
    createdAt: at,
    lastUsedAt: null,
    devices: 2,
  }

  test('lists each app with what it may do, when, and on how many devices', () => {
    const html = render(
      <ConnectionList
        connections={[LOOM, { ...LOOM, id: 8, scope: 'read', email: false, lastUsedAt: at }]}
        failed={false}
        onChange={() => {}}
      />,
      'en',
      '/settings/apps',
    )
    expect(html.match(/data-testid="connection"/g)).toHaveLength(2)
    expect(html).toContain('By Loom Labs')
    expect(html).toContain('Read and write, and your email address')
    expect(html).toContain('Read only')
    expect(html).toContain('Connected Oct 3, 2026')
    expect(html).toContain('not used yet')
    expect(html).toContain('last used Oct 3, 2026')
    expect(html).toContain('2 devices')
    expect(html).toContain('data-testid="connection-disconnect"')
    expect(html).toContain('href="/privacy#apps"')
  })

  test('with nothing connected, says what apps are and that Tela approves each one', () => {
    const html = render(
      <ConnectionList connections={[]} failed={false} onChange={() => {}} />,
      'en',
      '/settings/apps',
    )
    expect(html).toContain('No apps connected')
    expect(html).toContain('Tela approves each one before anyone can connect it')
    expect(html).not.toContain('data-testid="connection"')
  })

  test('a list that would not load says so', () => {
    const html = render(<ConnectionList connections={null} failed onChange={() => {}} />, 'fr')
    expect(html).toContain('Impossible de charger vos applications connectées')
  })
})
