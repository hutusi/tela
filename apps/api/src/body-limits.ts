/** The most a request body may hold (`bodyCap` in `app.ts`), and what the API's `/meta` says. */

/** The most any request body may hold unless its route says otherwise: every JSON call is small. */
export const BODY_MAX_BYTES = 64 * 1024
/**
 * A push: fifty changes, and a highlight's quote and note are 2,000 characters each, which in
 * Chinese or emoji is up to 16 KB a change.
 */
export const PUSH_MAX_BYTES = 1024 * 1024
