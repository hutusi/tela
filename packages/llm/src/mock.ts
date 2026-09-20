import { tokenize } from '@tela/content/tagged'
import { estimateTokens } from './chunk'
import type { TranslationRequest, TranslationResponse, Translator } from './types'

export type MockTranslatorOptions = {
  model?: string
  /** Block ids whose output is corrupted (placeholder dropped), to exercise validation. */
  failIds?: Set<string>
  /** Block ids left out of the reply entirely. */
  dropIds?: Set<string>
  /**
   * Leave out every block whose source text contains this marker.
   *
   * `dropIds` needs ids, which are content hashes nobody can know in advance, so it can only be
   * used from a test that annotated the blocks itself. An end-to-end run goes through the whole
   * pipeline and can only reach in through the text — which is how the e2e reaches a `partial`
   * translation at all, the one body state no fixture otherwise produces.
   */
  dropMarker?: string
  /** Throw for every call; simulates a provider outage. */
  fail?: boolean
  /** Observed requests, for assertions. */
  calls?: TranslationRequest[]
}

/**
 * Deterministic translator for tests and local runs: prefixes every text segment with the
 * target language tag and keeps placeholders intact, e.g. "Hello <g1>world</g1>" becomes
 * "zh-Hans:Hello <g1>zh-Hans:world</g1>".
 */
export function createMockTranslator(options: MockTranslatorOptions = {}): Translator {
  const model = options.model ?? 'mock'
  return {
    model,
    async translate(request: TranslationRequest): Promise<TranslationResponse> {
      options.calls?.push(request)
      if (options.fail) throw new Error('mock provider failure')
      const translations = request.blocks
        .filter((b) => !options.dropIds?.has(b.id))
        .filter((b) => !(options.dropMarker && b.text.includes(options.dropMarker)))
        .map((b) => {
          let text = tokenize(b.text)
            .map((t) => {
              if (t.kind === 'text')
                return /\p{L}/u.test(t.value) ? `${request.targetLang}:${t.value}` : t.value
              if (t.kind === 'open') return `<${t.key}>`
              if (t.kind === 'close') return `</${t.key}>`
              return `<${t.key}/>`
            })
            .join('')
          if (options.failIds?.has(b.id)) text = text.replace(/<\/?[gx]\d+\/?>/, '')
          return { id: b.id, text }
        })
      const inputTokens = request.blocks.reduce((n, b) => n + estimateTokens(b.text), 0)
      return {
        translations,
        usage: { model, inputTokens, outputTokens: Math.round(inputTokens * 1.2), latencyMs: 1 },
      }
    },
  }
}
