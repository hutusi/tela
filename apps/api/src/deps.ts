/**
 * What tela-api runs against. Every dependency is an interface from `@tela/platform` or a plain
 * value, so the same app runs in the Cloudflare Worker and in the bun test suite on libSQL.
 */
import type { JobQueues, TelaDb } from '@tela/data'
import type { Ingest } from '@tela/ingest/pipeline'
import type { Blobs, Clock, Jobs, Mail } from '@tela/platform'

export type ApiConfig = {
  /** The public origin readers use (the only one: workers.dev is off). better-auth's base URL. */
  publicUrl: string
  /** Signs sessions and the cookie cache; tela-web holds the same secret to read the cache. */
  authSecret: string
  /** Bearer token for `/api/admin/*`; unset turns those routes off. */
  adminToken?: string
  /** Sender of sign-in mail, e.g. `Tela <noreply@ainaive.com>`. */
  mailFrom: string
  /** Test mode: exposes the mail outbox. Never set in production. */
  testMode?: boolean
  /** Where Gravatar serves pictures (ADR 0032); tests point it at a fixture. */
  gravatarUrl?: string
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
