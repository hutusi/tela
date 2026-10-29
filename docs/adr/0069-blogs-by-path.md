# 0069 — Blogs by path: a writer's path on a shared host, and a site's sections

Status: accepted (2026-10-30). Amends 0011 (a site is keyed by its origin, and vouches for a feed
served from it), 0045 (the 404 page and GitHub's website on a shared host) and 0068 ("a blog is an
origin": Anthropic as one blog, Microsoft Research left out).

## Context

A blog was its origin: `sites.home_url` is unique, and every place that decides which blog a feed
belongs to built it with `normalizeOrigin`, which drops the path. So two blogs on one host were one
blog:

- **Anthropic.** Its Research and Engineering feeds were one blog, "Anthropic". Its Subscribe added
  Research (ADR 0068's main feed), and Engineering showed nowhere in Discover. Anthropic gives
  each its own index page, and they have different writers, readers and pace (191 posts to 27).
- **Shared hosts.** The HN round (2026-10-29) left out The Old New Thing
  (`devblogs.microsoft.com/oldnewthing`, beside the TypeScript and .NET blogs), Computer Things
  (`buttondown.com/hillelwayne`) and DHH (`world.hey.com/dhh`). ADR 0068 dropped Microsoft
  Research, whose host is also the Security blog's. These are the independent writers Tela is for.
- **Members already met it.** A member who added two HEY World writers got one blog called
  `world.hey.com`, and a claim started at `world.hey.com/dhh` was keyed to the host: the first
  writer there to verify would have held every writer's blog.

A per-feed Subscribe on the blog's page would have let a reader pick Engineering, but not shown it
in Discover, nor brought back any blog on a shared host.

## Decision

**A blog's key is its origin, except where the rules say it is a path** (`siteKeyOf` and
`BLOG_RULES` in `packages/shared/src/blogs.ts`):

- On a **shared host** (`world.hey.com`, `buttondown.com`, `buttondown.email`,
  `devblogs.microsoft.com`), the first segment of the path is a writer's blog:
  `https://world.hey.com/dhh`. The host's own pages are the host's.
- A **section** the rules name is a blog of its own, the deepest that matches, by whole segments:
  `https://www.anthropic.com/research`, `https://www.anthropic.com/engineering`,
  `https://www.microsoft.com/en-us/research`.
- **Everything else is its origin, as before.** No ordinary blog's key changes, and nothing moves.

**The rules are code, not a table.** Every caller (registration, every fetch, a claim, Add, OPML,
curate) resolves a key at once and without reading the database, and a blog by path is rare and
an editor's call, as the curated list is. Adding one is a deploy of tela-jobs and tela-api, then
curate (OPERATIONS.md). A host joins `sharedHosts` only when its feeds and their `<link>`s both
live under the writer's segment: Medium's feeds are at `/feed/@user`, so it waits.

**Every "which blog" uses the key.** Registration files a feed under its declared home's key when
honoured, else its own; a feed's first fetch moves it to its declared home's (`fileFeedUnder`);
provenance stores the key the feed was served from (`feeds.served_origin`, the origin for every
ordinary blog), so a claimed blog vouches for its own feeds and a stranger's goes to the
stranger's blog, never to the bare host. A feed Tela filed under a shared host's bare origin
before this is on a placeholder keyed by its own address, so its next changed fetch renames or
splits it onto its writer's blog. Lease hosts drop the path, so a blog by path is polite to its
host along with that host's feeds.

**A blog split off another keeps every no the other had said, and nothing else.** A feed that
splits off its blog because its key changed (at a fetch, or by curate) lands on a new site with
the old one's Hide, "Only use what my feed provides" and no translation: each is a decision about
those posts, and a split must not list what an operator hid nor fetch the pages of a blog that
asked for its feed alone. A listing is never kept; the new blog waits for review like any other.
A feed detached from a claimed blog keeps none of them: it was never the owner's, and their
decisions are about their blog (ADR 0065 sends its translations to apps again). Any site a move
makes takes its name, description and language from the feed and its posts in the same batch,
since a fetch fills them only when the feed's body changes. And a filing is decided from reads
made before its batch, so the batch refuses it, as a lost lease's fence does, when a claim was
verified on either blog, the feed moved, or (for a rename) another feed or site arrived
meanwhile: curate holds no lease on the blogs it files.

**Claims are keyed by the blog, and the 404 page counts only where the blog owns it.** A claim
started at a writer's address claims that path. On a shared host no proof uses the blog's 404 page:
it is the host's, the same for every writer, so a link in its footer is no writer's own, and
without it a plain link on the home page may be a mention in a post (ADR 0045's reason for the
404 page). What proves a blog there is the meta tag, `rel="me"` to the Tela profile, or GitHub with
`rel="me"`, each read from the writer's own page. A GitHub profile names a blog by its key, so
another writer's path on the same host names theirs. A section keeps every proof: its 404 page is
its site's, which proves control of the whole origin and so of the section. A writer on a shared
host who gives only a plain link is told to add `rel="me"`, the reason a blog with no 404 page
gets, so no new reason reaches a cached shell (`MIN_CLIENT` stays 7); the claim page says so up
front, in a string the shell ships.

**Add finds a blog by its key.** A section's address offers that section's feeds; the site's own
address offers every listed section under it, main feed first (ADR 0068's `mainFeedOrder`). A
writer's address on a shared host never looks for feeds at the host's root: discovery's second
page is the writer's page, and the well-known feed paths are tried under the writer's path.

**Curate names the blog a feed belongs to** (`home` in the curated list), for a feed Tela filed
elsewhere before, since no fetch moves a feed off a blog that is not its placeholder: the first to
leave splits onto a blog of its own, and the last renames the blog it was on, which keeps its id,
address and readers. Anthropic's Engineering entry comes first, so Research keeps `/s/409`, the
blog Discover's Subscribe has added all along.

**A blog by path shows its path** (`blogAddress`): `anthropic.com/research`, `world.hey.com/dhh`.

## Consequences

- No migration and no `MIN_CLIENT` bump: `home_url` and `served_origin` hold the same kind of
  string, and an older shell shows a blog by path by its host.
- Anthropic's Research and Engineering share 2 posts, now one under each blog: Discover's Articles
  lists them twice, once per blog, as it would any two blogs that publish one post. `repeatedPost`
  stays for a blog's own overlapping feeds.
- A writer on HEY World or Buttondown who can add neither a meta tag nor `rel="me"` cannot claim
  their blog yet. Proving less there would let a host's footer, or a link in a post, claim it.
- The app API's `homeUrl` may now carry a path; the field and its format are unchanged
  (docs/api/CHANGELOG.md).
- OpenAI stays one blog: its News feed carries Research and Engineering too, so splitting them
  out would list each of those posts twice. Its Developer Blog is its own origin and needed no
  rule.
- A shared host's bare origin stays a blog for the host's own feed, if anyone adds one.
