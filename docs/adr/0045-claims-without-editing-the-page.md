# 0045 — Claims without editing the page: a link the 404 page shows too, and GitHub both ways

Status: accepted (2026-10-10). Amends 0011: its proofs stand, and two more are accepted beside
them. Amends 0036's "Tela never calls a provider's API" for one public, tokenless lookup.

## Context

ADR 0011 accepts two proofs that a member controls a blog: the token in a
`<meta name="tela-site-verification">` tag, or a `rel="me"` link to their Tela profile, both on the
home page. The owner claimed hutusi.com and the check failed. The footer linked
`https://telaread.com/@hutusi` with `rel="noopener noreferrer"`, which is what a footer link
usually carries, and the check wanted `me`. Nothing said so: the claim page showed a
`<link rel="me">` tag for `<head>` while its hint said "a link in the footer works", and the
failure was one English sentence listing both proofs as missing.

The owner asked for an easier way: a blog that links the member's GitHub, for a member who signed in
with that GitHub. Measured on the 107 curated blogs that answered (2026-10-10):

- 20 home pages link a GitHub profile, and for 16 of them that profile's website is the blog. A
  check that needs both directions asks nothing of those 16, hutusi.com among them.
- **One direction is not proof.** Daring Fireball shows posts in full on its home page, and one
  links `github.com/omlahore`, a developer it wrote about; jia.je's links two friends inside a
  post. A link says "mentions"; `rel="me"` is what says "is me". With GitHub's website field,
  which anyone sets to anything, a mentioned developer could name the blog and take it.
- **What sets the owner's link apart is where it is.** A blog's own links sit in its header,
  footer or sidebar, which every page repeats; a mention sits in a post. So the check reads a
  second page, and which page is the whole question:
  - **An older post was the first answer, and it is not the blog's alone to choose.** Fetching
    the oldest post Tela held, every mention above dropped out and 13 of the 16 passed. Review
    (Codex) then took a blog with it: the post the home page shows in full may be that oldest post,
    and an unclaimed site accepts feeds from any origin that name it as their home (ADR 0011), so a
    backdated item in a stranger's feed, pointing at the post that mentions them, chooses it.
  - **The blog's own 404 page is.** Asked for an address it does not have, a blog answers with its
    header, footer and sidebar and no post, and nothing on it is anyone else's to choose. 5 of the
    16 show the owner's GitHub link there (hutusi.com, jvns.ca, jia.je, elmagnifico.tech,
    kawabangga.com), 5 more carry `rel="me"` on the home page and need no second page: 10 of 16.
    The rest serve a bare 404 (a word, an empty body) and keep the tag or `rel="me"`. Daring
    Fireball's 404 does not show the mention.

## Decision

**One Verify, every proof tried, the member never picks one.** In order:

1. The meta tag, unchanged.
2. A `rel="me"` link to the member's profile, anywhere on the home page, unchanged except that it
   is read as a browser would follow it: `http` or `https`, `www.`, the old `tela.ainaive.com`
   (ADR 0042), `%40`, a query or fragment, and relative to the page (`/@name` is the blog's own
   path). Method `rel_me`.
3. **A link to the profile without `rel="me"`**, when the blog's 404 page shows it too. A link
   whose `rel` holds `nofollow`, `ugc` or `sponsored` never counts: that is how comment sections
   and sponsor slots mark links that are someone else's. Method `link`.
4. **GitHub, both ways**, for a member with a GitHub on their account: the profile behind its
   numeric id (`GET api.github.com/user/<id>`) names the blog as its website, by host and
   without `www.`, and the blog links `github.com/<login>`, with `rel="me"` anywhere on the home
   page or without it on the 404 page too, as in 3. Method `github`.

The 404 page is the answer to `/tela-claim-<token prefix>` on the blog's origin, and counts only
as a 404 or 410 that stays on the origin and off `/`: a single-page app's fallback answers 200
with the home page, posts and all, and a blog that sends a missing address home answers with the
home page too. Either is told its link needs `rel="me"`. Nor does a blog served over HTTPS
whose probe lands on plain HTTP: anyone on the way could write that page (review, CodeRabbit).
An upgrade from `http://` counts.

**A check that finds no proof says what to change**, as the closest miss: a link on the home page
that the 404 page lacks, no 404 page, a link marked as a commenter's, a link to another handle, a
GitHub whose website is another, a GitHub that names the blog the blog does not link, GitHub not
answering, or nothing at all. It is stored as JSON in `site_claims.error` (`ClaimReason` in
`@tela/shared`); the claim page words it in the member's language. tela-api sends it in English
beside the reason too (`describeClaimError`, as the admin console shows it), because a claim page
cached before reasons existed shows only that text. A reason holds no GitHub login or website:
the column syncs to the device and goes into the nightly export, and Tela keeps nothing from a
provider but the identity (ADR 0036), so the page says "your GitHub" and "is not {site}".
Other failures stay text.

**GitHub is asked without the member's token**, which Tela never keeps (ADR 0036): the user API by
id is public. tela-jobs sends an optional `GITHUB_TOKEN` with no permissions, to that host only and
on no redirect, for 5,000 requests an hour; without it GitHub allows 60 per egress IP, which
Cloudflare shares. Nothing GitHub answers is stored. The Privacy page says Tela asks.

**`site_claims.method` gains `link` and `github`** (migration 0009). SQLite changes a CHECK only by
rebuilding the table, the first rebuild here: drizzle-kit qualified the checks with the temporary
table's name, which the rename then fails on, so they name their columns bare, and the foreign keys
are deferred, since D1 ignores `foreign_keys=OFF`.

## Consequences

- hutusi.com verifies as it is, by its footer link (3) or by GitHub (4): its 404 page carries
  the same footer.
- The two new proofs are inferences, and their known failure is a person the blog links site-wide
  (a blogroll, a theme credit to a person rather than a repository, a sponsor slot without
  `sponsored`) who joins Tela and names the blog on GitHub or links it to their own profile. Each
  takes one blog at a time, by someone the blog itself chose to link, and the claim records how it
  was proved; an operator reads the method in Claims and removes the claim (OPERATIONS.md), and
  the writer proves it with the tag. The removal holds: from then on that member's claim on that
  blog verifies only by the tag or `rel="me"` (`site_claims.overruled_at`, migration 0010), and a
  rejection does the same. Until 2026-10-11 it did not, and the claimant could press Verify and
  win the blog back by the very link the operator ruled on.
- A blog whose 404 page is bare, or which has none, cannot use 3 or 4 without `rel="me"`, and is
  told so.
- A link added by script, or a page behind bot protection, is still invisible: the check reads the
  page as served. The failure says so.
- Considered and not done: a code published in a post (helps hosted platforms, nobody has asked,
  and is noisier than a tag); DNS TXT (harder than the tag, not easier); the domain of the
  member's sign-in address (most use Gmail).
