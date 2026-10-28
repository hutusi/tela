/**
 * The calls Settings → Developer makes (ADR 0067): the apps a member registered, and registering,
 * editing, going Live or back to Testing, asking for a review and deleting one. Live answers, like
 * Connected apps, never synced rows: an app's record, its contact address included, is on no
 * device. Every call goes through `api()`, which names the account the tab holds.
 *
 * Each app is read field by field before the page shows it, and a link it draws must be https.
 * A refusal comes back as the reason tela-api gave, or `failed` for one it could not read.
 */
import {
  APP_SCOPES,
  APP_STATUSES,
  type AppScope,
  type AppStatus,
  type DeveloperApp,
  type DeveloperAppField,
  type DeveloperAppSettings,
} from '@tela/shared'
import { api } from '../store/api'
import { httpsOrNull } from './apps-api'

const isScope = (value: unknown): value is AppScope => APP_SCOPES.some((s) => s === value)
const isStatus = (value: unknown): value is AppStatus => APP_STATUSES.some((s) => s === value)
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0
const isTime = (value: unknown): value is number => typeof value === 'number' && value >= 0
const isTimeOrNull = (value: unknown): value is number | null => value === null || isTime(value)

/** One app as tela-api sends it, or null for another shape. */
export function readDeveloperApp(value: unknown): DeveloperApp | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (!isCount(v.appId) || typeof v.clientId !== 'string') return null
  if (typeof v.name !== 'string' || typeof v.developer !== 'string') return null
  if (typeof v.contactEmail !== 'string') return null
  if (!Array.isArray(v.redirectUris) || !v.redirectUris.every((u) => typeof u === 'string')) {
    return null
  }
  if (!isScope(v.maxScope) || !isStatus(v.status)) return null
  if (typeof v.reviewed !== 'boolean' || typeof v.reviewWantsEmail !== 'boolean') return null
  if (!isTimeOrNull(v.reviewRequestedAt) || !isCount(v.connections)) return null
  if (v.cap !== null && !isCount(v.cap)) return null
  if (!isTime(v.createdAt) || !isTimeOrNull(v.approvedAt) || !isTimeOrNull(v.suspendedAt)) {
    return null
  }
  return {
    appId: v.appId,
    clientId: v.clientId,
    name: v.name,
    developer: v.developer,
    contactEmail: v.contactEmail,
    homepageUrl: httpsOrNull(v.homepageUrl),
    privacyUrl: httpsOrNull(v.privacyUrl),
    redirectUris: v.redirectUris,
    maxScope: v.maxScope,
    status: v.status,
    reviewed: v.reviewed,
    reviewRequestedAt: v.reviewRequestedAt,
    reviewWantsEmail: v.reviewWantsEmail,
    connections: v.connections,
    cap: v.cap,
    createdAt: v.createdAt,
    approvedAt: v.approvedAt,
    suspendedAt: v.suspendedAt,
  }
}

/** `GET /api/v1/developer/apps`'s answer, each app read on its own; null for another shape. */
export function readDeveloperApps(body: unknown): DeveloperApp[] | null {
  const list = (body as { apps?: unknown } | null)?.apps
  if (!Array.isArray(list)) return null
  return list.map(readDeveloperApp).filter((a): a is DeveloperApp => a !== null)
}

export async function listDeveloperApps(signal?: AbortSignal): Promise<DeveloperApp[] | null> {
  const res = await api('/api/v1/developer/apps', signal ? { signal } : {})
  return res.ok ? readDeveloperApps(await res.json().catch(() => null)) : null
}

/**
 * Why tela-api refused: a field it found wrong (it runs the rule the form runs first, so this is
 * rare), the most apps one account may register, too many registrations and edits today, Live
 * without a privacy policy, deleting an app Tela cut off or one with an open report, or `failed`
 * for anything else.
 */
export type DeveloperProblem =
  | { error: 'invalid'; field: DeveloperAppField }
  | { error: 'app_limit'; limit: number }
  | { error: 'rate_limited' }
  | { error: 'privacy_required' }
  | { error: 'cut_off' }
  | { error: 'reported' }
  | { error: 'failed' }

const FIELDS: readonly DeveloperAppField[] = [
  'name',
  'developer',
  'contactEmail',
  'homepageUrl',
  'privacyUrl',
  'redirectUris',
  'maxScope',
]

/** What a refusal's status and body say, read so that nothing unexpected is shown as a reason. */
export function problemOf(status: number, body: unknown): DeveloperProblem {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  if (status === 429) return { error: 'rate_limited' }
  if (status === 400 && b.error === 'invalid') {
    const field = FIELDS.find((f) => f === b.field)
    return field ? { error: 'invalid', field } : { error: 'failed' }
  }
  if (status === 400 && b.error === 'privacy_required') return { error: 'privacy_required' }
  if (status === 409 && b.error === 'app_limit' && isCount(b.limit)) {
    return { error: 'app_limit', limit: b.limit }
  }
  if (status === 409 && (b.error === 'cut_off' || b.error === 'reported')) return { error: b.error }
  return { error: 'failed' }
}

export type DeveloperOutcome = { ok: true } | { ok: false; problem: DeveloperProblem }

async function send(
  path: string,
  init: { method?: string; body?: unknown },
): Promise<DeveloperOutcome> {
  const res = await api(path, init)
  if (res.ok) return { ok: true }
  return { ok: false, problem: problemOf(res.status, await res.json().catch(() => null)) }
}

/**
 * What registering sends: the settings, with the contact address left out to mean the account's
 * own, and the developer rules accepted, which tela-api refuses to register without.
 */
export type Registration = Omit<DeveloperAppSettings, 'contactEmail'> & {
  contactEmail?: string
  acceptTerms: true
}

/** `POST /api/v1/developer/apps`: a new app, in Testing. */
export function registerApp(registration: Registration): Promise<DeveloperOutcome> {
  return send('/api/v1/developer/apps', { body: registration })
}

/** `PUT /api/v1/developer/apps/:id`. A new name, redirect URIs or scope clears a review. */
export function editApp(appId: number, settings: DeveloperAppSettings): Promise<DeveloperOutcome> {
  return send(`/api/v1/developer/apps/${appId}`, { method: 'PUT', body: settings })
}

/** Live for everyone, or back to Testing, which ends every other member's connection. */
export function setLive(appId: number, live: boolean): Promise<DeveloperOutcome> {
  return send(`/api/v1/developer/apps/${appId}/live`, { body: { live } })
}

/** Ask Tela to review the app, with a note and whether it needs members' email addresses. */
export function requestReview(
  appId: number,
  note: string | null,
  wantsEmail: boolean,
): Promise<DeveloperOutcome> {
  return send(`/api/v1/developer/apps/${appId}/review`, { body: { note, wantsEmail } })
}

/** Delete the app, ending every connection to it. Refused while cut off or reported. */
export function deleteApp(appId: number): Promise<DeveloperOutcome> {
  return send(`/api/v1/developer/apps/${appId}`, { method: 'DELETE' })
}
