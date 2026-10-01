# 0033 — A member's picture: their upload, else their Gravatar by default, else their letter

Status: accepted (2026-10-01). Amends 0032: its Gravatar becomes the default rather than a choice,
and the upload it left room for arrives at the same address. 0031's letter in a circle stays the
last resort.

## Context

0032 served a member's Gravatar from Tela's own origin, at `/avatar/<userId>?v=<avatar_version>`,
once the member turned it on. Two things followed from using it:

- Most members never open a setting, so an opt-in picture is a picture almost nobody has.
- A Gravatar is a picture its owner published to be shown wherever their email is used, but
  not everyone has one, and not everyone wants theirs. A member should be able to choose their
  own picture.

On by default has a cost an opt-in did not. Tela's profiles are public, and a handle or a name
can be a pseudonym: a member whose Gravatar is their face would have it published beside the
pseudonym without doing anything, and a picture is cached for 30 days after they turn it off. Tela
also cannot tell, without asking Gravatar, who has a picture; asking from every page for every
person would mean a failed request per member without one, which in this audience is most of them.

## Decision

**Which picture shows: the member's upload, else their Gravatar, else their letter.** One SQL
fragment says which (`avatarSql`, `packages/data/src/queries/people.ts`), and the address is the
same whichever it is, so pages, the edge and its caches do not change: tela-api answers
`/avatar/<userId>?v=` on a colo's miss with the upload when there is one, else the Gravatar.

**The Gravatar is on until the member turns it off.** A profile that has never set the switch
(`gravatar_at = 0`) counts as on; Settings → Profile keeps the switch, and turning it off stands.

**Tela knows who has a Gravatar, and asks for nobody else's.** A tela-jobs kind (`member.gravatar`,
like the favicon job) asks Gravatar whether the member's address has a picture and records only the
answer (`gravatar_found`, `gravatar_checked_at`); nothing is copied. A picture found is asked about
again after 30 days, a miss after 7, and the switch sent on again (Refresh) asks at once. The address
exists only for a picture that was found, so a member without one is their letter, with no request.
When the answer turns to found, the version moves, so no "none" cached under the old address
stands.

**An upload is cropped and resized in the browser, and checked by its bytes on the server.** A
dialog crops a square (drag and zoom) and draws it at 256 px, since a Worker cannot resize an
image. tela-api reads the type and size from the file's own header, never the declared one: PNG,
JPEG or WebP only, never SVG, at most 512 KB, square, at most 1024 px. It is stored in R2
`tela-content` under `avatars/<userId>/<the first 16 hex of its SHA-256>.<ext>`, which the edge's
`/o/*` never serves. Every upload and every removal moves the version; removal and replacement
delete the object they leave behind.

## Consequences

- A pseudonymous member with a Gravatar shows their picture until they turn it off. Caches that
  already hold it keep it for up to 30 days at an address nothing links to any more, as 0032 says.
- A member who makes a Gravatar sees it within a week, or at once with Refresh.
- Uploads are member data in R2, outside the nightly D1 export (ADR 0021); like content objects,
  leaving Cloudflare copies `avatars/` from the bucket. Removing a picture deletes it.
- The crop editor is the reader's own; there is no server-side image processing to keep secure.
