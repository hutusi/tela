# 0016 — One database wave per render, and no render the reader did not ask for

Status: accepted (2026-09-07)

## Context

Opening an article on production took seconds, every time, with no improvement on a second click.
Measured against `tela.ainaive.com`: pages that touch no database answered in ~0.5 s and clustered
tightly; `/discover`, which runs two parallel queries against an empty dataset, ranged 0.76 s to
3.34 s across fifteen samples. The database is Supabase in `ap-northeast-1`; the Worker runs at the
reader's edge, because `placement: { mode: "smart" }` only relocates a Worker given consistent
traffic from many locations and a private beta has none. Measured directly through the Supavisor
session pooler, a query on an open connection costs ~300 ms round trip and opening a connection
costs ~2 s, while `explain analyze` on the heaviest reader query reports 17 ms of execution on 142
articles.

So the cost is not the SQL and not the data. It is the number of times a render crosses an ocean,
multiplied by the number of renders. `/reading` did about ten round trips, five of them strictly
sequential, and one click produced up to five renders: the navigation, then a re-render carried by
each server action that called `revalidatePath`, then another from every caller that also called
`router.refresh()` — and then a full re-render every two seconds for up to three minutes while a
translation was pending.

## Decision

Two budgets for `/reading`, and a rule about who may cause a render.

- **One database wave per render.** Every query the page needs starts in one flight. Nothing on the
  page may await a query in order to decide what to query next. The reading language, which decides
  which translations to join, therefore comes from a cookie (`tela_reading_lang`, written by the
  action that changes it and seeded by every sign-in path) with the `profiles` row as the source of
  truth and the fallback. A pre-existing session that misses the cookie pays that fallback once
  and repairs the cache in the browser after the successful lookup.
- **`getArticle` returns the whole reader pane** — content, read and liked state, the body
  translation for the reading language, and the member's own recommendation — because those were
  three sequential lookups building one pane and nothing forced them apart.
- **Only navigation or a terminal background result renders the page.** A server action that
  returns the truth its caller applies does not revalidate, and its caller does not refresh.
  Waiting on background work is a poll of `/api/reading/state`, one indexed row, not a re-render;
  transient translation states share one revision, and a refused request never starts polling.
- **Writes nobody is waiting on run after the response**, through `waitUntil` — the claim on an
  extraction window, not the reader's view of it.
- **The page streams.** The header lives in `app/reading/layout.tsx` and the panes render behind
  Suspense boundaries, so the frame reaches the browser without waiting for the database.

## Consequences

Measured against a local build with 120 ms of round-trip latency injected between the app and
Postgres, which is roughly what a Cloudflare edge pays to reach Tokyo. One render of
`/reading?article=…`:

| | before | after |
| --- | --- | --- |
| First byte | 1.26 s | **0.26 s** |
| Complete response | 1.26 s | **0.51 s** |
| Queries | 8 | 5, in one wave plus the header's |

Before, the first byte *was* the complete response: nothing streamed. After, the header is on the
wire at 0.26 s and the reader pane follows at 0.51 s. And that is one render — a click used to
cause up to five.

- Round trips per article click fall from about ten to one wave plus the header's profile row,
  which streams; renders per ordinary click fall from up to five to one, with one later refresh
  when a requested translation or extraction reaches a terminal result.
- Sidebar unread counts can lag by one until the next navigation, because opening an article no
  longer re-renders the page to update them. The opened row is shown as read by the render that
  opens it.
- The reading language can diverge between devices until the member changes it or signs in again.
  The settings page reads the profile row directly, so it always shows the account's value.
- There is no `loading.tsx` for `/reading`, deliberately: a route-level fallback would replace the
  sidebar and the list with a skeleton on every click. Click feedback comes from `useLinkStatus` on
  the row instead.
- `wantsExtraction` takes a body length rather than the block array, so `getArticle` can sum it in
  SQL instead of shipping the array to compute one boolean.
- Not addressed here: the erratic multi-second tail, which looks like Hyperdrive opening a cold
  origin connection through the session pooler. Hyperdrive's pools are per-location, so warming one
  does not help readers elsewhere; this needs evidence before it needs a fix. Nor are indexes —
  `articles.fetched_at` is unindexed and `listArticles` sorts on the unindexed expression
  `coalesce(published_at, fetched_at)`, which costs nothing at present volumes and will.
