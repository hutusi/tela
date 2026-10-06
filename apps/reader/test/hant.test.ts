import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { generate } from '../scripts/hant'

describe('the Traditional Chinese interface', () => {
  // Traditional is generated from Simplified (scripts/hant.ts), so a change to zh-Hans that was
  // not carried over, or an edit made to zh-Hant by hand, fails here rather than drifting.
  test('is what `bun run i18n:hant` writes from Simplified', () => {
    const generated = generate()
    // tela-api's mail too, which the script writes outside this app (`apps/api/src/mail-text`).
    expect(generated.map(({ path }) => join('apps/reader', path))).toContain(
      'apps/api/src/mail-text/zh-Hant.json',
    )
    for (const { path, text } of generated) {
      const committed = readFileSync(join(import.meta.dir, '..', path), 'utf8')
      if (committed !== text) {
        throw new Error(
          `${join('apps/reader', path)} does not match its zh-Hans source: run \`bun run i18n:hant\` and commit what it writes (never edit it by hand)`,
        )
      }
      expect(committed).toBe(text)
    }
  })
})
