import type { Fetcher, R2Bucket } from '@cloudflare/workers-types'

/** tela-web's bindings: no D1, by design (ADR 0020). */
export type Env = {
  /** Members-only content objects (`c/`, `t/`, `tc/`), read-only here. */
  BLOBS: R2Bucket
  /** tela-api, pinned beside D1. */
  API: Fetcher
  /** The SPA's built static assets. */
  ASSETS: Fetcher
  /** Secret: the same value tela-api signs sessions with. */
  AUTH_SECRET: string
  /** `1` while in private beta: robots disallow and noindex on everything (ADR 0015). */
  TELA_PRIVATE_BETA?: string
}
