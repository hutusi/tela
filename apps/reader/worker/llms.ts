/**
 * `/llms.txt` (ADR 0060, llmstxt.org): what Tela is, its key pages in each interface language,
 * its feeds and sitemap, and how to cite what it shows, for a language model reading the site.
 * Written in English, with each language's page names from the catalogues. The same for every
 * request but its origin, so it is made once per origin and kept.
 */
import { UI_LOCALES, type UiLocale } from '@tela/shared'
import { createTranslator } from 'use-intl'
import { MESSAGES } from '../src/i18n'
import { DISCOVER_TABS, type DiscoverTab, tabHref } from '../src/lib/discover-href'
import { withHl } from '../src/lib/head'

/** Each language's name for itself. */
const NATIVE: Record<UiLocale, string> = {
  en: 'English',
  fr: 'Français',
  'zh-Hans': '简体中文',
  'zh-Hant': '繁體中文',
}

/** What each Discover tab holds, for the English list. */
const TABS: Record<DiscoverTab, string> = {
  week: 'the week on Tela: recommended posts, the newest post of each blog, new blogs',
  articles: 'posts from every public blog, most recommended or newest first',
  blogs: 'the directory of public blogs, by topic and language',
  blogrolls: 'lists of blogs that members recommend as a set',
  readers: 'members worth following, by what they recommend',
}

export function llmsTxt(origin: string): string {
  const at = (path: string, locale: UiLocale | null = null) => `${origin}${withHl(path, locale)}`
  const t = createTranslator({ locale: 'en', messages: MESSAGES.en })
  const languages = UI_LOCALES.filter((locale) => locale !== 'en').map((locale) => {
    const l = createTranslator({ locale, messages: MESSAGES[locale] })
    const pages = [
      [l('nav.discover'), tabHref('week')],
      [l('writers.title'), '/writers'],
      [l('writers.reading.title'), '/bot'],
      [l('info.tabs.about'), '/about'],
      [l('info.tabs.privacy'), '/privacy'],
      [l('info.tabs.terms'), '/terms'],
    ] as const
    return `- ${NATIVE[locale]} (\`?hl=${locale}\`): ${pages
      .map(([name, path]) => `[${name}](${at(path, locale)})`)
      .join(', ')}`
  })
  return [
    '# Tela',
    '',
    "> Tela is a reader and gathering place for independent blogs from around the world, each in its own language. Members subscribe to blogs' feeds, writers claim their blogs and see who reads them, and titles are translated into Simplified or Traditional Chinese, English or French; a post opened in Tela reads beside its translation, paragraph by paragraph.",
    '',
    "Tela's public pages show what a blog's feed gives: a post's title, a short excerpt, the blog's name and a link to the post on the blog itself. They never show a post's full text. A title may be shown machine-translated into the reader's language.",
    '',
    'Every public page is in four languages. Without `?hl=` a page is in the language the browser asks for; `?hl=en`, `?hl=fr`, `?hl=zh-Hans` or `?hl=zh-Hant` fixes it, and each page names the others as alternates.',
    '',
    '## Key pages',
    '',
    `- [Home](${at('/')}): this week's newest post from each public blog`,
    ...DISCOVER_TABS.map(
      (tab) => `- [Discover: ${t(`discover.tabs.${tab}`)}](${at(tabHref(tab))}): ${TABS[tab]}`,
    ),
    `- [${t('writers.title')}](${at('/writers')}): a writer's card on Tela, how a writer claims their blog, and how to opt out`,
    `- [${t('writers.reading.title')}](${at('/bot')}): how Tela fetches a blog's feed, pages and images, and what it shows of them`,
    `- [${t('info.tabs.about')}](${at('/about')}): what Tela is and who runs it`,
    `- [${t('info.tabs.privacy')}](${at('/privacy')}): what Tela keeps and why`,
    `- [${t('info.tabs.terms')}](${at('/terms')}): the terms of use`,
    '',
    '## In other languages',
    '',
    ...languages,
    '',
    '## Feeds and lists',
    '',
    `- [Discover's newest posts, as RSS](${at('/discover/articles.rss')})`,
    `- [Discover's blogs, as OPML](${at('/discover.opml')})`,
    `- A public blogroll's blogs and recent posts: \`${origin}/l/<id>.opml\` and \`${origin}/l/<id>.rss\``,
    `- [Sitemap](${at('/sitemap.xml')}): every page search engines may index, in each language`,
    '',
    '## How to cite',
    '',
    "- Cite the original post, at its own address on the writer's blog, and name the blog and its writer. Every post Tela lists links there.",
    "- Link a blog's page on Tela (`/s/<id>`) only when you mean Tela's view of it: who reads and recommends it.",
    '- Quote a title in its original language; a translated title is a machine translation.',
    "- A member's profile (`/@handle`) and their notes are their own words, under their name.",
    '',
    '## Optional',
    '',
    `- [robots.txt](${at('/robots.txt')}): search engines and AI search and answer tools may read every public page; AI training crawlers may read only Tela's own pages, such as this one.`,
    '',
  ].join('\n')
}
