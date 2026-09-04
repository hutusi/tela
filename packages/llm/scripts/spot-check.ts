/**
 * Translate a few fixture paragraphs with the configured provider and print source and
 * target side by side, with token usage. Costs real money with a real provider.
 *   LLM_PROVIDER=bailian BAILIAN_API_KEY=… bun run scripts/spot-check.ts [targetLang]
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseFeedText, processArticleHtml } from '@tela/content'
import { plainText } from '@tela/content/tagged'
import { configFromEnv, createTranslator, translateBlocks } from '../src'

const targetLang = process.argv[2] ?? 'zh-Hans'
const config = configFromEnv(process.env)
const translator = createTranslator(config)
console.log(`provider=${config.provider} model=${translator.model} target=${targetLang}\n`)

const fixtures = join(import.meta.dir, '..', '..', 'content', 'fixtures', 'feeds')
const feed = parseFeedText(
  readFileSync(join(fixtures, 'jvns.atom.xml'), 'utf8'),
  'https://jvns.ca/atom.xml',
)
const item = feed.items[0]
if (!item) throw new Error('fixture has no items')
const processed = await processArticleHtml({
  html: item.contentHtml ?? '',
  baseUrl: item.url ?? '',
})
const blocks = Object.entries(processed.tagged)
  .slice(0, 6)
  .map(([id, text]) => ({ id, text }))

const started = Date.now()
const out = await translateBlocks(translator, {
  blocks,
  sourceLang: processed.lang,
  targetLang,
  context: { title: item.title, siteTitle: feed.title },
})
for (const b of blocks) {
  console.log('─'.repeat(80))
  console.log(plainText(b.text))
  console.log()
  const t = out.translated.get(b.id)
  console.log(t ? plainText(t) : `✗ ${out.failed.find((f) => f.id === b.id)?.reason}`)
}
console.log('─'.repeat(80))
const tokens = out.usage.reduce((n, u) => n + u.inputTokens + u.outputTokens, 0)
console.log(
  `${out.translated.size}/${blocks.length} blocks, ${tokens} tokens, ${Date.now() - started} ms`,
)
