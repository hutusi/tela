/**
 * Apps a member registers for themselves in Settings → Developer (ADR 0067): what they may set,
 * the rule every registration is held to, and what tela-api answers about each. The operator's own
 * registration, with limits, an owner and the email permission, is `parseAppSettings`
 * (`./admin/apps`), and the fields both share are checked by the same helpers.
 */

import { APP_EMAIL, appText, httpsUrl, isRedirectList } from './admin/apps'
import {
  APP_NAME_MAX,
  APP_SCOPES,
  APP_TEXT_MAX,
  type AppScope,
  type AppStatus,
  REVIEW_NOTE_MAX,
} from './apps'

/**
 * Whether a name says "Tela", which only the operator may use (ADR 0067): on Tela's own consent
 * page, "Tela Sync wants to read and write your account" reads as Tela itself. Any word that
 * starts with it, in any case, once the text is NFKC-normalised, so `TelaSync`, `Ｔｅｌａ` and
 * `my-tela` all count, and `Hotela` does not.
 */
export function mentionsTela(text: string): boolean {
  return /(?:^|[^\p{L}\p{N}])tela/u.test(text.normalize('NFKC').toLowerCase())
}

/** What a member registers their app with, and edits. */
export type DeveloperAppSettings = {
  name: string
  /** Who makes it, as members read it beside the developer's handle. */
  developer: string
  /** Where the operator writes about the app; never shown to members. */
  contactEmail: string
  homepageUrl: string | null
  /** Needed before the app goes Live: the consent page links it. */
  privacyUrl: string | null
  /** Exact redirect URIs: loopback (any port matches) or a reverse-DNS scheme (RFC 8252). */
  redirectUris: string[]
  /** The most a member may grant it. */
  maxScope: AppScope
}

export type DeveloperAppField = keyof DeveloperAppSettings

/**
 * A member's app settings, checked and tidied, or the first field that is wrong. Neither the name
 * nor the developer may say "Tela" (`mentionsTela`); tela-api runs the same check.
 */
export function parseDeveloperApp(
  value: unknown,
): { ok: true; value: DeveloperAppSettings } | { ok: false; field: DeveloperAppField } {
  if (typeof value !== 'object' || value === null) return { ok: false, field: 'name' }
  const v = value as Record<string, unknown>
  const name = appText(v.name, APP_NAME_MAX)
  if (name === undefined || mentionsTela(name)) return { ok: false, field: 'name' }
  const developer = appText(v.developer, APP_TEXT_MAX)
  if (developer === undefined || mentionsTela(developer)) return { ok: false, field: 'developer' }
  const contactEmail = appText(v.contactEmail, APP_TEXT_MAX)
  if (contactEmail === undefined || !APP_EMAIL.test(contactEmail)) {
    return { ok: false, field: 'contactEmail' }
  }
  const homepageUrl = httpsUrl(v.homepageUrl)
  if (homepageUrl === undefined) return { ok: false, field: 'homepageUrl' }
  const privacyUrl = httpsUrl(v.privacyUrl)
  if (privacyUrl === undefined) return { ok: false, field: 'privacyUrl' }
  if (!isRedirectList(v.redirectUris)) return { ok: false, field: 'redirectUris' }
  if (!APP_SCOPES.some((s) => s === v.maxScope)) return { ok: false, field: 'maxScope' }
  return {
    ok: true,
    value: {
      name,
      developer,
      contactEmail,
      homepageUrl,
      privacyUrl,
      redirectUris: v.redirectUris,
      maxScope: v.maxScope as AppScope,
    },
  }
}

/** A review request's note: trimmed, at most `REVIEW_NOTE_MAX`, or null for none. */
export function parseReviewNote(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === '') return null
  return appText(value, REVIEW_NOTE_MAX)
}

/** `GET /api/v1/developer/apps`: one of the member's apps, as Settings → Developer shows it. */
export type DeveloperApp = DeveloperAppSettings & {
  appId: number
  /** Its public `client_id`, `tela_app_…`, which the developer's app sends. */
  clientId: string
  /** `draft` is Testing (only the developer connects), `approved` Live, `suspended` Cut off. */
  status: AppStatus
  reviewed: boolean
  /** When the developer asked for a review not yet answered; null otherwise. */
  reviewRequestedAt: number | null
  reviewWantsEmail: boolean
  /** Members connected now: a count, never who. */
  connections: number
  /**
   * How many members its unreviewed apps may hold together (`apps.unreviewedMaxConnections`),
   * or null for no cap (a reviewed app held only to its own, which the operator sets).
   */
  cap: number | null
  createdAt: number
  approvedAt: number | null
  suspendedAt: number | null
}
