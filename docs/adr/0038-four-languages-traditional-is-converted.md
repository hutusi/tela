# 0038 — Four languages, and Traditional Chinese is converted, never translated

Status: accepted (2026-10-04). Supersedes 0006's list of targets (`zh-Hans`, `en`) and 0037's
two-button Read in pill. Corrects 0010's catalog path (`apps/reader/messages`, not
`apps/web/messages`). The rest of 0006, including the eager-title, lazy-body policy and the cost
controls, stands.

## Context

Tela read and spoke two languages, Simplified Chinese and English, in two lists:
`READING_LANGUAGES` (what posts are translated into) and `UI_LOCALES` (the interface). The owner
asked for Traditional Chinese and French in both.

Adding `zh-Hant` to the reading languages the obvious way would have paid the model to rewrite
every Simplified post "from Simplified Chinese into Traditional Chinese". That is a script
conversion with a regional vocabulary, not a translation. It would also have failed often:
paragraphs written only in characters the two scripts share come back unchanged, and the echo
check (`validate.ts`) refuses those blocks, so the body renders `partial`. OpenCC does the same
job deterministically and for nothing.

French is an ordinary target. As a reading language it adds one paid title call per post, plus the
archive's titles once. As an interface language it adds a catalog and the About, Privacy and Terms
prose, and from now on a French version of every string any later change adds.

Four options also stopped fitting the header. The member header had 38px to spare at 640px, and the
Read in pill drew every language as its own button. 0037 chose the pill because, with two
languages, both in view and one press beat a menu. That reason ends at two.

Locale negotiation was `languages.some(l => l.startsWith('zh')) ? 'zh-Hans' : 'en'`. A `zh-TW`
browser got Simplified, a French one English, and an English one that listed Chinese as a distant
fallback got Chinese.

## Decision

**Four languages, in both lists:** `zh-Hans`, `zh-Hant`, `en`, `fr`. `UI_LOCALES` is typed as a
subset of `READING_LANGUAGES`: a visitor reads in their interface's language (the edge passes one
as the other), so the two lists must not drift apart.

**The model writes Simplified, and OpenCC writes Traditional,** with Taiwan phrasing (`cn → twp`:
软件 → 軟體, 视频 → 影片). The model is never asked for `zh-Hant`.

- **Between the two scripts there is no model call.** A Simplified post's Traditional title and
  body are converted from the source, and a Traditional post's Simplified ones the other way, with
  no usage, no `llm_calls` row and nothing reserved against the member's allowance. A conversion
  has its own rate limit (`convert`, 600 an hour): a Traditional reader opens one with every
  Simplified post, and counted against the paid 30 an hour, a morning's reading would refuse the
  next real translation. tela-api judges a conversion by the article's language and the job by the
  stored body's, which every article with that body shares, so the job never pays for a request
  that reserved nothing, and settles one already in the language asked for. The rows say `opencc:twp` or `opencc:cn` where a model's
  name would be.
- **From any other language, Traditional pivots through Simplified.** Titles are grouped by what
  the model writes, so one Simplified call writes both Chinese rows, and a post whose Simplified
  row is already current (the whole archive, on the day this deploys) has its Traditional row
  converted from it. A Traditional body asks the model for Simplified, caches that, and converts
  it on the way out, so a Simplified reader of the same post, once that has finished, pays
  nothing. An English or French post costs two paid title calls, not three.
- **Two Chinese requests that overlap both pay.** The Simplified and Traditional bodies of one post
  are two rows under two leases, and each reads the shared cache once, as it starts, so two that
  run at once (two readers, or one switching 简中 to 繁中 while a body streams) each ask the model
  for every block. That is what translating Traditional separately would cost every time, so the
  pivot is never worse than not having it. Coordinating the two would put a waiting state into the
  lease and streaming code, which is where this repository's costliest defects have been; for at
  most one extra body a post, the cost is measured instead (OPERATIONS.md, "Translation"), and
  the coordination is built if that ever finds it.
- **The block cache holds only what a model wrote.** A conversion costs about a millisecond, and a
  cache row costs a write and storage for ever, so Traditional is converted from the Simplified
  entry whenever it is read. Every converted block's placeholders are checked like a model's.
- **The dictionaries are OpenCC's, and the matcher is ours.** opencc-js builds a trie of nested
  `Map`s: 40 MB of heap for `cn → twp` as `Converter` builds it (it segments first), 21 MB as
  `ConverterFactory` does. tela-jobs has 128 MB per isolate and also parses whole pages.
  `packages/llm/src/zh-script.ts` keeps one flat `Map` per step of the chain and replaces the
  longest key at each position, as `ConverterFactory` does, in about 5 MB. A test holds its
  output to `ConverterFactory`'s on every phrase key in both directions. Only tela-jobs bundles
  the dictionaries (about 560 KB gzipped); tela-api compares the two tags itself instead of
  importing `@tela/llm`.
- **The interface uses the same converter.** The Traditional catalog and info pages are generated
  from the Simplified ones at authoring time (`bun run i18n:hant`), with Taiwan's 「」 for quotes
  and an override list for interface usage OpenCC leaves in mainland form (郵箱 → 電子郵件,
  關注 → 追蹤, 儀表盤 → 儀表板). A test fails when they drift, and nobody edits `zh-Hant.json`
  by hand.

**French is written by hand,** in a full catalog and info module. Where French grammar needs data
Tela does not hold, the copy is reworded rather than guessed: activity lines use nouns, not
participles that agree with a member's gender. Language names are stored lower case, as French
writes them mid-sentence, and `asLabel` capitalises one that starts a label. Quotation marks
around a member's note are a message of their own (“…”, 「…」, « … »).

**Read in is a menu:** a button showing the current language (简中, 繁中, EN, FR) that opens the
four endonyms, each in its own script. It is narrower than the pill was. Members, visitors and the
login page share it, as they shared the pill. Settings chooses the interface language from a
select, like the translation language.

**Negotiation reads Accept-Language by preference.** `preferredLanguages` orders the tags by `q`,
`normalizeLangTag` maps `zh-TW`, `zh-HK` and `zh-Hant*` to `zh-Hant` and every other regional tag
to its primary subtag, and `negotiateLocale` takes the first tag Tela has, else English. The cookie
still wins over all of it.

**Traditional glyphs:** `:lang(zh-Hant)` puts the TC families (PingFang TC, Noto Sans CJK TC,
Songti TC, Noto Serif CJK TC) first, for the interface and for any body in Traditional.

**A feed's declared Traditional breaks a script tie.** Detection counts characters that exist in
only one script. A short title that has none of them used to be Simplified, whatever the feed said.
Now the hint's script decides a tie.

## Consequences

- No migration and no `MIN_CLIENT` bump. Every language column is plain text, an older client
  ignores an interface language it does not know, and it falls back from a reading language it
  does not know.
- Turning the list on makes the whole archive's titles due in French (paid, under
  `LLM_DAILY_BUDGET_TOKENS`) and in Traditional (free). `titleIsDue` has no age limit.
- The two new interface languages took the one SPA chunk from 192 KB to 218 KB gzipped, about
  13 KB each, and OpenCC appears in neither the SPA nor tela-web. Catalogs stay static
  imports: the shell's service worker caches what the shell loads, and a lazily loaded catalog
  would be a chunk it never saw. Revisit at a fifth language.
- Mail stays English plus Simplified Chinese. The sign-in and invite mails go out before an
  account, and so a language, exists.
- A Traditional reader of a mainland blog, and a Simplified reader of a Taiwanese one, now get the
  post in their own script at no cost. Before, they got it as written.
