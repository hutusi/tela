/**
 * What tela-web and tela-gateway both serve at the edge (ADRs 0065, 0066): content objects,
 * bundles and the image proxy, each behind an `authorize` step that asks tela-api whether this
 * member, or this app acting for one, may have these keys. Moved here from
 * `apps/reader/worker/edge.ts` in its own slice.
 */
export type { OpensDecision, OpensRefusal } from '@tela/shared'
