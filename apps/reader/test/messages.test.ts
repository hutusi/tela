import { describe, expect, test } from 'bun:test'
import { type MessageFormatElement, parse, TYPE } from '@formatjs/icu-messageformat-parser'
import fr from '../messages/fr.json'
import { ADMIN_MESSAGES } from '../src/admin/i18n'
import { fr as frInfo } from '../src/content/info/fr'
import { MESSAGES } from '../src/i18n'

/** Every string in a catalogue by its path, such as `door.errors.rate_limited`. */
function strings(messages: object, prefix = ''): Map<string, string> {
  const out = new Map<string, string>()
  for (const [key, value] of Object.entries(messages)) {
    if (value !== null && typeof value === 'object') {
      for (const [k, v] of strings(value, `${prefix}${key}.`)) out.set(k, v)
    } else out.set(`${prefix}${key}`, String(value))
  }
  return out
}

/** The arguments a message reads and the rich-text tags it renders, from use-intl's own parser. */
function shape(message: string): { args: string[]; tags: string[] } {
  const args = new Set<string>()
  const tags = new Set<string>()
  const walk = (elements: MessageFormatElement[]) => {
    for (const el of elements) {
      if (el.type === TYPE.tag) {
        tags.add(el.value)
        walk(el.children)
      } else if (el.type === TYPE.plural || el.type === TYPE.select) {
        args.add(el.value)
        for (const option of Object.values(el.options)) walk(option.value)
      } else if (
        el.type === TYPE.argument ||
        el.type === TYPE.number ||
        el.type === TYPE.date ||
        el.type === TYPE.time
      ) {
        args.add(el.value)
      }
    }
  }
  walk(parsed(message))
  return { args: [...args].sort(), tags: [...tags].sort() }
}

/**
 * A message's syntax tree. One that names an HTML element in its prose (`claim.optionMetaHint`,
 * "the <head> of your home page") has no tags to compare, and is read with them as text.
 */
function parsed(message: string): MessageFormatElement[] {
  try {
    return parse(message)
  } catch {
    return parse(message, { ignoreTag: true })
  }
}

/**
 * Arguments the code passes that the English message does not read. `site.readersText.more` is
 * given both `n` (the others) and `total` (everyone), and Chinese counts everyone ("等 N 人").
 */
const ALSO_PASSED: Record<string, readonly string[]> = { 'site.readersText.more': ['total'] }

const en = strings(MESSAGES.en)
const catalogues = Object.entries(MESSAGES).filter(([locale]) => locale !== 'en')

describe('message catalogues', () => {
  // The type of `MESSAGES` catches a key missing from a catalogue, never one only it has.
  test.each(catalogues)('%s has the same keys as en', (_, messages) => {
    expect([...strings(messages).keys()].sort()).toEqual([...en.keys()].sort())
  })

  test.each(catalogues)('%s reads the arguments and tags en does', (_, messages) => {
    for (const [key, message] of strings(messages)) {
      const source = en.get(key)
      if (source === undefined) continue
      const want = shape(source)
      const got = shape(message)
      expect({ key, tags: got.tags }).toEqual({ key, tags: want.tags })
      const extra = ALSO_PASSED[key]
      if (extra) {
        const passed = new Set([...want.args, ...extra])
        expect({ key, unknown: got.args.filter((a) => !passed.has(a)) }).toEqual({
          key,
          unknown: [],
        })
      } else {
        expect({ key, args: got.args }).toEqual({ key, args: want.args })
      }
    }
  })

  // French sets a no-break space before : and inside « », and a narrow one before ; ? and !,
  // so that none of them is ever left alone at the start of a line.
  test('fr keeps its spaces before high punctuation unbreakable, in messages and pages', () => {
    const french = [...strings(fr), ...strings(frInfo, 'info/fr.ts:')]
    for (const [key, text] of french) {
      expect({ key, loose: /(?<=\S) [:;?!»]|« /.test(text) }).toEqual({ key, loose: false })
    }
  })
})

// The admin console's own catalogues (ADR 0039): English and Simplified, Traditional generated.
const adminEn = strings(ADMIN_MESSAGES.en)
const adminCatalogues = Object.entries(ADMIN_MESSAGES).filter(([lang]) => lang !== 'en')

describe('admin catalogues', () => {
  test.each(adminCatalogues)('%s has the same keys as en', (_, messages) => {
    expect([...strings(messages).keys()].sort()).toEqual([...adminEn.keys()].sort())
  })

  test.each(adminCatalogues)('%s reads the arguments and tags en does', (_, messages) => {
    for (const [key, message] of strings(messages)) {
      const source = adminEn.get(key)
      if (source === undefined) continue
      const want = shape(source)
      const got = shape(message)
      expect({ key, args: got.args, tags: got.tags }).toEqual({
        key,
        args: want.args,
        tags: want.tags,
      })
    }
  })
})
