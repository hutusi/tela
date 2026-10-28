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
 * Characters a reader cannot see: format characters (soft hyphen, zero-width spaces and joiners,
 * the word joiner, bidirectional overrides) and the blank fillers fonts draw as nothing. A name
 * holding one could say "Tela" to the eye and not to a check, or turn the consent page's sentence
 * around it backwards, so a member's app may use none (ADR 0067).
 */
const INVISIBLE = /\p{Cf}|\u034F|[\u115F\u1160\u17B4\u17B5\u180E\u2800\u3164\uFFA0]/u

/** Whether text holds a character a reader cannot see. */
export const hasInvisible = (text: string): boolean => INVISIBLE.test(text)

/**
 * Letters of other scripts drawn like the Latin `t`, `e`, `l` and `a` (Unicode's confusables,
 * UTS #39, for the four that matter here), compared once lowercased: Cyrillic т е ӏ а and Greek τ ε
 * α, whose capitals Т Е А Τ Ε Α read as "TELA".
 */
const LOOKALIKES: Record<string, string> = {
  т: 't',
  е: 'e',
  ӏ: 'l',
  а: 'a',
  τ: 't',
  ε: 'e',
  α: 'a',
}

/**
 * A capital I (Latin, Cyrillic І or Greek Ι) after a lowercase letter, where a sans-serif face
 * draws it as an `l`: `TeIa` reads as "Tela", and lowercasing would make it an `i`. Only there, so
 * `TEIA` (Portuguese for "web"), whose I stands beside capitals and reads as one, is left alone.
 */
const CAPITAL_I_AS_L = /(?<=\p{Ll})[I\u0406\u0399]/gu

/**
 * Whether a name says "Tela", which only the operator may use (ADR 0067): on Tela's own consent
 * page, "Tela Sync wants to read and write your account" reads as Tela itself. Any word that
 * starts with it, in any case, once the text is NFKC-normalised, stripped of what a reader cannot
 * see, and its look-alike letters read as Latin: so `TelaSync`, `Ｔｅｌａ`, `my-tela`, `T\u00ADela`,
 * `Tеla` (a Cyrillic е) and `TeIa` (a capital I) all count, and `Hotela` does not.
 */
export function mentionsTela(text: string): boolean {
  const skeleton = [
    ...text
      .normalize('NFKC')
      .replace(new RegExp(INVISIBLE, 'gu'), '')
      .replace(CAPITAL_I_AS_L, 'l')
      .toLowerCase(),
  ]
    .map((c) => LOOKALIKES[c] ?? c)
    .join('')
  return /(?:^|[^\p{L}\p{N}])tela/u.test(skeleton)
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
  if (name === undefined || hasInvisible(name) || mentionsTela(name)) {
    return { ok: false, field: 'name' }
  }
  const developer = appText(v.developer, APP_TEXT_MAX)
  if (developer === undefined || hasInvisible(developer) || mentionsTela(developer)) {
    return { ok: false, field: 'developer' }
  }
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

/**
 * A review request's note: trimmed, at most `REVIEW_NOTE_MAX`, or null for none. Line breaks are
 * the one control character it may hold (CRLF read as LF): it comes from a textarea, and only the
 * operator reads it, as written. Nothing invisible.
 */
export function parseReviewNote(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') return undefined
  const note = value.replace(/\r\n?/g, '\n').trim()
  if (note === '') return null
  if (note.length > REVIEW_NOTE_MAX) return undefined
  if (/[\p{Cc}]/u.test(note.replace(/\n/g, '')) || hasInvisible(note)) return undefined
  return note
}

/**
 * What a member's change to their app records in the admin console's audit log (ADR 0067), with
 * the member as its actor and the app as its target, never its contact address: registering it,
 * editing it, making it Live or taking it back to Testing, asking for a review, and deleting it.
 */
export const DEVELOPER_ACTIONS = [
  'developer.register',
  'developer.edit',
  'developer.live',
  'developer.testing',
  'developer.review',
  'developer.delete',
] as const
export type DeveloperAction = (typeof DEVELOPER_ACTIONS)[number]

/**
 * What `/api/v1/developer/apps` refuses with, as `{ error }`:
 *
 * - `invalid` (400), with `field`: the first setting that is wrong (`DeveloperAppField`; a name or
 *   developer that says "Tela" is wrong), or `note`, `wantsEmail` or `live`;
 * - `terms` (400): registering needs `acceptTerms: true`;
 * - `privacy_required` (400): an app goes Live only with a privacy policy URL;
 * - `not_found` (404): no app of the member's has that id;
 * - `too_many_apps` (409): `apps.perMember` reached;
 * - `cut_off` (409): the operator cut it off, so it is neither edited, moved nor deleted;
 * - `reported` (409): an open report names it, so it is neither edited nor deleted;
 * - `handle` (400): the member's handle says "Tela", so they can't register or go Live;
 * - `rate_limited` (429, with `retry-after`): registered or edited too often today.
 */
export const DEVELOPER_ERRORS = [
  'invalid',
  'terms',
  'privacy_required',
  'not_found',
  'too_many_apps',
  'cut_off',
  'reported',
  'rate_limited',
  // The member's handle says "Tela", which the consent page would show beside their app.
  'handle',
] as const
export type DeveloperError = (typeof DEVELOPER_ERRORS)[number]

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
