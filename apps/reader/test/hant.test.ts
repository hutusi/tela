import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { generate } from '../scripts/hant'

describe('the Traditional Chinese interface', () => {
  // Traditional is generated from Simplified (scripts/hant.ts), so a change to zh-Hans that was
  // not carried over, or an edit made to zh-Hant by hand, fails here rather than drifting.
  test('is what `bun run i18n:hant` writes from Simplified', () => {
    for (const { path, text } of generate()) {
      const committed = readFileSync(join(import.meta.dir, '..', path), 'utf8')
      if (committed !== text) {
        throw new Error(
          `apps/reader/${path} does not match its zh-Hans source: run \`bun run i18n:hant\` and commit what it writes (never edit it by hand)`,
        )
      }
      expect(committed).toBe(text)
    }
  })
})
