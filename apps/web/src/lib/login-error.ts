/** The shape of a Supabase `AuthError` that matters here; `code` is absent on older GoTrue replies. */
export type LoginAuthError = { code?: string; status?: number; message?: string }

/** Keys under `login.errors` in the message catalogs. */
export type LoginErrorKey = 'not_invited' | 'not_configured' | 'send_failed'

/**
 * Which message a failed `signInWithOtp` should show.
 *
 * Branch on GoTrue's `error_code`, never on the HTTP status. 422 is its generic unprocessable
 * status, so "this address has no account" and "email sign-in is switched off" arrive with the
 * same 422 — and treating every 422 as the former told a member with a working account that they
 * had never registered, while the real cause was a disabled provider (ADR 0015).
 *
 * Anything unrecognised is `send_failed`, which is honest about not knowing. `not_invited` is
 * reserved for the one code that actually means it, because it is the only message that blames
 * the person reading it.
 */
export function loginErrorKey(error: LoginAuthError): LoginErrorKey {
  switch (error.code) {
    // shouldCreateUser: false and no such account — the genuine private-beta refusal.
    case 'otp_disabled':
      return 'not_invited'
    // The email provider is off, or Auth has no way to send: the server is misconfigured.
    case 'email_provider_disabled':
    case 'email_not_confirmed':
    case 'signup_disabled':
      return 'not_configured'
    case undefined:
      break
    default:
      return 'send_failed'
  }
  // Pre-`code` GoTrue: match the message it used for the no-account case only, and let every
  // other wording fall through rather than guessing.
  return /signups? not allowed/i.test(error.message ?? '') ? 'not_invited' : 'send_failed'
}
