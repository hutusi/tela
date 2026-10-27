# Tela's API for apps

Tela is a reader for independent blogs, at <https://telaread.com>. This API lets an app you build
act for a Tela member: read their subscriptions and posts, keep their reading in sync, change it
for them, and browse Tela's public side. It is meant for full reading clients, such as a desktop
app or a command-line tool.

- **Base URL:** `https://api.telaread.com`
- **Version:** v1, in **preview** (see [policy.md](policy.md)): it can still change in ways that
  break an app, with 14 days' notice to every approved app's developer.
- **Who may use it:** apps Tela's operator has approved. There is no self-service registration
  yet.

## How it works

1. You register your app with the operator and get a `client_id` (`tela_app_…`).
2. Your app sends the member's browser to `https://telaread.com/connect`. They sign in to Tela
   there, if they are not already, and see your app's name, developer and privacy policy, what it
   asks for, and what no app can do. They approve or decline.
3. The browser comes back to your app with a code, which your app exchanges for tokens at
   `https://api.telaread.com/oauth/token`. The member never gives your app a password.
4. Your app calls the API with the access token, refreshes it hourly, and keeps working offline
   between syncs, as Tela's own web app does.

[authorization.md](authorization.md) walks through the flow, and [v1.md](v1.md) describes every
route.

## What an app can and cannot do

An app asks for one of two levels, and the member may lower it:

- **`read`:** see the member's subscriptions, posts, reading state, likes, recommendations,
  highlights, folders and the people they follow, and browse the public side.
- **`write`:** all of that, and change it: mark posts read, like, subscribe, add feeds, highlight,
  recommend, follow, file blogs in folders, and ask for translations (which count toward the
  member's daily translations).

Beside either, an app may ask for **`email`**, the member's address, if the operator allows it.

No app can delete the account, change how the member signs in, download their data, edit their
profile or privacy switches, invite people, claim blogs, or do anything an admin does. An app is
never an admin, even when the member is Tela's operator, and it is held to the same daily limits
as any member.

## Getting an app approved

Write to the operator at <mailto:me@hutu.si> with:

- the app's name, and who makes it (a person or a company);
- a contact address that receives mail: approval, changes to the API and anything about your app
  are sent there;
- a homepage and a privacy policy, both `https://`; members see both before they connect;
- your redirect URIs (see [authorization.md](authorization.md#redirect-uris)): a loopback address
  such as `http://127.0.0.1/callback`, your own reverse-DNS scheme such as
  `com.example.reader:/callback`, or both;
- the most it needs, `read` or `write`, and whether it needs the member's email address, and why;
- your Tela handle, so the app can be registered as a draft on your account first;
- if you expect more than 120 requests a minute per member, or 6,000 a minute in all, how many.

## Testing with a draft

There is no sandbox. A new app is registered as a **draft** owned by your Tela account: only your
account can connect it, on the real `telaread.com`, and the consent page says it is not yet
approved. Build and test against your own subscriptions; the draft has the same limits and rules
as an approved app. When you are ready, ask for approval, and every member can connect it. Your
`client_id` stays the same.

Use a separate Tela account for testing if you do not want your own reading changed by a buggy
build.

## Reference

- [authorization.md](authorization.md): connecting, tokens, refreshing, revoking, and when a
  connection ends.
- [v1.md](v1.md): conventions, `/meta`, sync and offline, mutations, bodies and images, the daily
  limits, translations, adding feeds, the public side, errors and rate limits.
- [policy.md](policy.md): versions, how long one is supported, notice, and the rules for
  developers.
- [CHANGELOG.md](CHANGELOG.md): what changed in the API, newest first.
- [openapi.json](openapi.json): the OpenAPI document, generated from the same schemas the API
  checks its answers against.
- [v1/examples/](v1/examples/): an example answer for every route. The test suite holds the API to
  these, so they are what the API returns.

Tela's own code is open: the formats are `packages/ext/src/schema.ts` in the repository, and the
decisions behind the API are ADRs 0064–0066 in `docs/adr/`.
