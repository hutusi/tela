# 0060 — Search engines and AI: languages in the address, what is indexed, and who may train

Status: accepted (2026-10-25). Amends 0035: whether a public page is indexed is no longer one
switch, `TELA_PRIVATE_BETA` becomes `TELA_NOINDEX`, and a page tela-api did not answer is the
plain shell as a 503, no longer a 200. Amends 0015: indexing is decided apart from the sign-up
mode (ADR 0056).

## Context

Tela is opening sign-up to anyone. Until now every page was `noindex` while
`TELA_PRIVATE_BETA` was set, and lifting it would have opened everything at once, to everyone,
with nothing else to say: robots.txt was `Allow: /`, a page had a title and a description and no
other head, and nothing listed the pages.

Three things made that not enough:

- **A page had one address and four languages.** The edge rendered each public page in the
  language the `tela_locale` cookie or Accept-Language asked for. A crawler has no cookie and
  usually no Accept-Language, so search engines would only ever see English, and no link could
  say "this page, in French".
- **Open sign-up makes every public page something anyone can publish.** A claimed blog, a
  profile's bio and a blogroll are each a page on telaread.com. Indexed as they come, a spammer
  could claim their own site and have Tela link to it, or make an account for its bio, the day
  they join.
- **The owner decided (2026-10-25)** that search engines and the AI tools that search and answer
  for a person are welcome, and that AI training crawlers stay off the pages that show writers'
  work. The writers did not agree to train anyone's model by being read on Tela.

## Decision

**`?hl=<locale>` fixes a page's language** (`en`, `fr`, `zh-Hans`, `zh-Hant`; read in any case
and as any tag reads, so `zh-TW` is Traditional; `hlLocale` in `@tela/shared`). For a visitor it
comes before the cookie and Accept-Language. A member's own language always wins: the edge tells
a member by the session cookie (as `/` does, ADR 0035) and ignores `?hl=` for them, since an
address must not switch the app under someone who chose. The rule is one function each side:
`requestLocale` at the edge, `bootLocale` in the app. The app boots in the language the edge
rendered (`<html lang>` of a page with content in `#root`), because the session cookie that
decided it is HttpOnly; any other page takes the same order, with a device that holds an account
standing for the session cookie. In-app navigation keeps the boot language, `?hl=` never writes
the cookie, and choosing a language on a page whose address has `?hl=` rewrites it to the one
chosen, or a reload would take the page back.

**A pinned page is a page of its own.** It is pinned when its `?hl=` names the language it was
rendered in: a member whose own language is the one named gets the same page a visitor does. The
colo's copy is keyed by the locale and that bit (`fr.hl`), since a pinned and an unpinned French
page differ in their canonical address; both come from one tela-api answer. The browser's copy
varies by `cookie` when pinned, and by `cookie, accept-language` when not.

**Every page the edge renders has a head** (`src/lib/head.ts`, `headOf` in `src/ssr.tsx`):

- `<link rel="canonical">`: the page's own address (the key it is cached under, so no campaign
  query or unknown parameter), with `?hl=` when pinned. Discover's tabs keep their filters.
- `<link rel="alternate" hreflang>` for `zh-Hans`, `zh-Hant`, `en` and `fr` at their `?hl=`
  addresses, and `x-default` at the bare one, which follows the visitor.
- Open Graph: `og:site_name`, `og:type` (`profile` with `profile:username` for a member,
  `website` otherwise), `og:url`, `og:locale` (`en_US`, `fr_FR`, `zh_CN`, `zh_TW`) and the other
  three as `og:locale:alternate`, and `og:image`, a 1200×630 card per language
  (`public/og/<locale>.png`, drawn by `bun run share-cards` and committed); Twitter's
  `summary_large_image`.
- JSON-LD: `WebSite` on `/`; `ProfilePage` with its `Person` on `/@handle`; `Blog` on `/s/:id`,
  whose `url` is the blog's own home and whose posts are at their own addresses, never Tela's,
  under their own titles (a `BlogPosting` names the language it is in, so never a translation);
  `CollectionPage` with an `ItemList` (the first 25 entries) on a blogroll and on Discover's tabs.
  Escaped as the handover is, so nothing a blog says can close the script.
- A route may add its feeds (`feeds` in `PageHead`: RSS, OPML) as typed alternates.

**What anyone can publish is indexed only once someone has vouched for it.** tela-api decides,
and says so in each answer (`indexable`); the page says `noindex, nofollow` until then, and an
answer that does not say (an older tela-api) is read as no:

- a blog, once an operator listed it: `sites.review = 'listed'` (List, Feature, curation;
  ADR 0041). A claim or three readers list a blog and are not a review; a claimed blog nobody
  reviewed is public and not indexed.
- a profile, once its account is seven days old (`profiles.created_at`) and in good standing
  (`standingOk`): time to report or suspend it before it is worth anything.
- a blogroll, once Discover shows it (`inDiscover`: public, not hidden, and with enough blogs
  others see to be more than a stub), of an owner whose profile is indexed: a week old and in
  good standing. A new account's blogroll waits as its profile does, or making one would skip
  the week.

**Discover suggests only people whose profile is indexed.** Readers and This week are indexed
pages that name each person they suggest, with their bio and a note, so the pool they draw from
(`readersPool`) takes only a profile a week old and in good standing (`profileIndexable`), or a
new account would be on an indexed page the day it joins.

**A link out to a blog is followed only once an operator vouched for that blog.** A public page
links to the writer's own address, not Tela's, and an indexed page's link is something a
spammer would pay for. So a link to a post or a blog's home says `rel="ugc nofollow noopener
noreferrer"` unless the blog is listed by an operator (`SITE_INDEXABLE`, the rule its own page
is indexed by). tela-api says so beside each post (`site.vouched` on Discover's posts, readers
and the front page, `vouched` on a profile's posts; an answer that does not say is read as no),
and a blog's page by its `indexable`. Every link out on a blogroll's page is `ugc nofollow`
whatever the blog: the list is a member's, and they vouch for nobody. `outboundRel` in
`views/post-link.tsx` is the one rule.

Tela's own pages are indexed: the front page, Discover's tabs (a page past the first, by a
cursor or Blogs' `?page=`, is `noindex` and followed: it is a moment's slice of a list that
moves), About, Privacy, Terms and For writers. A page that does not exist is `noindex`. A page that is not indexed names no
canonical and no languages, which would be two answers to one question. The page says its rule in
`<meta name="robots">`, and the edge repeats it as `X-Robots-Tag`, from the colo's copy too.
`/api/*` always carries `X-Robots-Tag: noindex`.

**A page the edge could not make is a 503.** When tela-api fails, is slow past the three seconds,
or answers something this build cannot render, a public page is the plain shell, which boots the
app and asks again from the browser (ADR 0035). That shell's head is the app's, and says
`noindex, nofollow`: as a 200, a crawler that came at that moment would drop the page from its
index. So it is a 503 with `Retry-After: 120` and `Cache-Control: no-store`, and never the colo's
to keep; a browser shows the app all the same. A member's `/` is the plain shell on purpose, and
stays a 200.

**`TELA_NOINDEX` replaces `TELA_PRIVATE_BETA`.** While set, robots.txt is `Disallow: /` and every
answer the Worker gives carries `noindex, nofollow` unless it already says noindex. It stays set
in `apps/reader/wrangler.jsonc` until launch day, which deploys tela-web without it.

**robots.txt** (`worker/robots.ts`) has two groups. `*`, with the answer agents named
(OAI-SearchBot, ChatGPT-User, Claude-SearchBot, Claude-User, PerplexityBot, Perplexity-User,
DuckAssistBot, MistralAI-User, Meta-ExternalFetcher, YouBot), may read every public page and
nothing of `/api/`, `/o/`, `/img/`, `/avatar/`, `/__tela/` or the app's routes (`/join`, whose
`?code=` is an invitation, `/login`, `/reading`, `/following`, `/search`, `/add`, `/settings`,
`/dashboard`, `/claim`, `/sites/`, `/admin`): Disallow lines alone, since allowing is the default
and an `Allow: /` before them would open everything to a parser that takes the first rule that
matches, as older ones do. The training crawlers and tokens (GPTBot, ClaudeBot,
anthropic-ai, CCBot, Google-Extended, Applebot-Extended, Bytespider, meta-externalagent,
FacebookBot, Amazonbot, cohere-training-data-crawler, Diffbot, AI2Bot, Ai2Bot-Dolma, Omgilibot,
Webzio-Extended, PanguBot, Timpibot, ImagesiftBot, img2dataset) get an allow list: `/about`,
`/privacy`, `/terms`, `/writers`, `/llms.txt`, then `Disallow: /`. Not the front page: its edition
is writers' titles and excerpts, as Discover is. An allow list, so a page added later is closed to
them until it is named, and its Allows first, so it reads the same by first match as by RFC 9309's
longest. A crawler obeys only the group that names
it, so each group spells out all its rules. Both say `Content-Signal: search=yes, ai-input=yes,
ai-train=no`, and the file ends with `Sitemap:`.

**Sitemaps** (`worker/sitemap.ts`, data from `/api/v1/public/sitemap`). `/sitemap.xml` is an
index of `/sitemap-pages.xml` (Tela's own pages, from the bundle: the front page, Discover's tabs
and each Blogs topic, the info pages dated by `INFO_UPDATED`, For writers) and one file per kind
tela-api lists, by the same predicates as `indexable`: `/sitemap-sites.xml`,
`/sitemap-blogrolls.xml`, `/sitemap-profiles.xml`, 2,000 pages a file and `?page=` past that.
Each page is five `<url>`s, its four `?hl=` addresses and the bare one, each naming all five as
`xhtml:link` alternates; with `lastmod` where known (a blog's newest post or change, a blogroll's
last change, a profile's or its newest recommendation). Every file sits at the root, since a
sitemap may list only addresses under its own directory, and each is in `run_worker_first` by
name. The lists come through the colo's copy, which tela-api keeps an hour; no list is a 503 with
`Retry-After`, never an empty file, which would say every page it named is gone.

**`/llms.txt`** (`worker/llms.ts`): what Tela is, its key pages with each language's own names at
their `?hl=` addresses, the feeds (`/discover/articles.rss`, `/discover.opml`, a blogroll's
`.rss` and `.opml`) and the sitemap, and how to cite: the original post at the writer's address
and its original title, Tela's page only for Tela's view of a blog. Tela shows titles and
excerpts, never full text, and it says so.

## Consequences

- A new public page kind needs a `pageAddress` and a `headOf` case, an `indexable` rule if anyone
  can publish it, an entry in a sitemap, and a line in llms.txt; a new path the Worker answers
  goes into `run_worker_first` by name.
- A blog becomes indexable when an operator lists it and stops when they hide it; a listed blog
  that loses its review loses its index too. Search engines see the change on their next crawl:
  public answers and pages are cached minutes, the sitemap an hour.
- Google-Extended and Applebot-Extended are tokens, not crawlers: they keep Tela's writers out of
  Gemini's and Apple's training, and Google-Extended out of Gemini's grounding too, while Google
  Search and Siri read as before. Amazonbot is listed as training, since Amazon says what it
  fetches may train its models.
- A crawler that ignores robots.txt is not stopped by it. Cloudflare's AI Crawl Control can
  block by behaviour, and its managed robots.txt would replace this one: it must stay off
  (OPERATIONS.md).
- A visitor who shares a page pinned to their language sends it in that language. One who arrives
  without `?hl=` gets their own, as before.
- The colo keeps up to two copies of a page per language (pinned and not): the same tela-api
  answer, so no more D1 reads.
- A blogroll is held to Discover's bar, three visible blogs, which is stricter than "public and
  not hidden": a smaller one is a stub to a search engine. Its owner's age is checked as a
  profile's is.
- A blogroll a new account made still shows on Discover's Blogrolls tab, which is indexed, with
  its name and description, and a new account's note on a post still shows beside the post on
  Discover's posts: the seven days keep their own pages out of the index and their people out of
  Readers, not their cards and notes.

## Alternatives considered

- **A path per language (`/fr/discover`).** Clearer to a person reading the address, but every
  route, `run_worker_first` entry, link and cache key would double, and the app's router with
  them. A query parameter leaves the paths alone, and search engines treat it the same with
  hreflang.
- **Indexing every public page and relying on reports.** A report arrives after the page is
  indexed, and removing a page from an index takes longer than adding it.
- **A deny list for training crawlers** (`/s/`, `/l/`, `/@`, `/discover`). It would open every
  page added later by default, the RSS and OPML feeds among them.
