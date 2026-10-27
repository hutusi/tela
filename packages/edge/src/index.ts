/**
 * What tela-web and tela-gateway both serve at the edge (ADRs 0065, 0066): content objects,
 * bundles and the image proxy, each behind an `authorize` step that asks tela-api whether this
 * member, or this app acting for one, may have these keys; and the colo-cache facts both keep
 * about those answers.
 */
export type { OpensDecision, OpensRefusal } from '@tela/shared'
export {
  type Authorization,
  type Authorize,
  BUNDLE_MAX,
  CONTENT_KEY,
  type Content,
  type ContentDeps,
  contentKeyOf,
  createContent,
  OBJECT_CACHE,
  refusal,
} from './content'
export {
  CACHE_ORIGIN,
  createMarks,
  type EdgeCache,
  type Marks,
  nextUtcMidnight,
  readAtMost,
  safeDecode,
  settle,
  sha256Hex,
  utcDay,
  type Waiter,
} from './marks'
