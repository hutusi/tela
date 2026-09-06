# 0013 — Auth email carries the code, and its link makes a session

Status: accepted (2026-09-06). Amends ADR 0012, whose provider and session decisions stand.

## Context

ADR 0012 chose an email one-time code as the primary sign-in path. The login form asks for six
digits and verifies them with `verifyOtp`, but the project ran on Supabase's stock email
templates, which carry only `{{ .ConfirmationURL }}`. No code ever arrived, so the form had
nothing to verify. The link was no better: it goes through Supabase's verify endpoint and comes
back to `site_url` — the site root — with a PKCE code that nothing exchanges. The first real
sign-in attempt hit both symptoms at once, and the confirmation mail behind an admin invite hit
the same wall.

A PKCE code also only works in the browser that started the flow: exchanging it needs that
browser's verifier cookie. Mail is read wherever it is convenient, often on another device.

## Decision

- The templates live in the repository (`supabase/templates/{confirmation,magic_link,invite}.html`)
  and are applied by `supabase config push`, like the rest of the auth configuration (ADR 0014).
- The **code comes first** in the mail, as the primary instruction; the link sits below it.
- The link points at `/auth/callback` with a **token hash**, which the callback verifies directly
  rather than exchanging a PKCE code. It therefore works from any browser and any device.
- URL parsing lives in its own module with its own test, because a Next route file may only
  export handlers.
- The invite mail gets the same shape, and the callback accepts `type=invite`.
- `auth.rate_limit.email_sent` is 30 an hour: Supabase's built-in sender allows two, which no real
  sign-in traffic fits. Mail goes through Resend on a verified `ainaive.com`, well under the free
  plan's daily allowance.

## Consequences

- One mail serves both paths, so a reader who cannot paste a code can click, and a reader whose
  link opens in the wrong browser can type the code.
- The templates are reviewable and diffable; a Dashboard edit would be overwritten by the next
  push, which is the intended direction (ADR 0014).
- Deliverability to qq.com and 163.com is a Resend concern now, not Supabase's, and is still worth
  testing before Tela opens up.
- Alternatives considered: keeping the PKCE link and adding a code (the link still fails
  cross-browser, so the failure would just be rarer and harder to explain); a magic link only (no
  path at all for a reader whose mail client rewrites URLs).
