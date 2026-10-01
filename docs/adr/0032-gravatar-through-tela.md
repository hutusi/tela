# 0032 — A member's picture is their Gravatar, served from Tela's origin

Status: accepted (2026-10-01). Amends 0031, whose people are drawn only as a letter in a circle.
Uploaded pictures are still not built; they are the next step, and this leaves room for them.

## Context

0031 drew every member as the first letter of their name on a colour of their own. That is
recognisable, but only as far as an initial can be: two Johns look alike, and a face is what
readers know an author by elsewhere.

Most people who blog already have a picture on Gravatar, keyed by their email address, and Tela
signs members in by email. So no upload is needed to show one: the address is enough.

Linking to `gravatar.com/avatar/<hash>` from a page, the way every npm package for this does,
costs three things Tela is not willing to pay:

- **gravatar.com is blocked in mainland China**, which is part of the audience this product is
  built for. The picture would hang and then fail there, as `workers.dev` does (the reason that
  is off).
- **The hash would be public.** Every public profile is a page anyone can fetch, and a hash of an
  email is not a secret: common addresses fall to guessing, SHA-256 or not. Tela publishes no
  email today.
- **Every visit would reach a third party.** A reader opening a profile would tell Gravatar who
  they are and what they read, without having chosen anything.

Copying the picture into Tela's own bucket would avoid all three, but a copy goes stale when the
member changes their picture on Gravatar, and keeping it fresh needs a background job, a stored
key and a way to delete it.

## Decision

**Opt-in.** A member turns *Show my Gravatar* on in Settings → Profile (`profiles.gravatar`,
set by a `setAvatar` mutation of its own, its clock `gravatar_at` resolved by the later `at` as
0031's privacy switches are). Until then, and whenever no picture loads, the letter is shown.

**Linked, through Tela's origin.** A person's picture is `/avatar/<userId>?v=<gravatar_at>`.
tela-web serves it through the colo cache, as it serves `/img/`; on a miss, tela-api looks up the
member's email, hashes it (SHA-256 of the trimmed, lower-cased address, which Gravatar takes) and
fetches `gravatar.com/avatar/<hash>?s=256&d=404`. The hash never leaves the server, the page never
names gravatar.com, and Gravatar only ever sees Tela's servers. Nothing is stored, so there is
nothing to keep fresh or delete.

**Cached for 30 days, versioned by the switch.** The answer is immutable for 30 days in the colo
and the browser, because the address changes whenever the picture should: *Refresh* sends the
switch on again, so `gravatar_at` and the address move and the next request goes to Gravatar.
tela-api answers only the current version, so a made-up one is a 404 and never another fetch.

**One place decides the address.** The queries that return a person select it from one SQL
fragment, and the client renders whatever path it is given (`/avatar/…` only), never building one.

## Consequences

- A member who changes their picture on Gravatar sees it on Tela after pressing Refresh, or after
  30 days. Others see it once their copy of the profile catches up, a few minutes as 0031 says.
- Turning the switch off removes every link to the picture at once. A colo or browser that already
  holds it can keep it for up to 30 days, at an address nothing points to any more; Tela cannot
  purge every colo's cache, and does not try.
- A member with no Gravatar who turns it on gets a 404, cached for a day, and keeps their letter.
- Uploads, when they come, are served from the same address before falling back to Gravatar: the
  fragment changes and nothing that renders a person does.
