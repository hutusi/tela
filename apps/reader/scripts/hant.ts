#!/usr/bin/env bun
/**
 * Writes the Traditional Chinese interface from the Simplified one. Nobody writes Traditional by
 * hand: `messages/zh-Hant.json` and `src/content/info/zh-Hant.ts` are their `zh-Hans` sources run
 * through OpenCC with Taiwan phrasing (`cn` → `twp`), by the same converter that writes posts in
 * Traditional (`@tela/llm/zh-script`), with Taiwan's corner quotes for curly ones
 * (“ ” → 「 」, ‘ ’ → 『 』), and then through `messages/zh-Hant.overrides.json`: [from, to]
 * pairs, applied in order, for what OpenCC leaves in mainland usage (郵箱, 賬號, 關注, 儀表盤) or
 * converts wrongly in an interface (釋出 for "publish", 麵板 for "panel").
 *
 * The admin console's catalogues (`src/admin/messages/zh-Hans/*.json`, ADR 0039) are converted the
 * same way, into `src/admin/messages/zh-Hant/`, and so is the mail tela-api sends
 * (`apps/api/src/mail-text/zh-Hans.json`), which tela-api cannot convert as it sends: the
 * dictionaries would add about 560 KB gzipped to a Worker that only needs these few lines. Where a
 * mail says 邮箱 for the mailbox rather than the address, the overrides make it 信箱.
 *
 * Run `bun run i18n:hant` after changing a Simplified file and commit what it writes;
 * `test/hant.test.ts` fails while they disagree. `@tela/llm` is a devDependency that only this
 * script and that test import, so OpenCC never reaches a bundle.
 *
 * Only Han characters and quotation marks may change. Every other character of each file (keys,
 * ICU arguments and plurals, rich-text tags, links, the module's code) is checked to come out
 * exactly as it went in, and an override that no longer matches anything is an error, so the list
 * stays a list of real fixes. The output goes through Biome last: a phrase that grows (郵箱 →
 * 電子郵件) can push a line past the width, and a file Biome would rewrite could never match.
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toTraditional } from '@tela/llm/zh-script'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BIOME = join(ROOT, '../../node_modules/.bin/biome')

const OVERRIDES = 'messages/zh-Hant.overrides.json'
const ADMIN_MESSAGES = 'src/admin/messages'
/** tela-api's mail catalogues, from this app's directory. */
const MAIL_TEXT = '../api/src/mail-text'

type Pair = readonly [from: string, to: string]

const QUOTES: readonly Pair[] = [
  ['“', '「'],
  ['”', '」'],
  ['‘', '『'],
  ['’', '』'],
]

/** The Traditional module's own doc comment, in place of the Simplified one's. */
const INFO_HEADER = `/**
 * About, Privacy and Terms in Traditional Chinese, Taiwan phrasing. Generated from \`zh-Hans.ts\` by
 * \`bun run i18n:hant\` (scripts/hant.ts): change the Simplified module and run that, never this one.
 */
`
const INFO_DECLARATION = ['export const zhHans = {', 'export const zhHant = {'] as const

/** What a file is once everything a conversion may change is taken out. */
function skeleton(text: string): string {
  return text.replace(/[\p{Script=Han}“”‘’「」『』]/gu, '')
}

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8')
}

function formatted(path: string, text: string): string {
  return execFileSync(BIOME, ['format', `--stdin-file-path=${join(ROOT, path)}`], {
    input: text,
    encoding: 'utf8',
  })
}

function overrides(): Pair[] {
  const parsed: unknown = JSON.parse(read(OVERRIDES))
  const valid =
    Array.isArray(parsed) &&
    parsed.every(
      (pair) =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        pair.every((s) => typeof s === 'string' && s !== '') &&
        pair[0] !== pair[1],
    )
  if (!valid) throw new Error(`${OVERRIDES} must be a list of [from, to] pairs of different text`)
  return parsed as Pair[]
}

function converter(pairs: readonly Pair[]) {
  const used = new Set<number>()
  return {
    convert(name: string, text: string): string {
      let out = toTraditional(text)
      for (const [from, to] of QUOTES) out = out.replaceAll(from, to)
      pairs.forEach(([from, to], i) => {
        if (!out.includes(from)) return
        used.add(i)
        out = out.replaceAll(from, to)
      })
      const before = skeleton(text)
      const after = skeleton(out)
      if (after !== before) {
        let at = 0
        while (before[at] === after[at]) at++
        throw new Error(
          `${name}: converting changed more than Han characters and quotes, near ${JSON.stringify(
            after.slice(Math.max(0, at - 20), at + 20),
          )}`,
        )
      }
      return out
    },
    unused: () => pairs.filter((_, i) => !used.has(i)),
  }
}

export type Generated = { path: string; text: string }

/** The Traditional files, as `bun run i18n:hant` writes them. */
export function generate(): Generated[] {
  const { convert, unused } = converter(overrides())

  const messages = convert('messages/zh-Hans.json', read('messages/zh-Hans.json'))
  JSON.parse(messages)

  const source = read('src/content/info/zh-Hans.ts')
  const header = source.match(/^\/\*\*[\s\S]*?\*\/\n/)?.[0]
  const [from, to] = INFO_DECLARATION
  if (!header || !source.includes(from)) {
    throw new Error(`src/content/info/zh-Hans.ts must open with a doc comment and declare ${from}`)
  }
  const info =
    INFO_HEADER + convert('info/zh-Hans.ts', source.slice(header.length)).replace(from, to)

  const admin = readdirSync(join(ROOT, ADMIN_MESSAGES, 'zh-Hans'))
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const text = convert(`admin/${name}`, read(`${ADMIN_MESSAGES}/zh-Hans/${name}`))
      JSON.parse(text)
      return { path: `${ADMIN_MESSAGES}/zh-Hant/${name}`, text }
    })

  const mail = convert('mail-text/zh-Hans.json', read(`${MAIL_TEXT}/zh-Hans.json`))
  JSON.parse(mail)

  const stale = unused()
  if (stale.length > 0) {
    throw new Error(
      `${OVERRIDES}: ${stale.map((p) => p.join(' → ')).join(', ')} no longer match anything; remove them`,
    )
  }
  return [
    { path: 'messages/zh-Hant.json', text: messages },
    { path: 'src/content/info/zh-Hant.ts', text: info },
    ...admin,
    { path: `${MAIL_TEXT}/zh-Hant.json`, text: mail },
  ].map(({ path, text }) => ({ path, text: formatted(path, text) }))
}

if (import.meta.main) {
  for (const { path, text } of generate()) {
    writeFileSync(join(ROOT, path), text)
    console.log(`wrote ${path}`)
  }
}
