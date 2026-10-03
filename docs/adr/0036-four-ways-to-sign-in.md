# 0036 — Four ways to sign in: a code, a password, Google or GitHub, behind one invitation gate

Status: accepted (2026-10-02). Supersedes 0024's "Email codes only" and "OAuth is deferred"; the
rest of 0024 stands. Every new account still passes 0034's gate, whichever way it signs in.

## Context

A code costs a trip to the mailbox at every sign-in, and qq.com and 163.com sometimes deliver
slowly. The owner has decided that a member signs in by email code, password, Google or GitHub.

Each method is another way to create an account and another way into an existing one. 0034's gate
must hold for all of them, and none may become a way to take over a member. Tela's constraints
stay: D1 is batch-only, tela-api is reached only through tela-web, whose edge refuses
cross-origin writes, and part of the audience is in mainland China, where Google is unreachable
and GitHub unreliable. The code is the method that always works.

Two holes on main get worse with every method that falls back on the code:

- **The code is limited per IP only.** better-auth keys its limiter on IP and path, and collapses
  IPv6 to a /64, so a /48 holds 65,536 buckets. Each new code resets its three tries, and the code
  is stored before the mail goes, so a member's six digits can be guessed in minutes without
  reading their mail.
- **The mail's link signs in by itself.** `/login?email=&otp=` submitted the code as soon as it
  opened: a login CSRF. Someone who sends you a link to their own code puts you in their account,
  and a provider you then link there becomes a way into it that they can use.

## Decision

**Four methods, one gate.** Email code, password, Google and GitHub. The email code is always
offered; the owner's design puts the provider buttons above it, and a provider's button appears
only once its two secrets are set (`GET /api/v1/public/auth` says which), so with none configured
the sheet is the code alone.
Every new account passes 0034's `user.create.before`. Inside a better-auth endpoint, that hook
also refuses an email that is not verified (`emailVerified !== true`), and any endpoint but the
code sign-in and the OAuth callback. Only the admin route, which has no endpoint context, creates an
unverified row.

**On the OAuth path the invite rides in better-auth's OAuth state.** The sheet sends
`additionalData.invite` to `/sign-in/social`. A `hooks.before` on that path checks the code and
calls `addOAuthServerContext({invite})`, which better-auth stores in the state row it keeps in D1
for ten minutes, and documents as a channel the client cannot spoof. On the callback,
`getOAuthState()` reads it inside `create.before`. It is not a cookie: there is no extra cookie to
scope and clear, the invite dies with the state, it cannot be picked up by someone else's sign-in
on a shared browser, and a bad code is refused before the visitor is sent to the provider. The
callback is admitted by that code and nothing else (0034): a hold or an operator invitation the
address has is for the code sign-in, which proves the address, not for a provider. A refusal thrown
from the hook becomes `302 <errorCallbackURL>?error=<code>`: `invite_required` when the sign-in
carried no code, or `invite_unavailable` when the code filled up between the start and the
callback.

**An address is verified once, by a code or by the provider.** Google's `email_verified`, GitHub's
`verified` on the address it returns, or a code sent there. A password is only ever set on a member
whose address a code has proved: at join, where the code step offers "Choose a password", or later
from Settings. `/sign-up/email` stays closed (`emailAndPassword.disableSignUp`): signing up with a
password would create the user, and spend the invitation, before the address was proved, and leave
a row holding a stranger's password for the address's real owner to inherit. A forgotten password
is reset by code (`email-otp/request-password-reset`, then `email-otp/reset-password`), with a mail
of its own; that also adds a password for a member who had none, and revokes every session.
Passwords are 10 to 128 characters, hashed with better-auth's scrypt, which resolves to native
`node:crypto` under workerd's export condition. An unknown address and a wrong password get the
same 401 in the same time, since better-auth hashes for the unknown address too.

**Linking is explicit only.** `accountLinking.disableImplicitLinking` is on and no provider is
trusted (`trustedProviders: []`, since a trusted provider links without a verified email). A
provider's verification says the address was proved once, not who holds it today: an
ex-employee's GitHub still lists a company address, and a lapsed domain or a reclaimed mailbox has
a new owner. Implicit linking would let that person into the current member's account, with no code
and no notice. So a member adds Google or GitHub only from Settings → Account, on a fresh session.
A member who presses a provider button before linking it gets `account_not_linked` and "log in by
email, then link it in Settings"; a non-member whose provider address is unverified gets the same
code, so the redirect does not say who is a member. An explicit link may use another address
(`allowDifferentEmails`), since provider addresses often differ, and a member may unlink everything
(`allowUnlinkingAll`), since the code is always a way back in.

**A provider that makes an account is announced to its address.** The same doubt applies when a
provider creates the account: the account belongs to the address from then on, and whoever later
proves the address by code signs into it, with the provider still linked. That is why a provider's
sign-in is admitted only by the code it carried and never by the address's own hold, which someone
else may have placed and only a code from that mailbox should spend. And an account made through a
provider mails its address a security notice, the one every change in Settings → Account sends,
naming the provider: an owner who did not make it signs in by code, unlinks the provider and signs
out everywhere.

**The mail's link asks first.** `/login?email=&otp=` removes both from the address bar, fills them
in, and shows "Sign in as <email>" with a button. The reset link does the same.

**Nothing is kept from a provider but the identity.** No tokens: `account.create.before` and
`update.before` null every token, and `updateAccountOnSignIn` is off. No name or picture: the gate
returns `{name: '', image: null}`, so a member's real name from Google is never published on their
profile unless they choose it, and no third party's URL rides in the session cookie. Scopes are the
least that gives an address (`openid email`; `user:email`), and the hook on `/sign-in/social`
refuses a body with any key but the provider, the three return URLs, `disableRedirect` and
`additionalData.invite`, so a client cannot widen them. Signing in with an ID token, which has no
state, is off (`disableIdTokenSignIn`), and Google asks which account (`prompt: select_account`).
The state cookie lives 600 s, as long as its row; at better-auth's 300 s a provider's own sign-up or
2FA could outlast it. `disableOriginCheck: false` is written out, because better-auth skips its
return-URL checks under test otherwise, and the suite should run them. An error that comes before a
flow's own return URL is known lands on `/login` (`onAPIError.errorURL`), not on better-auth's own
error page.

**`/api/auth/*` serves only the endpoints Tela uses.** An allow-list replaces the catch-all:
`GET get-session`; `POST` the code send and sign-in, `sign-in/email`, the two reset steps and
`sign-in/social`; `GET callback/google` and `callback/github`; and the guarded `sign-out`.
Everything else is a 404. That also closes `/update-user`, which today lets a member put any URL in
`user.image`, and so in the session cookie.

**Limits per address, not only per IP.** Tela adds its own, keyed on the lowercased address, in a
`hooks.before` over `action_limits`: five codes mailed and ten codes checked an hour, and ten
password sign-ins in fifteen minutes, beside five a minute per IP. The code counts cover every
endpoint that sends or checks one, whatever it is for: a reset code is as good as a sign-in code
to someone guessing, since the right one gives the account a password, so both reset steps count
against the same five and ten as sign-in. They count for any address, so a 429 says nothing about
who is a member. Calls Tela makes through `auth.api.*` (`/api/v1/join`,
`/api/v1/account/*`) never pass better-auth's limiter, so those routes carry limits of their own.
A wrong code is answered alike too. better-auth answers `403 TOO_MANY_ATTEMPTS` for a code tried
three times and `400 OTP_EXPIRED` for one past its hour, and both need a stored code, which only an
address the mail gate admits ever has; a stranger hears `400 INVALID_OTP` every time. So tela-api
answers both as that `INVALID_OTP`, byte for byte, on the sign-in and the reset (`asWrongCode` in
`app.ts`), and the fourth wrong try no longer says who is a member.

**A member manages their ways in under `/api/v1/account`**: what they have (their address, whether
they have a password, which providers are linked, whether the session is fresh), set or change a
password, link, unlink, and sign out everywhere. These are live RPC answers, not synced rows: they
are security state, decided on the server, and a device's copy of them would be out of date exactly
when it matters. Every call reads the session from D1 (`disableCookieCache`), because a session a
reset or "sign out everywhere" revoked lives on in the five-minute signed cookie elsewhere. Adding a
method needs a session made within the last day (`freshAge`) and revokes the member's other
sessions; changing the password needs the current one. A link is written at the provider's return,
where better-auth trusts the OAuth state and its cookie alone, so Tela writes it only for a browser
that still holds a live session of the member's, read from D1 (`account.create.before`): a session
that "sign out everywhere" or a reset ended while the provider was asking must not finish the link
it started, and then sign out the member who ended it. Every change mails the member a security
notice, so a method someone else added does not go unnoticed. Each change is limited per member;
ending the other sessions is not, since anyone holding one of the member's sessions could spend the
count, and so keep the member from ending it.

**Why `create.before` and not `validateUserInfo`.** better-auth 1.7.6 has a hook made for this:
`user.validateUserInfo` is told the method (`oauth`) and the action (`create-user`, `link-account`
or `sign-in`), which would replace matching an endpoint's path. It requires an endpoint context,
though, and the admin route creates its user outside one, where it throws
`validation_context_missing`. `create.before` runs on every path. The price is the path check, so
the verified-email check is made strict for every creation inside an endpoint: a way in that
better-auth adds later (One Tap, an ID token) is refused rather than trusted.

## Consequences

- Google is unreachable from mainland China and GitHub is unreliable there. The sheet shows the
  provider buttons first, as the owner's design does, and the email code below them on the same
  sheet, always there and always working, so a reader who cannot reach Google signs in without
  leaving it.
- A provider can still make the account for an address its holder no longer owns. Someone whose
  Google or GitHub account still lists the address as verified, and who has a code (any member's,
  or an operator code guessed), can create that address's account before its owner joins, and
  sign in with the provider after. When the owner joins, `/join` finds an account and sends a plain
  sign-in code, and they land in it. The notice to the address is what warns them; until they
  unlink the provider, the other person keeps a way in. Requiring a code from the mailbox at a
  provider's first sign-in would close this, at the price of the trip to the mailbox a provider is
  there to save.
- Settings → Account needs the network, as the Dashboard does.
- Revoking a session is still not instant everywhere: every route but `/api/v1/account/*` trusts
  the five-minute signed cookie (0024), so a revoked session keeps working elsewhere for up to five
  minutes.
- Each hash costs one blocking scrypt (N=16384, r=16) and about 32 MiB on workerd. It is measured
  on the first deploy; if it is too dear, the fallback is a `node:crypto` scrypt with r=8 behind a
  versioned prefix. The D1 suite proves a password round trip in workerd. Hashes are written alike
  under workerd, Bun and Node, so they survive leaving Cloudflare (0021).
- A better-auth upgrade must keep five behaviours, each pinned by a test: a thrown `APIError` in
  `create.before` becomes a callback redirect carrying its code; `addOAuthServerContext` reaches the
  callback; a `false` from `account.create.before` at a link's return writes nothing and redirects
  with `unable_to_link_account`; a reset creates a credential account; `setPassword` stays
  server-only.
- `account` gains a unique index on `(provider_id, account_id)`, which `auth generate` does not
  make. Without it two links at once can write a duplicate, and better-auth then refuses that
  identity for good.
- The state cookie, like the session cookies, carries the `__Secure-` prefix, which allows a
  `Domain` attribute, so any `*.ainaive.com` host could plant one. `__Host-` would sign everyone out
  once and change the cookie names the edge reads (0035); it is a follow-up.
- The answers are alike, the time they take is not. A code or a reset asked for an address the
  gate admits answers once Resend has taken the mail (better-auth awaits the send, having no
  background handler), and one for any other address after a single delete in D1: a difference of
  a Resend round trip, which someone timing many requests can see. Closing it means sending the
  mail after the answer, through the request's `waitUntil`: better-auth takes one
  `backgroundTasks.handler` for the whole app, so the Worker entry would hand each request's
  `ExecutionContext` to it through `AsyncLocalStorage`, and every test and e2e that reads the
  outbox right after the answer would have to wait for the mail instead. Left for now: the gate
  admits only members and invited addresses, the per-address limits allow five sends an hour, and
  the private beta is small.
- A provider's start refuses a full code before the visitor leaves (409 `INVITE_USED`), which
  is right for nearly everyone, but not for the one address whose own claim on a single-use code
  was written when the account create after it failed: the code counts as full, and the retry
  with the same provider is refused, though `claimByCode` at the return would re-admit that
  address by its own row. The start cannot tell, since it does not know the address yet. The way
  back is the email join, which answers `held` for that row and whose code sign-in re-admits it.
  Letting the start through on a full code would send every other visitor holding one to the
  provider only to be refused on return; deferred until a failed create is seen in production.
- The operator registers the OAuth apps, with the redirect URI
  `https://tela.ainaive.com/api/auth/callback/<id>`; Google's consent screen needs the privacy page
  (0035). A provider stays off until both its secrets are set.
