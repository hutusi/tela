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
  /**
   * `1`: nothing is indexed: robots.txt disallows everything and every answer carries noindex
   * (ADRs 0015, 0060). Apart from the sign-up mode: set until launch day, whatever sign-up says.
   */
  TELA_NOINDEX?: string
}
