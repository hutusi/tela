/**
 * The shape of About, Privacy and Terms (ADR 0035). Their prose lives in one module per locale
 * rather than in the message catalogues: it is long, it carries links, and it is reviewed as one
 * document per language. `satisfies InfoContent` in each module makes the compiler hold every
 * locale to every section.
 */

export const INFO_PAGES = ['about', 'privacy', 'terms'] as const
export type InfoPageId = (typeof INFO_PAGES)[number]

/**
 * Each page's sections, in order. The ids are the anchors in every locale, so `/privacy#cookies`
 * lands on the same section whichever language the page is shown in.
 */
export const INFO_SECTIONS = {
  about: ['why', 'built', 'maker', 'more', 'hello'],
  privacy: [
    'collect',
    'public',
    'use',
    'translation',
    'others',
    'cookies',
    'keep',
    'choices',
    'changes',
    'contact',
  ],
  terms: [
    'who',
    'account',
    'handle',
    'writers',
    'claims',
    'posts',
    'dont',
    'service',
    'responsibility',
    'changes',
    'contact',
  ],
} as const satisfies Record<InfoPageId, readonly string[]>

export type SectionId<P extends InfoPageId> = (typeof INFO_SECTIONS)[P][number]

/**
 * A paragraph, a subheading, a bulleted list, or named entries (a principle, a product, a
 * company), numbered when `numbered`. Text may hold inline links as `[text](href)`, https or
 * relative only (`lib/inline-links.tsx`).
 */
export type Block =
  | { p: string }
  | { h: string }
  | { list: readonly string[] }
  | { entries: readonly { name: string; text: string }[]; numbered?: true }

export type Section = { heading: string; blocks: readonly Block[] }

export type InfoPage<P extends InfoPageId> = {
  kicker?: string
  title: string
  lede?: string
  /** "The short version": what the page says, in a few lines. */
  short: readonly string[]
  sections: Record<SectionId<P>, Section>
}

export type InfoContent = { [P in InfoPageId]: InfoPage<P> }

/** When the pages last changed, shown on each as "Last updated", formatted per locale. */
export const INFO_UPDATED = '2026-10-02'

export function isInfoPage(value: string): value is InfoPageId {
  return (INFO_PAGES as readonly string[]).includes(value)
}
