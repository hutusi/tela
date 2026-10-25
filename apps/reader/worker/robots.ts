/**
 * robots.txt (ADR 0060). Search engines and the AI tools that search and answer for a person are
 * welcome on every public page; AI training crawlers may read Tela's own pages (the front page,
 * About, Privacy, Terms, For writers, llms.txt) and nothing that shows a writer's work: blogs,
 * blogrolls, profiles, Discover. The writers did not agree to train anyone's model by being read
 * on Tela, and the excerpts and titles there are theirs.
 *
 * The training group is an allow list: whatever a later page adds is closed to it until it is
 * named here. A crawler obeys the one group that names it and ignores `*`, so each group says
 * everything its crawlers may and may not read. The Content-Signal line says the same for
 * whoever reads it (Cloudflare's Content Signals Policy, contentsignals.org).
 *
 * While TELA_NOINDEX is set, the answer is `Disallow: /` and nothing else.
 */

/**
 * AI tools that fetch a page to answer a person's question or to cite it in search, not to train:
 * the same rules as every search engine. Named so the policy reads as a decision, and so a
 * change to `*` cannot close them by accident.
 */
export const ANSWER_AGENTS = [
  'OAI-SearchBot',
  'ChatGPT-User',
  'Claude-SearchBot',
  'Claude-User',
  'PerplexityBot',
  'Perplexity-User',
  'DuckAssistBot',
  'MistralAI-User',
  'Meta-ExternalFetcher',
  'YouBot',
] as const

/**
 * Crawlers, and robots.txt tokens, that gather pages to train models: kept to Tela's own copy.
 * Google-Extended and Applebot-Extended are tokens, not crawlers: they say whether what Google's
 * and Apple's own crawlers fetch may train their models, and their searches are untouched.
 */
export const TRAINING_AGENTS = [
  'GPTBot',
  'ClaudeBot',
  'anthropic-ai',
  'CCBot',
  'Google-Extended',
  'Applebot-Extended',
  'Bytespider',
  'meta-externalagent',
  'FacebookBot',
  'Amazonbot',
  'cohere-training-data-crawler',
  'Diffbot',
  'AI2Bot',
  'Ai2Bot-Dolma',
  'Omgilibot',
  'Webzio-Extended',
  'PanguBot',
  'Timpibot',
  'ImagesiftBot',
  'img2dataset',
] as const

/** Tela's own copy: what a training crawler may read. `$` ends a path: `/` alone, not under it. */
export const OWN_PAGES = ['/$', '/about', '/privacy', '/terms', '/writers', '/llms.txt'] as const

/**
 * What no crawler reads: the API, members' objects and pictures, and the app's own pages, which
 * are the app's shell with nothing to index (and `/join?code=` carries an invitation).
 */
export const CLOSED_PATHS = [
  '/api/',
  '/o/',
  '/img/',
  '/avatar/',
  '/__tela/',
  '/join',
  '/login',
  '/reading',
  '/following',
  '/search',
  '/add',
  '/settings',
  '/dashboard',
  '/claim',
  '/sites/',
  '/admin',
] as const

export const CONTENT_SIGNAL = 'search=yes, ai-input=yes, ai-train=no'

export function robotsTxt({ origin, noindex }: { origin: string; noindex: boolean }): string {
  if (noindex) return 'User-agent: *\nDisallow: /\n'
  const agents = (names: readonly string[]) => names.map((name) => `User-agent: ${name}`)
  return [
    '# Tela: independent blogs, in four languages.',
    '# Search engines and AI search and answer tools are welcome on every public page.',
    "# AI training crawlers may read Tela's own pages, not the pages that show writers' work.",
    `# For writers: ${origin}/writers`,
    '',
    ...agents(['*', ...ANSWER_AGENTS]),
    `Content-Signal: ${CONTENT_SIGNAL}`,
    'Allow: /',
    ...CLOSED_PATHS.map((path) => `Disallow: ${path}`),
    '',
    ...agents(TRAINING_AGENTS),
    `Content-Signal: ${CONTENT_SIGNAL}`,
    ...OWN_PAGES.map((path) => `Allow: ${path}`),
    'Disallow: /',
    '',
    `Sitemap: ${origin}/sitemap.xml`,
    '',
  ].join('\n')
}
