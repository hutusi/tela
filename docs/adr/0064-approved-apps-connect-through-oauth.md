# 0064 — Approved apps connect through OAuth, and are never admin

Status: accepted (2026-10-27). Builds on 0024 (better-auth and tela-api), 0056 (runtime settings),
0058 and 0059 (closing and suspending an account). The API they call is 0065; the limit they share
on posts from unfollowed blogs is 0066.

## Context

The owner wants full-featured Tela clients built by other developers, a desktop app first, and
command-line tools. Not a public API yet: only apps the operator approves may connect. A member
must connect one without ever handling a password or a token.

Nothing Tela had could do it:

- **Sessions are cookie-only** (better-auth, ADR 0024), and the cookies are host-only.
- **better-auth 1.7.6 has no OAuth or OIDC provider.** Its device-authorization plugin mints an
  ordinary `session` row: a full member session, with no app, no scope, the member's admin flag,
  and every session-ending path wiping it for reasons unrelated to apps.
- **A token that is a session is a key to everything:** account changes, export, the admin
  console. The brief says an app can do none of those, and is never admin even when the member is
  the operator.

## Decision

**A small OAuth 2.1 authorization server of Tela's own, in tela-api, for public native clients
only** (RFC 8252). Authorization code with PKCE (S256, required), RFC 7009 revocation, RFC 8414
metadata, and RFC 9207 `iss`. No implicit grant, no password grant, no client secrets: a desktop
app cannot keep one.

- **The issuer is `https://api.telaread.com`.** Its token and revocation endpoints are there, behind
  tela-gateway (0065).
- **The authorization endpoint is `https://telaread.com/connect`,** a page of the reader, because it
  needs the member's session. It shows:
  - the signed-in account, with a way to switch;
  - the app, its developer, homepage and privacy policy;
  - where it returns to;
  - "Read only" or "Read and write" as asked (a member may lower write to read);
  - the email address only when the operator allows the app to ask and it asks;
  - the fixed list of what no app can do;
  - that what the app stores is the app's responsibility.

  It always asks, even when a connection exists: a public `client_id` can be used by any local
  process, so a silent re-approval would hand tokens to anything posing as the app (RFC 8252 §8.6).
- **Redirects:** a loopback redirect (`127.0.0.1`, `[::1]`) matches on any port, and a registered
  custom scheme is allowed. `localhost` is not. A bad client or redirect shows an error and never
  redirects.
- **The code is the only credential in a URL.** It is single-use, lives two minutes, and is bound to
  its PKCE challenge and redirect. The exchange is one batch. A replayed code ends the tokens it
  made.
- **Tokens:**
  - `tela_at_…` is an access token, for an hour.
  - `tela_rt_…` is a refresh token, swapped on every use by one conditional update, and ended after
    90 days unused.
  - Only SHA-256 hashes are stored.
  - Every replaced refresh hash is kept: one coming back is reuse, and ends that device.
  - The one exception is a lost answer. Within two minutes, and only while its replacement has not
    been used, the previous token is swapped again.
- **Two levels: `read` and `write`, which includes read.** Asking for a translation needs `write`:
  it spends the member's day. The effective scope is the lower of the token's and the app's
  ceiling, so the operator lowering an app reaches live tokens at once.

**An app is never admin in any way.** The principal a token resolves to is `{userId, appId,
scope}`, and the API's shared functions take `exempt: false` for it (0065): no admin route, no
`is_admin` in any answer, and no exemption from member limits, even for the operator's own account.
Internal routes never accept a bearer token, and better-auth's `bearer` plugin is never enabled.

**Connections end wherever Tela ends a member's other sessions, in the same batch**
(`endConnectionsSql`). That covers:

- password set, change and reset;
- linking Google or GitHub;
- sign out everywhere;
- the console's sign-out and suspension;
- closing the account.

The member disconnects an app in Settings → Connected apps. The operator can end an app's
connections, cut the app off for everyone (suspend: tokens refused until restored), or stop every
app with `apps.enabled`.

**The operator registers apps in the console** (Apps area):

- an app has a name, developer, contact, homepage, privacy policy, redirects, a scope ceiling,
  whether it may ask for the email, and per-app limits;
- a draft app connects only for its owner's account, so a developer tests on production with their
  own;
- approve, cut off and restore are undoable; ending connections is not.

## Alternatives considered

- **better-auth's device plugin as the flow.** Its token is a session: no scope, no app, the admin
  flag, and wiped by unrelated session changes. Rejected.
- **The device-code flow (RFC 8628) for tools without a browser.** Designed for (a `device` grant
  type and code kind are reserved), not built. It is a known phishing route, and command-line tools
  on a machine with a browser use the loopback redirect.
- **JWT access tokens.** Every request would still need a revocation check against D1, which is
  six to ten milliseconds from tela-api. An opaque token resolved in one statement is simpler and
  ends at once.

## Consequences

- A token is resolved in one batch that also counts the app's rate limits and stamps when it was
  last used (hourly), so "last used" costs no extra round trip.
- Tokens, spent hashes and codes are left out of the nightly export. After a restore, apps connect
  again.
- App tokens for scripts (`kind = 'personal'`) and the device flow fit the same tables and
  principal when they are built.
