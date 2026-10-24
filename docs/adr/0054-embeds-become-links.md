# 0054 — Embeds become links

Status: accepted (2026-10-24)

## Context

The sanitizer removes `iframe`, `video` and `audio` with their content (ADR 0005). Nothing
embedded may run inside Tela: a player is someone else's page and code, the edge serves bodies
from its own origin, and the CSP has no frame sources. The removal also left no trace. A post built
around a video read with a hole where the video was, and a reader never learnt it had been there.

An audit of 579 posts (up to three per feed across 193 feeds) found an embed in 44 of them:

- YouTube players: 36;
- Hatena blog cards (`hatenablog-parts.com/embed?url=…`): 23;
- HTML5 videos: 14;
- route maps (komoot): 5;
- Instagram widgets: 3;
- Bandcamp players: 2;
- one broadcaster's audio player.

Some iframes are not content: slashdot attaches a "discuss" widget to every item.

## Decision

An embed worth opening becomes a link to where it opens (`embedsAsLinks`, `sanitize.ts`), before
the allowlist runs.

- **What qualifies:**
  - every `video` and `audio`, by its `src` or its first `source`;
  - an `iframe` from a known player or link-card host, or whose address has an `/embed`,
    `/player`, `/video`, `/videos`, `/play` or `/watch` segment.

  Any other iframe is a widget and is dropped with its content, as before.
- **Where it links:**
  - a YouTube player links to its watch page, a Vimeo player to its video page;
  - a link card (Hatena, Embedly, iframely) links to its `url` parameter, the post it showed;
  - anything else links to its own address.

  The address goes through the same absolutizing and http(s) check as every other link.
- **What it says:** `▶ host/path` for what plays (video, audio, a known player), `↗ host/path` for
  the rest. Glyphs and an address read the same in every language.
- **Where it sits:** in a `<div>` of its own, so the normalizer makes it a block. Kept inline in a
  paragraph, it would change that paragraph's tagged text, and so the hash its translation is
  cached under. As a block, the paragraph stays byte-identical.
- **Not translated:** a block that is only an address (this link, a bare URL, a link showing a
  URL) is skipped. A model can only echo it, and an echo is refused as "identical to source", so
  such a block used to be shown as failed.
- **Said once:** an embed whose following `<cite>` already links its address is dropped. Hatena
  writes such a citation after every blog card, so a link would repeat it.

## Consequences

- A reader sees where a video, a map or a card was, and one click opens it on its own site.
- On Tela no third-party player, script or cookie loads, as before.
- A post with an embed gets a new content key the next time it is processed. Its existing leaves
  keep their hashes, and the new link leaf is skipped, so redoing its translation pays for
  nothing. This is a leaf-shape and skip change, not a change to tagged text or hashing, so
  `NORM_VERSION` stays (ADR 0053).
- Across the 21 fixture feeds, 52 of 962 items change: the embed links themselves, and
  address-only paragraphs (Hatena citations, bare URLs) that are now skipped.
- An unknown player under an address without a player segment is still dropped. Its host can be
  added to the list when one turns up.

## Alternatives considered

- **Keep dropping embeds.** Simplest, but a post built around a video reads with a hole in it.
- **Embed them.** It runs third-party code and cookies inside Tela's origin and needs frame sources
  in the CSP; the reader's privacy and the edge's single origin are worth more.
- **A thumbnail card for YouTube** (`img.youtube.com/vi/<id>`). Nicer, but it puts a third-party
  image in the stored body for one host; a link does the job for all of them.
