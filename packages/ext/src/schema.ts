/**
 * The v1 API's documented formats as zod schemas (ADR 0065): one per route, the source of
 * `docs/api/openapi.json`. Filled in their own slice; apps never import this, the gateway's
 * handlers and the contract suite do.
 */
import { z } from 'zod'
import { API_ERRORS } from './transform'

/** Every error answer: `{ "error": code }`, with more fields where a route documents them. */
export const errorSchema = z.looseObject({ error: z.enum(API_ERRORS) })
