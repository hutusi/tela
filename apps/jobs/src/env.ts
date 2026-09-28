import type { D1Database, Fetcher, Queue, R2Bucket } from '@cloudflare/workers-types'
import type { JobMessage } from './kinds'

/** The tela-jobs Worker's bindings, vars and secrets (wrangler.jsonc; secrets via wrangler). */
export type Env = {
  DB: D1Database
  BLOBS: R2Bucket
  /** The public asset bucket (favicons), served at assets.<domain>; absent disables favicons. */
  ASSETS?: R2Bucket
  /** This Worker itself: cron and queue handlers call its pinned fetch handler through it. */
  SELF: Fetcher
  FETCH_QUEUE: Queue<JobMessage>
  EXTRACT_QUEUE: Queue<JobMessage>
  TRANSLATE_QUEUE: Queue<JobMessage>
  MISC_QUEUE: Queue<JobMessage>
  WORKER_USER_AGENT?: string
  FETCH_TIMEOUT_MS?: string
  /** Origin of the HK relay; unset means feeds never change region. */
  RELAY_URL?: string
  RELAY_SECRET?: string
  RELAY_CONTROL_URL?: string
  /** `1` records WebSub hubs so the subscribe sweep follows them. */
  WEBSUB_ENABLED?: string
  /** Public origin of the web app: claim rel="me" targets and the WebSub callback. */
  PUBLIC_URL?: string
  /** Translation provider (bailian, anthropic, mock) and its key; see the environment table. */
  LLM_PROVIDER?: string
  LLM_MODEL?: string
  BAILIAN_API_KEY?: string
  BAILIAN_BASE_URL?: string
  ANTHROPIC_API_KEY?: string
  LLM_JSON_MODE?: string
  /** Daily token budget for background (title) work; 0 = unlimited. */
  LLM_DAILY_BUDGET_TOKENS?: string
  /** Source tokens translated per article body before the rest renders as source. */
  LLM_MAX_ARTICLE_TOKENS?: string
}
