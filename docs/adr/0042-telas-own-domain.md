# 0042 — Tela's own domain

Status: accepted (2026-10-07). Tela moves from `tela.ainaive.com` to `telaread.com`. It is still the
only origin the app is served from; the old address and `www` only redirect to it.

## Context

Tela was served from `tela.ainaive.com`, a subdomain of the maker's own domain (About keeps that
mark). The owner bought `telaread.com`, a zone in the same Cloudflare account, so the reader can
have a name of its own before invitations widen. At the move there is one member and two
sessions. Some links to the old address are already out, though: invite links, profiles,
`/s/:id` shares, and the sign-in links in mail already sent. Those have to keep working.

Changing a host name is usually a redirect rule. Here a redirect rule would never reach the
people it is for. The shell's service worker (`public/sw.js`, ADR 0025) answers every navigation
from the shell it cached, so a browser that had ever visited the old address, a visitor's
included, would keep painting the old app. Its calls to `/api/*` would then be redirected to
another origin and fail as CORS errors, which the app reads as being offline (only a 401 means
signed out). And the browser's update check for the worker refuses a redirected script, so the old
worker could never replace itself. Members and visitors would have to clear site data by hand.

## Decision

**The apex, `https://telaread.com`, is the one origin.** tela-web's custom domain moves there, and
`PUBLIC_URL` follows it on tela-api and tela-jobs. That one variable sets better-auth's base URL
and trusted origin, the links in mail, the claim page's `rel="me"`, and the WebSub callback.
Favicons move to `assets.telaread.com`, an R2 custom domain on `tela-assets`. The old
`assets.tela.ainaive.com` stays attached so that nothing pointing at it breaks.

**A fourth Worker, `tela-redirect` (`apps/reader/redirect`), answers the old address and
`www.telaread.com`.** It redirects every request to the same path and query on the origin: 301,
or 308 for a method other than GET or HEAD. The one exception is `/sw.js`, which it answers 200
with the code of the existing kill switch (`shell/kill-sw.js`). On the next visit, the browser's
update check installs the kill switch, which drops every cached shell, unregisters the worker and
navigates each open tab again. That navigation reaches the network and the redirect. A test holds
the served code to the kill switch's file, and `redirect.e2e.ts` runs the whole retirement in
Chromium: the real shell worker installed, a plain redirect that leaves it painting, then the kill
switch that takes two open tabs to the new origin. Its logs keep paths and drop query strings
(`redact_query_string`): an old invite or sign-in link carries its code in the query, and anyone
who reads Workers Logs could use it. That is the same reason tela-web never runs for `/*`.

It is a Worker of its own, not a branch in tela-web, because it must run for every request on
those hosts, and tela-web runs only for the paths `run_worker_first` lists. Listing `/*` there is
refused for its own reasons (ADR 0035, AGENTS.md). It is not a dashboard rule either: one Worker
does both jobs, is deployed from the repository, and is tested.

**The old address redirects for as long as the maker holds `ainaive.com`.** A browser that has not
visited in months still holds the old worker, and only `/sw.js` can retire it.

**Mail follows once its domain is verified.** Sign-in mail keeps coming from
`noreply@ainaive.com`, which Resend has verified, until `telaread.com` is verified there too; then
`MAIL_FROM` changes in a deploy of its own. So the move does not wait on DNS for mail.

## Consequences

- Cookies and IndexedDB belong to an origin, so every member signs in again on telaread.com, and
  each device takes a snapshot as on a first sign-in. Changes a device made offline and never
  pushed stay in the old origin's copy, and nothing reads that copy any more. With one member,
  who syncs every device before the move, nothing is lost.
- An installed app (the manifest's `start_url` was on the old origin) opens the redirect,
  which takes it to the new origin outside its scope. It has to be installed again from
  telaread.com.
- The cutover has two short gaps. tela-web's deploy replaces its custom domains with the list in
  its config, so it releases the old address, which stays dark until tela-redirect's deploy
  takes it, about a minute later. And between the tela-api and tela-web deploys, a sign-in on
  either host fails the origin check. Both are acceptable with one member and are noted in
  OPERATIONS.
- The session cookies sit on a registrable domain that holds only Tela's hosts (the app, the
  redirect, the R2 bucket). ADR 0036's note that any `*.ainaive.com` host could plant a
  `__Secure-` cookie now applies only to hosts Tela runs. `__Host-` remains a follow-up.
- OAuth apps, not registered yet, are registered against telaread.com from the start (ADR 0036's
  redirect URI becomes `https://telaread.com/api/auth/callback/<id>`).
- `noindex` stays while `TELA_PRIVATE_BETA` is set; the new name changes nothing about the beta.
