# 0061 — "Only use what my feed provides", and robots.txt for the pages Tela fetches

Status: accepted (2026-10-25). Amends 0022: eager extraction now asks the writer first, by a
switch or by robots.txt. Completes 0035's note on `/writers`: it is rendered at the edge.
Superseded in part by 0070 (2026-10-31): how Tela reads a blog and what it shows are their own
page, `/bot`; claiming and opting out stay on For writers.

## Context

Opening sign-up means blogs reach Tela that no one there writes for: anyone can add a feed. A
writer who finds their blog here has had no say in what Tela fetches beyond the feed they publish:

- **a post's page**, once, soon after the feed lists it, when the feed carries only a summary
  (ADR 0022's eager extraction), so subscribers read the full text in the reader;
- **the home page**, once, when the blog is added, for the icons it declares.

Neither is something a feed reader is asked for by subscribing. Tela never read robots.txt, and a
writer's only way out was the Terms' "tell us" and an operator's hand. The owner's decision
(2026-10-25): the opt-out is self-serve plus robots.txt, and the setting is named for what it does,
"Only use what my feed provides": Tela stops fetching the writer's pages, and if the feed carries
full text, subscribers still see it.

## Decision

**A blog's writer can switch off every page fetch.** `sites.feed_only` (migration 0014), the
claimant's switch on the Dashboard beside translation (`PUT /api/v1/sites/:id/feed-only`), and an
operator's for a writer who asks by mail (`site.feedOnly`, `site.feedAll`, audited and undoable).
While it is on:

- **no post is made due for extraction.** The guard is in the SQL of the feed batch's article
  insert and update, so a fetch already running when the switch turns cannot write `due` after it;
  the reader shows "fetching the full text" while a post is due, and that post would wait for good.
  Turning it on settles the blog's waiting posts (`due` → `none`) in the same batch, and an
  extraction already reading a page then keeps nothing of it: its version and its move both wait
  on the post still being due, so `none` is never overwritten with `done`, and no version of a
  page the writer refused is left for a feed's later change to choose as current. Whatever else
  sets the flag (an operator's undo of `site.feedAll`, or of a claim removal, puts the column back
  and nothing else) leaves them to the job: the due query hands it a feed-only blog's due posts
  like any others, and it settles each to `none` without a fetch. The operator's retry leaves such
  a blog's failed posts failed, and the health check's backlog does not count its due ones.
- **the favicon job tries `/favicon.ico` alone**, as a browser would, and never the home page.
- **discovery of a URL on the blog answers from its stored feeds**, matched by its home with or
  without `www.` and over either scheme, and asks the blog nothing. Adding one of its feeds by an
  address Tela does not know resolves to the blog's own feed. A blog with no live feed left has
  none to offer.
- **claim checks still fetch** the home page and the 404 probe (ADR 0045): the writer asked for
  them by claiming.
- **what was extracted before stays.** Versions are never rewritten (ADR 0022), and a post whose
  current version is a readability one keeps it. Turning the switch off makes nothing due again;
  the next change to a summary decides as it always has.

**Page fetches ask robots.txt; feed fetches never do.** Before extraction or a favicon's home page,
the origin's rules are read (`pipeline/robots.ts`), parsed as RFC 9309 says (`robots.ts`): the group
naming the product token `Tela` (case aside, `Tela/0.1` naming it too), else `*`, several groups
for one agent merged, the longest match deciding and `Allow` winning a tie, `*` and a final `$`,
paths percent-encoded alike on both sides, the first 500 KiB read. They are kept per origin in
`robots_rules`, only the group that applies, written back as one-group robots.txt, so a row says
exactly what Tela obeys. Fetched with the same client as everything else: private ranges refused,
a 10 s timeout, at most five redirects (across hosts, as the RFC allows), and from the region the
blog's feed is fetched from (ADR 0008), the favicon job's read too: the rules are shared, and one
read that timed out from the wrong side would hold the blog's pages back an hour.

A page that redirects to another origin (a blog that moved host, a link shortener), a post's or
the home page, is that origin's page, and its robots.txt is asked too, before anything the page
answered is used. The client follows redirects itself, so the page has been fetched by then;
refused there, it is dropped, whatever its status: the post is failed and marked as refused
(below), and the home page's icons are not looked for. Both checks' rules are kept. A redirect on
the same origin is judged the same way, by the path it landed on, against the rules already read
(`checkLanded`): an allowed `/old-post` that moves to a disallowed `/private/post` is refused
(Codex's review found it stored). Such a post is made due again by new rules on its own host, the one its link
names, not on the host it landed on: in the common case (apex to `www`, `http` to `https`) the
two robots.txt are one file behind the same redirect, and change together.

| robots.txt answers                                    | Tela                     | asked again |
| ----------------------------------------------------- | ------------------------ | ----------- |
| 2xx                                                   | its rules                | after a day |
| 4xx, but 429                                          | no file: everything goes | after a day |
| 429, 5xx, a timeout, no address, a redirect loop      | unreachable: nothing goes | after an hour |

A feed is not checked because subscribing is the request: a feed is published to be read by
programs, every feed reader reads it, and a writer who wants no reader at all does not publish one.
Asking robots.txt for feeds would also make Tela the one reader a `User-agent: * / Disallow: /`
left without the posts its members subscribed to. The writer who wants Tela to read nothing else
has the switch, and robots.txt for the rest.

**A refused page is failed, not retried.** The post keeps the feed's version and excerpt, and
`extract_state` becomes `failed`, the existing value: the backoff would ask again every few
minutes, and a robots.txt does not change that fast. `articles.extract_refused` (migration 0014)
marks it: set when robots.txt disallowed the page or could not be read, cleared by every other
settle. When the rules read later (on the next page due on that origin, once the kept ones are
stale) differ from the kept ones, and the new answer is not unreachable, the host's marked
extractions become due again in the same batch, the mark cleared with them; each asks the rules
first, and settles the mark again. A page that failed for another reason (a 404, no article in
it) is not among them: it would fail again, and a robots.txt that drops out and comes back every
day would have it fetched every day. A first read changes nothing (no rules were there to refuse
anything). What a check learns commits in the job's own fenced batch (invariant 6);
a page that asks for a retry keeps it under the held lease, so the retry does not ask robots.txt
again.

**For writers says all of this, at the edge.** `/writers` is a public route with no data
(`run_worker_first` names it exactly; `/join` is still never there), rendered by the same view in
the SPA and the edge, in four languages, for a visitor; the count of blogs comes from the app once
it takes over. Under the card: how Tela reads a blog (its user agents, intervals between 30 minutes
and a day, conditional requests, backoff to a week, images only when read, the summary post's page
once), what it shows in public (titles and excerpts, never a whole post), how translation works,
how a claim is proved, and every way out: translation off, this switch, robots.txt (`User-agent:
Tela` / `Disallow: /`), and leaving by mail. WebSub is not mentioned: it is off in production.
Its head is built as every public page's is (ADR 0060): canonical at `/writers`, or at its `?hl=`
address when pinned, with the four languages as alternates, and indexed once `TELA_NOINDEX` is
lifted; robots.txt, the sitemap and llms.txt already name it.

## Consequences

- Every page fetch costs one more D1 read (the kept rules), and one more request to the blog a day,
  per origin, while it has pages due. The first extractions after the deploy each read robots.txt
  once per origin.
- A blog whose robots.txt fails (a 503, a firewall that drops Cloudflare) loses full text for its
  new posts until it answers again and a later post asks. Those posts are retried then, as a
  rules change.
- The parser is Tela's own, about 150 lines with no dependency: the maintained npm parsers are
  CommonJS written for Node. A test holds the product token to the user agent in tela-jobs'
  config.
- Readers' devices do not hold `feed_only`: nothing they show depends on it, and the Dashboard
  reads it over RPC. A tela-api older than the route sends none, and the Dashboard then shows no
  switch.
- Removing a claim (`claim.remove`) resets only translation; resetting `feed_only` with it belongs
  to the release of claims, ADR 0058.
- The image proxy does not ask robots.txt: an image is fetched only when a member reads the post
  that names it, like the browser that shows it.

## Alternatives considered

- **Ask robots.txt for feeds too.** It would make a common `Disallow: /` (meant for search
  crawlers) cut a blog off from the readers who subscribed to it, which no feed reader does.
- **Mark a refused page with an `extract_state` of its own.** Every reader of the state (the
  reader's "fetching the full text", the operator's retry, the health check) would have to learn
  it; a flag beside `failed` changes none of them.
- **Retry every failed page on the host when the rules change.** The first version did, with
  nothing to tell a refusal from a 404: each time a flaky robots.txt came back, every page that
  had failed for good was fetched again.
- **Keep the raw robots.txt.** The applicable group is all a check needs, and a 500 KiB file read
  from D1 before every page would cost more than it says.
- **Extract only when a member opens the post.** ADR 0022 chose eager extraction because opening
  bought nothing but a spinner; the writer's switch answers the same concern without it.
