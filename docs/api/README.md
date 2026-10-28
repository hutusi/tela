# Tela's API for apps

Tela is a reader for independent blogs, at <https://telaread.com>. This API lets an app you build
act for a Tela member: read their subscriptions and posts, keep their reading in sync, change it
for them, and browse Tela's public side. It is meant for full reading clients, such as a desktop
app or a command-line tool.

- **Base URL:** `https://api.telaread.com`
- **Version:** v1, in **preview** (see [policy.md](policy.md)): it can still change in ways that
  break an app, with 14 days' notice to every live app's developer.
- **Who may use it:** any Tela member may register an app, in Settings → Developer. Tela's
  operator reviews apps when their developers ask, and handles reports of them.

## How it works

1. You register your app in Settings → Developer on telaread.com and get a `client_id`
   (`tela_app_…`) at once.
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

- **`read`:** see the member's subscriptions and folders, posts and their bodies, reading state,
  likes, recommendations, highlights, the people they follow and their reading preferences, and
  browse the public side.
- **`write`:** all of that, and change it: mark posts read, like, subscribe, add feeds, highlight,
  recommend, follow, file blogs in folders, change reading preferences, and ask for translations
  (which count toward the member's daily translations).

Beside either, an app may ask for **`email`**, the member's address, once Tela has reviewed it and
the operator allows it.

No app can delete the account, change how the member signs in, download their data, edit their
profile or privacy switches, invite people, claim blogs, or do anything an admin does. An app is
never an admin, even when the member is Tela's operator, and it is held to the same daily limits
as any member.

## Registering an app

Sign in to <https://telaread.com> and open **Settings → Developer**. Register the app with:

- its name, and who makes it (a person or a company). Only Tela's own apps may use the word
  "Tela" in either, and neither may hold invisible characters. Your Tela handle is shown beside an
  unreviewed app, so a handle that says "Tela" can't register one either;
- a contact address that receives mail: changes to the API and anything about your app are sent
  there. Members never see it;
- a homepage and a privacy policy, both `https://`. Members see both before they connect, and an
  app needs its privacy policy before it goes Live;
- your redirect URIs (see [authorization.md](authorization.md#redirect-uris)): a loopback address
  such as `http://127.0.0.1/callback`, your own reverse-DNS scheme such as
  `com.example.reader:/callback`, or both;
- the most it needs, `read` or `write`.

You accept the developer rules ([policy.md](policy.md#rules-for-developers)) when you register. A
member may hold up to 5 apps, and make ten changes to them a day (registering, editing, Live,
Testing, review requests and deletes together).

## Testing, then Live

A new app starts in **Testing**: only your account can connect it, on the real `telaread.com`.
Build and test against your own subscriptions; Testing has the same limits and rules as Live.
When you are ready, make it **Live** in Settings → Developer, and any member can connect it. Your
`client_id` stays the same. Going back to Testing ends every other member's connection.

Use a separate Tela account for testing if you do not want your own reading changed by a buggy
build.

## Reviews

Tela's operator doesn't check apps before they go Live. An app Tela has not reviewed:

- is shown to members as **"Not reviewed by Tela"**, with your Tela handle;
- may be connected by at most **100 members at once**, counted across all of your unreviewed apps
  (your own connection is free);
- can't ask for the member's email address.

Ask for a review in Settings → Developer, with a note on what the app does and whether it needs
members' email addresses, and why. A review lifts the limit and may allow the email permission.
Changing anything members read on a reviewed app (its name, developer, homepage, privacy policy,
redirect URIs or scope) clears its review, and you can ask again. Members already connected stay
connected.

Members can report a Live app from the page where they connect it and from their connected apps.
While a report is open, the app can't be edited or deleted. The
operator may cut an app off for everyone at once: its tokens are refused until it is restored
(see [authorization.md](authorization.md)).

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
- [v1/examples/](v1/examples/): example answers for `/meta` and every JSON route under `/v1/`
  except `/v1/bodies`, with a few refusals. The test suite holds the API to these, so they are
  what the API returns. There are none for the content: a body, a finished translation and a
  chunk (`/v1/bodies`, `/o/…`) follow `contentObjectSchema`, `translationObjectSchema` and
  `translationChunkSchema` in `packages/ext/src/schema.ts`, and `/img/…` answers the image itself.
  The OAuth endpoints' answers are in [authorization.md](authorization.md).

Tela's own code is open: the formats are `packages/ext/src/schema.ts` in the repository, and the
decisions behind the API are ADRs 0064–0066 in `docs/adr/`.
