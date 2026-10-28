# Versions, support and rules

## Versions

- **The major version is in the path:** `/v1/…`. Every answer says which version answered it, in
  `Tela-API-Version`: `1` for everything under `/v1/`.
- **Within a version, changes are additive.** New routes, new fields in an answer, new optional
  fields in a request, new values of an enum documented as open (marked `x-extensible-enum` in
  [openapi.json](openapi.json)), and new mutation types announced in `/meta`'s `features`. An app
  that ignores what it does not know keeps working.
- **New sync row types are opt-in.** A pull that leaves out `types` gets v1's default set, the
  fourteen types v1 started with, and that set never grows within v1. A type added later is sent
  only to an app that asks for it by name.
- **Anything else is a new major version:** a field removed or renamed, a field's meaning or type
  changed, a closed enum changed, a route removed, a limit made stricter in a way an app cannot
  read from `/meta`.
- **Content objects are not versioned by the path.** Bodies, translations and their chunks are
  immutable, and each carries its own `format`. A new format is announced like a new version, and
  an object once made never changes.

The examples in [v1/examples/](v1/examples/) are what the API answers on the routes they cover
(`/meta` and the JSON routes under `/v1/` but `/v1/bodies`): Tela's test suite fails when an answer
moves away from them, so a change to the API is a decision, never an accident. Content objects
have no examples: their schemas in `packages/ext/src/schema.ts` describe them, and their `format`
says which version of those they follow.

## Preview

v1 is in **preview** now. During preview:

- a change that breaks apps can still happen, with **14 days' notice** to every live app's
  developer;
- the support period below does not bind yet.

v1 becomes **stable** once Tela's own desktop app has run on it for four weeks without needing a
breaking change. `/meta` and [CHANGELOG.md](CHANGELOG.md) will say so.

## Support, once stable

- A breaking change becomes a new major version, announced at least **3 months** before the old
  one is deprecated.
- The old version keeps answering for **12 months after its successor ships**.
- For at least the last **6 months** of that, its answers carry `Deprecation` (RFC 9745) and
  `Sunset` (RFC 8594) headers, and `/meta` gives its `sunsetAt`. Tela adds these headers when a
  version is deprecated; none is yet, so no answer carries them today.
- A security or legal problem may need a change sooner. Tela will explain why, and give as much
  notice as it safely can.

## Notice

Every change that needs an app to act is announced in three places:

- an email to each live app's contact address;
- [CHANGELOG.md](CHANGELOG.md) in this folder;
- `/meta`: a version's `status` and `sunsetAt`, and its `features`.

Keep your contact address current: change it in Settings → Developer.

## Rules for developers

You accept these when you register an app in Settings → Developer. An app that breaks them can be
cut off, for every member at once, and its developer's account suspended.

- **Your app is yours.** Registering it doesn't make Tela responsible for it. Tela doesn't check an
  app before it goes Live; a review, when you ask for one, checks that it does what it says, and
  lifts the limits on unreviewed apps (see [README.md](README.md#reviews)). Changing anything
  members read on a reviewed app (name, developer, homepage, privacy policy, redirect URIs or
  scope) clears its review.
- **Don't pass for Tela.** Only Tela's own apps may use the word "Tela" in their name or
  developer, or write it with look-alike letters or hidden characters.

- **Be who you say you are.** The name, developer, homepage and privacy policy members see on the
  consent page are yours, and accurate.
- **Have a privacy policy**, and follow it. What your app stores is your responsibility, not
  Tela's: say what you keep, where, for how long, and how a member has it deleted.
- **Ask only for what you need.** `read` unless your app changes things; `email` only if you use
  the address, and say what for.
- **Connect through the member's browser.** Never ask a member for their Tela password, and never
  show `/connect` in a web view inside your app.
- **Keep tokens in the operating system's credential store**, never in plain files, logs, crash
  reports or URLs. Revoke tokens your app no longer needs, and when a member signs out of your app.
- **When a connection ends, stop.** Delete what you stored for that account, or ask the member
  what they want, as your privacy policy says.
- **Respect writers' choices.** Never show a translation of a blog whose writer turned translation
  off, and delete the ones you hold when they do. Show each post with its blog's name and a link
  to the original.
- **Respect the limits.** Do not work around the daily limit on posts from blogs a member does not
  follow, the rate limits, or any other limit: no prefetching posts of blogs the member does not
  subscribe to, no spreading requests across accounts, no copying Tela's archive.
- **Respect members.** Act only on what the member asked your app to do. Do not use one member's
  data for another, or show anything they keep private (highlights, notes, reading history) to
  anyone else.
- **Handle errors.** Wait for `Retry-After`, back off on failures, and do not retry a request that
  was refused for a reason a retry cannot change.
- **Tell Tela about problems.** If you find a security problem, write to <mailto:me@hutu.si>
  before telling anyone else.
