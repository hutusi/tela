/** A tela-api on the portable path: libSQL, memory mail, blobs and queues. */
import type { JobQueues, TelaDb } from '@tela/data'
import { createTestDb } from '@tela/data/testing'
import { createHttpClient } from '@tela/ingest/http'
import { createIngest } from '@tela/ingest/pipeline'
import { fakeClock, memoryBlobs, memoryJobs, memoryMail } from '@tela/platform/portable'
import { createApp } from '../src/app'
import type { ApiConfig } from '../src/deps'

export const ORIGIN = 'http://tela.test'
export const ADMIN_TOKEN = 'admin-token-for-tests'

/** Overrides; an explicit `undefined` removes a setting (no admin token, say). */
type ConfigOverrides = { [K in keyof ApiConfig]?: ApiConfig[K] | undefined }

export async function createTestApi(overrides: ConfigOverrides = {}) {
  const config: Record<string, unknown> = {
    publicUrl: ORIGIN,
    authSecret: 'a-test-secret-that-is-long-enough-for-hmac',
    adminToken: ADMIN_TOKEN,
    mailFrom: 'Tela <noreply@tela.test>',
    testMode: true,
    ...overrides,
  }
  for (const key of Object.keys(config)) if (config[key] === undefined) delete config[key]
  const { db } = await createTestDb()
  const mail = memoryMail()
  const jobs = memoryJobs<JobQueues>()
  const blobs = memoryBlobs()
  const clock = fakeClock(Date.UTC(2026, 8, 28, 12))
  // The real ingest, in-process, allowed to reach the local fixture server.
  const http = createHttpClient({
    userAgent: 'TelaTest/1.0',
    politenessMs: 0,
    allowPrivateHosts: true,
    timeoutMs: 2000,
  })
  const ingest = createIngest({ db, http, now: () => clock.now() })
  const { app, auth } = createApp({
    db,
    blobs,
    jobs,
    clock,
    mail,
    ingest,
    config: config as ApiConfig,
  })
  /** A request as the browser sends it through tela-web: same origin, JSON, cookies. */
  const request = (
    path: string,
    init: {
      method?: string
      body?: unknown
      cookie?: string
      headers?: Record<string, string>
    } = {},
  ) =>
    app.request(`${ORIGIN}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        origin: ORIGIN,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.cookie ? { cookie: init.cookie } : {}),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
  return { app, auth, db, mail, jobs, blobs, clock, request }
}

export type TestApi = Awaited<ReturnType<typeof createTestApi>>

/** The cookies a response sets, as a request `cookie` header. */
export function cookiesOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
}

/** The sign-in code in the newest mail to `email`. */
export function codeFor(api: TestApi, email: string): string {
  const mail = [...api.mail.outbox].reverse().find((m) => m.to === email)
  const code = mail?.text.match(/^\d{6}$/m)?.[0]
  if (!code) throw new Error(`no code mailed to ${email}`)
  return code
}

/** Invite a member and sign them in; returns their session cookie and user id. */
export async function signedIn(api: TestApi, email = 'reader@x.test') {
  const invited = await api.request('/api/admin/invite', {
    body: { email },
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  })
  const { userId } = (await invited.json()) as { userId: string }
  const res = await api.request('/api/auth/sign-in/email-otp', {
    body: { email, otp: codeFor(api, email) },
  })
  if (res.status !== 200) throw new Error(`sign-in failed: ${res.status} ${await res.text()}`)
  return { cookie: cookiesOf(res), userId }
}

export type { TelaDb }
