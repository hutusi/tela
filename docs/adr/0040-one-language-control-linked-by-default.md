# 0040 — One language control, linked by default

Status: accepted (2026-10-07). Supersedes 0010's "`profiles.reading_lang` is independent of
`ui_locale` and defaults to it": a null reading language now follows the interface, and only a
stored one is independent. Supersedes 0038's "Read in is a menu" and "Settings chooses the
interface language from a select", and what 0037 left of its Read-in pill. Amends 0025:
`setProfile`, the one mutation settled by arrival, now goes to the later `at` like the others,
one language at a time.

## Context

A member had two languages in two places. The interface language was in Settings → Language
only. The language posts are translated into was there too, and in the header's *Read in 简体 ▾*,
a pill of some 97 to 114 px beside the 34 px theme circle. A visitor's *Read in* had the same
words and shape and set the interface language, with the titles following it. So a member who
wanted Tela in French changed the translation from the header, and then had to find Settings to
change the interface; and the same control did two different things depending on who was signed
in. `useReadingLang` already made an unset reading language follow the interface, so nothing
stood in the way of one control doing both.

Three gaps sat behind it:

- **`setProfile` was settled by arrival.** It ignored `at`, so the last push to reach tela-api
  won (0025 lists it as the one mutation last-writer-wins could not protect). That mattered little
  while the interface language changed only in Settings. A control in every header, on every
  device, makes a phone reconnecting with an older choice the normal case.
- **The page painted the choice.** `setLocale` put the chosen language on the page and pushed
  it. Once the server orders choices by their clocks, one that loses would leave the page in a
  language the account does not hold, which is the theme bug 0037 fixed.
- **A visitor's language stayed behind.** A visitor who chose Français and then joined got an
  account with no interface language: French on this browser, because of the cookie, and the
  browser's own languages on every other device. Their theme carried over (0037); their language
  did not.

## Decision

**One control: a 34 px circle**, the theme menu's size and family (`header-control.ts`), in both
headers and on `/login` (`LanguageMenu`, with `MemberLanguage` and `VisitorLanguage`). It shows
the current language in a character or two (`circleLabel`: 简, 繁, EN, FR) and opens the four
endonyms (简体中文, 繁體中文, English, Français), each in its own script and `lang`, the chosen one
`aria-pressed`. A lone 简 or 繁 would say too little as a label, which is why the pill said 简体
and 繁體. The circle is not a label, though: it is a glyph for the current choice, as the theme
menu's sun is. Its accessible name says the whole name and what it sets ("Language: 简体中文"),
and the list names all four in full. A member's shows at every width; a visitor's from `sm` up,
since the visitor header has some 35 px to spare at 360 px; the sign-in page's always. The edge
marks the language it rendered in, as before, since its cache is kept per language.
`pillLabel` keeps 简体 and 繁體 where a word has room, in the admin console's Translation area.

**Linked by default.** An account is linked exactly when `profiles.reading_lang` is null. Linked,
a choice in the circle is the interface language (`setProfile {uiLocale}`), and the translation
follows it because the account holds none of its own. Settings' *Translate into* has a first
option, *Same as interface language*, which writes null and links them again. A reading language
that equals the interface is a choice, not a link. If equal counted as linked, a member who chose
English to read while the interface was English would have their translation move the next time
they changed the interface, which is what choosing it said not to do.

**Set apart, the circle changes the translation only, and says so.** When the account holds a
reading language, a choice is `setProfile {readingLang}`. The circle's name is "Translate into:
English", its panel opens with *Translate into*, and it ends, as a linked member's does, with
*Language settings*, a link to `/settings/translation`, where the two are linked again. Which mode a choice is in is read from
the store when the choice is made, not when the menu rendered, since a sync may have changed it
in between (AGENTS.md).

**A visitor's choice** is the `tela_locale` cookie and the page, as before, and the titles follow
it.

**Each language on a clock of its own.** `setProfile` orders `ui_locale` and `reading_lang`
separately, each by the later `at` (`ui_locale_at`, `reading_lang_at`, migration 0007), the shape
`setPrivacy` has had since 0031. The row is stamped whether or not a choice won, so the next pull
hands the device the row that beat it. In `setProfile`, null is a value (follow the interface),
and a field left out is left alone, its clock included. `ProfileRow` carries both clocks, so the
prediction refuses what the server will refuse.

**The page shows what the store makes of a choice** (`chooseLocale`), as 0037 has it for the
theme: the mutation goes in, and the page takes the profile's resulting `uiLocale`. Before the
first snapshot has brought the profile, no row says otherwise, so the page takes the choice, and
the effect that applies the account's language applies whatever the row makes of it once it
lands.

**An account takes its visitor's language on joining, once** (`localeToAdopt`), as it takes their
theme. Once the first snapshot has brought the profile, an account whose `ui_locale` is null takes
the language in this browser's `tela_locale` cookie, written as `setProfile {uiLocale}`, so it
follows the member everywhere. It comes only from the cookie, a choice made here, and never from
`Accept-Language`. A browser's own languages are no choice, and an account without a language
already follows them on each browser. It is never written over a language the account holds.

**The backfill.** Migration 0007 clears `reading_lang` where it equals `ui_locale`: it bumps the
sequence, then stamps the rows it changes with it (invariant 7), so devices pull them. Those
members read exactly as a linked member does now, so clearing it changes nothing they see, and
links the two from then on. Where `ui_locale` is null, `reading_lang` is kept: there is no
interface choice for it to equal, and the reading language was one.

## Consequences

- No `MIN_CLIENT` bump. An older shell reads `readingLang: null` as following the interface
  (`useReadingLang`), and its *Read in* writes a reading language, which sets the account apart.
  That is right for a shell that offers no way to link them.
- Deploys keep their order, tela-jobs, tela-api, then tela-web: a tela-web that lands first sends
  `readingLang: null` to a tela-api whose schema refuses it, and *Same as interface language*
  visibly goes back.
- On a device whose clock runs behind another's, a choice can appear to do nothing: the page stays
  in the language the account holds. The theme behaves the same. It is documented, not fixed.
- A browser shared by two accounts gives the second, if it has no language yet, whatever the first
  left in the cookie. That is the language that member is looking at, as with the theme.
- A member's panel ends with *Language settings*, linked or apart: Settings → Language is where
  the two are set apart and linked again, and a linked member has no other way to find it from
  the header. A visitor's has no link, having no Settings.
- The header has room again. At 640 px the member's row has 141 px to spare (72 px beside the
  button), and the visitor's 161 px; on a phone, 196 px of the member's 247 px nav shows at 360 px
  (122 px before). A fifth language costs the header nothing: it needs a `CIRCLE_LABELS` entry,
  and the specs hold the circle at 34 × 34 px.
