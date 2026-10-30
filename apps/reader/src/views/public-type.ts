/**
 * The public pages' type and controls, from Claude Design's Tela Public (ADR 0070): the front
 * page, For writers and How Tela reads your blog share them. Serif heads in sentence case, running
 * text in `font-text`, rules between things rather than cards around them, and ink rather than
 * green for every link. Sizes are the Latin ones, times the script's step (`--hs` for heads, `--ts`
 * for titles, `--bs` for running text), and weights, line heights and spacing come from the
 * variables `styles.css` sets per `lang`, so a Chinese page sets its type as the design does.
 */

/** The pages' measure: 1120px, with 20px sides on a phone and 48px from `md`. */
export const PAGE = 'mx-auto w-full max-w-[1120px] flex-1 px-5 md:px-12'

/** A page's title, the h1; each page adds its own size, as `[font-size:calc(…*var(--hs))]`. */
export const TITLE =
  'm-0 font-serif [font-weight:var(--hw)] leading-(--lh-t) text-balance text-ink [letter-spacing:var(--track-t)] [word-break:var(--wb)]'

/** A section's head, the h2; each use adds its size and line height. */
export const HEAD =
  'm-0 font-serif text-balance text-ink [font-weight:var(--hw)] [letter-spacing:var(--track-s)] [word-break:var(--wb)]'

/** A post's title wherever posts are listed; each list adds its size. */
export const POST_TITLE =
  'm-0 font-serif leading-(--lh-h) text-pretty text-ink [overflow-wrap:break-word] [font-weight:var(--hw)] [letter-spacing:var(--track-s)]'

/** The paragraph under a page's title. */
export const STANDFIRST = 'm-0 font-text leading-(--lh-p) text-pretty'

/** Running text in a section: a point's explanation, a section's closing paragraph. */
export const BODY =
  'm-0 font-text leading-(--lh-p) text-pretty text-body [font-size:calc(17.5px*var(--bs))]'

/** A section's opening paragraph, a step larger than its points. */
export const INTRO =
  'm-0 mt-3 font-text leading-(--lh-p) text-pretty text-body [font-size:calc(18.5px*var(--bs))]'

/** A point's short heading inside a section. */
export const ITEM = 'm-0 font-sans text-[16px] leading-[1.4] font-semibold text-ink'

/** A small line of facts: a date, a byline, a caption. */
export const META = 'text-[13.5px] leading-normal text-muted'

/** A title or a name that links: ink, underlined only under the pointer. */
export const LINK =
  'text-ink hover:text-ink hover:underline hover:decoration-1 hover:underline-offset-[0.2em]'

/** A link in a byline: the quieter ink, ink under the pointer. */
export const QUIET_LINK =
  'text-ink-2 hover:text-ink hover:underline hover:decoration-1 hover:underline-offset-[0.2em]'

/** A link for going somewhere ("For writers →"): underlined in the quiet rule colour. */
export const TEXT_LINK =
  'font-medium text-ink underline decoration-underline underline-offset-4 hover:text-ink hover:decoration-current'

/** A page's one main action, filled: Join Tela, Claim your card, Make your card. */
export const PILL =
  'inline-flex h-11 shrink-0 items-center justify-center rounded-full bg-primary px-6 text-[15px] font-medium whitespace-nowrap text-on-primary hover:text-on-primary hover:no-underline hover:brightness-110 disabled:opacity-60'

/** The action beside it, outlined: Log in, Your card. */
export const PILL_QUIET =
  'inline-flex h-11 shrink-0 items-center justify-center rounded-full border border-thumb px-[22px] text-[15px] font-medium whitespace-nowrap text-ink hover:border-ink hover:text-ink hover:no-underline'

/** Code in running text: a header, a user agent, a tag. */
export const CODE = 'rounded bg-hover px-1 py-px font-mono text-[0.8em] [overflow-wrap:anywhere]'

/** A block of code to copy: what goes in robots.txt. */
export const PRE =
  'm-0 mt-3 overflow-x-auto rounded-lg bg-hover px-4 py-3.5 font-mono text-[13.5px] leading-[1.6] text-ink'
