import type { D1Database, Queue, R2Bucket } from '@cloudflare/workers-types'
import type { JobMessage } from '@tela/data'

/** tela-api's bindings, vars and secrets (wrangler.jsonc; secrets via `wrangler secret put`). */
export type Env = {
  DB: D1Database
  BLOBS: R2Bucket
  FETCH_QUEUE: Queue<JobMessage>
  EXTRACT_QUEUE: Queue<JobMessage>
  TRANSLATE_QUEUE: Queue<JobMessage>
  MISC_QUEUE: Queue<JobMessage>
  /** The public origin, e.g. https://tela.ainaive.com. */
  PUBLIC_URL: string
  MAIL_FROM: string
  /** Secret: signs sessions and the cookie cache. tela-web holds the same value. */
  AUTH_SECRET: string
  /** Secret: bearer token for /api/admin/*. */
  ADMIN_TOKEN?: string
  /** Secret: Resend's API key for sign-in mail. */
  RESEND_API_KEY?: string
  /** `test` for local e2e: mail goes to an outbox route instead of Resend. */
  ENV?: string
}
