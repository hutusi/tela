import type { D1Database, Queue, R2Bucket } from '@cloudflare/workers-types'
import type { JobMessage } from '@tela/data'
import type { Ingest } from '@tela/ingest/pipeline'

/** tela-api's bindings, vars and secrets (wrangler.jsonc; secrets via `wrangler secret put`). */
export type Env = {
  DB: D1Database
  BLOBS: R2Bucket
  FETCH_QUEUE: Queue<JobMessage>
  EXTRACT_QUEUE: Queue<JobMessage>
  TRANSLATE_QUEUE: Queue<JobMessage>
  MISC_QUEUE: Queue<JobMessage>
  /** tela-jobs' `Ingest` entrypoint: discovery, adding a feed, starting a claim. */
  JOBS: Ingest & {
    /** Test mode only (tela-jobs refuses otherwise): run its sweeps to completion now. */
    cycle(options?: { refetch?: boolean }): Promise<unknown>
  }
  /** The public origin, e.g. https://tela.ainaive.com. */
  PUBLIC_URL: string
  MAIL_FROM: string
  /** Secret: signs sessions and the cookie cache. tela-web holds the same value. */
  AUTH_SECRET: string
  /** Secret: bearer token for /api/admin/*. */
  ADMIN_TOKEN?: string
  /** Secret: Resend's API key for sign-in mail. */
  RESEND_API_KEY?: string
  /** `test` for local e2e: mail goes to an outbox route instead of Resend, and the test routes exist. */
  ENV?: string
  /** Where Gravatar serves pictures; unset is gravatar.com. The e2e points it at its fixtures. */
  GRAVATAR_URL?: string
}
