# 0068 — AI labs in Discover, under an AI topic

Status: accepted (2026-10-28). An exception to the curated list's rule that Discover holds
independent blogs written by people (ADR 0018's editorial door); adds a tenth topic.

## Context

Members want to read the AI labs: an OpenAI or Anthropic post beside its translation is one of
the strongest reasons a Chinese or French reader has to use Tela. But several labs publish no
feed. Anthropic has none for News, Research or Engineering, so typing their address into Add says
"No feed found", and the feeds that do exist are on another host, where no member would look.

Measured on 2026-10-28:

- **RSSHub is not a source.** `rsshub.app` answers a feed reader 403: "intended for testing
  purposes only and should not be used as a production RSS source". Running our own RSSHub would
  be a second Node service whose fetches of a blog's pages skip `checkRobots` and `feed_only`
  (invariant 16).
- **Maintained third-party feeds work.** github.com/Olshansk/rss-feeds keeps feeds for Anthropic
  (News, Research, Engineering), Cohere, Meta AI, xAI and others, refreshed within days, each
  naming the lab's page as its `<link>`. `declaredHomeHonoured` already files such a feed under the
  unclaimed blog it names, so `www.anthropic.com` is the blog, not `raw.githubusercontent.com`.
- **Most labs do publish a feed:** OpenAI, Google DeepMind, Google Research, Hugging Face,
  Microsoft Research and Mistral.
- **Volume is not a flood.** The 13 lab feeds published 62 posts in the last 7 days; the directory
  published 329 from 98 blogs. OpenAI's 21 a week is fewer than kottke.org's 44 or Daring
  Fireball's 30.
- **Full text is not always reachable.** OpenAI's feed carries a title and one line, and
  openai.com answered a plain request for a post 403; the other labs' pages answered 200 and their
  robots.txt allows them. xAI's site answered 403 too.

## Decision

**A tenth topic, `ai`, after `tech`.** "AI" in English and Chinese, "IA" in French. It stands on
the independent writers before any lab: Simon Willison, Lilian Weng, swyx, Interconnects, Ahead of
AI, 科学空间 and 宝玉 carry it beside their other topics.

**The AI labs are curated, under AI alone, never featured.** The front shelf and the other chips
stay the writers'. Each is named as the lab (`title`), since their feeds name a section ("OpenAI
News", "The latest research from Google"). A lab with no feed of its own is read through a
maintained third-party feed whose `<link>` names it, never through rsshub.app. Anthropic's three
feeds are one blog, `www.anthropic.com`, since a blog is an origin. OpenAI is listed although its
posts may stay excerpts: if Tela's fetches from Cloudflare are refused as the test was, a member
reads the summary and opens the post on openai.com. Tela does not try to get past a site's bot
wall. Left out: NVIDIA's blog (the whole company's news), Meta AI and xAI (nothing in 30 days, and
x.ai refuses bots) and Qwen (quiet since 2025-08).

**Add finds a listed blog's feeds from the blog's address.** When discovery finds nothing at a
URL, or cannot reach it, it answers with the live feeds of the blog at that URL's origin (with or
without `www.`, over either scheme), if that blog is listed or featured (`listedFeeds` in
`packages/ingest/src/pipeline/rpc.ts`). Typing `anthropic.com/engineering` then offers Anthropic's
three feeds. Only a blog in Discover, because its public page already shows those feed URLs to
anyone: a private blog's feeds are what its readers chose, and a feed URL can carry a secret (a
paid newsletter's). Claims never take this path: a feed kept elsewhere proves nothing about the
blog, and a claim that verified would detach it anyway (ADR 0011). The app API's
`POST /v1/feeds/discover` answers the same, in the same format.

**`MIN_CLIENT` goes to 7.** A protocol-6 shell renders a blog's topics by their key and would show
"topics.ai" on the blog's page. From 7 the blog page and the console show only topics the build
can name, in Discover's order, as the dashboard already did, so the next topic needs no bump.

## Consequences

- No migration: `site_topics` has no CHECK. The deploy is tela-jobs (it runs discovery), tela-web,
  then tela-api, then `bun run admin curate`. Curate drops a topic tela-api does not know, so it
  runs after tela-api.
- Discover now holds publications with mastheads, under one chip. Another kind of publication
  wants its own decision, not this one stretched.
- Three labs depend on one person's repository. If it stops, their blogs fall silent, and the
  list's six-month rule takes them out, as it would a writer's.
- Every feed from `www.microsoft.com` joins the Microsoft Research blog, as any feed joins the blog
  at its home's origin.
- A lab could claim its blog. Verification would then move the third-party feeds off it
  (ADR 0011), leaving the lab to publish a feed of its own, which is the outcome to want.
