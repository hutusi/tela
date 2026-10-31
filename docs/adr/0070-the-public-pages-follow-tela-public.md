# 0070 — The public pages follow Tela Public, and how Tela reads a blog has its own page

Status: accepted (2026-10-31). Amends 0035 (the front page's layout), 0037 (the sample card is
drawn on the page's own ground) and 0061 (For writers no longer holds how Tela reads a blog: it is
`/bot`).

## Context

The front page, For writers and the sections under it were built from three earlier designs
(*Tela Landing*, *For Writers v2*, ADR 0061's copy). Each was faithful on its own, and together they
read as a brochure: bordered cards, a colour square before every blog, an uppercase label over every
part, a language tag and a reading time on every post, italic notes, green links, green accents in
the headlines. For writers had grown to ten sections, the last four of which (how Tela fetches,
what it shows, how a claim is proved, how to say no) are for a writer deciding whether to let Tela
near their blog, and for whoever runs their server, rather than for someone making a card.

Claude Design's *Tela Public* (project faa36827…, `Tela Public.dc.html` and its notes) sets one
quieter language for every signed-out page, and splits For writers in two.

## Decision

**The front page, For writers and How Tela reads your blog take Tela Public's type and layout.**
Shared in `views/public-type.ts` and `views/doc.tsx`:

- A 1120px measure. Serif heads in sentence case, never uppercase letter-spaced labels; running
  text in `font-text` (the serif in Latin, the script's sans in Chinese, Japanese and Korean).
- Per-script steps (`--hs`, `--ts`, `--bs`) with weights, line heights and spacing, set where a
  `lang` is (`styles.css`): a Chinese head is 0.82 of the Latin size at weight 600, on looser
  lines, never broken inside a word. A Chinese title on an English page scales by itself.
- Rules between things, not cards around them. On the front page posts are type: the lead beside a
  column of three, and the rest in columns under both, each a title, the other title under it, and
  the blog, who wrote it and when. No colour square, language label, reading time or "Read →".
- No italics, and green is the logo's: every link is ink or the quieter ink, underlined under the
  pointer, and a text link that goes somewhere ("How Tela reads your blog →") is underlined in the
  `underline` token. Two tokens join the palette: `line-soft` (a rule inside a card) and
  `underline`.

**How Tela reads your blog is its own page, `/bot`.** The reading section, what Tela shows and
"Your blog stays yours" move there, with the two notes that were about crawling (how a claim's
check reads the blog, and how a robots.txt group naming Tela works). For writers keeps the card,
the sample Following page, what the card does, how it works, claiming and opting out, in one
680px column, and links to `/bot` at its foot. `/bot` is a public page like `/writers`: no data,
rendered at the edge in four languages, in the sitemap, robots.txt's own pages and llms.txt, and
named in `run_worker_first`. The sections keep their anchors (`#reading`, `#shows`, `#yours`); a
link to them on `/writers` is sent on to `/bot` once the app runs. The edge cannot see a hash,
so without JavaScript an old link lands at the top of For writers, which links to `/bot`.

**The sample card follows the theme.** It was a light paper card on either ground (the `.paper`
scope, from *For Writers v2*); it is now a card on `surface` like any other, upright, with no
colour dots or green check, its counts on one line, and Follow drawn as an outlined pill. It shows
only what Tela does, as ADR 0037 says: no pinned post and no "recommended by" line, which the design
draws and Tela does not have. "What your card does" loses its three illustrations.

**The owner's decisions (2026-10-31).**

- Titles and subtitles keep their words in the new style: "A confluence of N independent blogs.",
  the intro under it, "Write a blog? Make it your calling card.", For writers' lede, "N blogs are
  already on Tela. Where's yours?". The accents (`<em>` in green) go and the words stay.
- For writers' headline is "Your calling card." (你的名片。, Votre carte de visite.), with "For
  writers" as the small line above it, in place of "Your calling card as an independent writer."
- The front page keeps Join and Log in; the design's invite-only note beside Join is not used,
  since the edge cannot know the sign-up switch and the note would be wrong after open sign-up.
- Filled pills keep the `primary` token, green at night as the header's Join is. Moving it to
  ink everywhere belongs to the reader-wide round the design's notes list.
- The front page's "Titles in" control keeps its look (a pill with the chosen side in ink), at the
  size the new head needs, rather than the design's segmented control.
- "What claiming gives you" stays under Claiming your blog, though the design dropped it: it is
  the one place that says a claimed blog is listed in Discover under its writer's name.

## Consequences

- `/bot` is a new address to keep. The Dashboard's "How Tela reads your blog" goes there.
- The header is unchanged, and the rest of Tela Public (Discover, a blog's page, a profile, a
  blogroll, the sign-in page) is not done here; nor are its Chinese webfonts (Noto Serif SC/TC
  served from telaread.com), the word joiner that keeps a Chinese line from ending on one or two
  characters, or pointing the user agent's `+https://telaread.com` at `/bot`.
- The footer moves to the 1120px measure everywhere it is drawn, the info pages' included.
