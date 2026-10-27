import type { Fetcher, R2Bucket } from '@cloudflare/workers-types'

/** tela-gateway's bindings (ADR 0065): no assets, no D1, no secrets. */
export type Env = {
  /** Members' content objects (`c/`, `t/`, `tc/`), read-only here: the bucket tela-web reads. */
  BLOBS: R2Bucket
  /** tela-api, pinned beside D1, which serves the app surface under `/gateway/*`. */
  API: Fetcher
}
