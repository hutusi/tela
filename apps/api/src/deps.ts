/**
 * What tela-api runs against. Every dependency is an interface from `@tela/platform` or a plain
 * value, so the same app runs in the Cloudflare Worker and in the bun test suite on libSQL.
 */
import type { JobQueues, TelaDb } from '@tela/data'
import type { Ingest } from '@tela/ingest/pipeline'
import type { Blobs, Clock, Jobs, Mail } from '@tela/platform'

/** An app registered with a sign-in provider (ADR 0036). */
export type OAuthClient = { clientId: string; clientSecret: string }

export type ApiConfig = {
  /** The public origin readers use (the only one: workers.dev is off). better-auth's base URL. */
  publicUrl: string
  /**
   * The API's origin for apps, `https://api.telaread.com` (ADR 0065): the OAuth issuer, and where
   * its token and revocation endpoints are (ADR 0064). No trailing slash: RFC 9207 compares the
   * issuer exactly.
   */
  apiUrl: string
  /** Signs sessions and the cookie cache; tela-web holds the same secret to read the cache. */
  authSecret: string
  /** Bearer token for `/api/admin/*`; unset turns those routes off. */
  adminToken?: string
  /** Sender of sign-in mail, e.g. `Tela <noreply@telaread.com>`. */
  mailFrom: string
  /** Test mode: exposes the mail outbox. Never set in production. */
  testMode?: boolean
  /** Where Gravatar serves pictures (ADR 0032); tests point it at a fixture. */
  gravatarUrl?: string
  /**
   * tela-assets' public base, where a blog's favicon is (`<base>/<faviconKey>`), as the reader's
   * build names it (`VITE_ASSETS_URL`): the API gives apps absolute URLs (ADR 0065). Unset is
   * `https://assets.telaread.com`.
   */
  assetsUrl?: string
  /**
   * Tela's apps at Google and GitHub (ADR 0036). A provider is offered, and its sign-in served,
   * only while its app is here.
   */
  oauth?: { google?: OAuthClient; github?: OAuthClient }
}

export type ApiDeps = {
  db: TelaDb
  blobs: Blobs
  jobs: Jobs<JobQueues>
  clock: Clock
  mail: Mail
  /** Work that fetches on a member's behalf: tela-jobs' `Ingest` entrypoint in production. */
  ingest: Ingest
  /** Test mode only: tela-jobs' sweeps, run to completion now (the e2e stack fires no crons). */
  cycle?: (options?: { refetch?: boolean }) => Promise<unknown>
  config: ApiConfig
}
