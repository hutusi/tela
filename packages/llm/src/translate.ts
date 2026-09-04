import { chunkBlocks, DEFAULT_CHUNK_TOKENS } from './chunk'
import type { TranslationBlock, TranslationContext, TranslationUsage, Translator } from './types'
import { validateTranslation } from './validate'

export type TranslateBlocksInput = {
  blocks: TranslationBlock[]
  sourceLang: string | null
  targetLang: string
  context?: Pick<TranslationContext, 'title' | 'siteTitle'>
  maxTokensPerChunk?: number
}

export type TranslateBlocksOutcome = {
  /** id → validated translated tagged text */
  translated: Map<string, string>
  failed: Array<{ id: string; reason: string }>
  usage: TranslationUsage[]
}

/**
 * Translate blocks in chunks, validate every block, retry the failures once in strict mode,
 * and carry the last two translations of a chunk into the next as context. Provider errors
 * on one chunk mark its blocks failed and the run continues; if no chunk succeeds at all the
 * error is thrown so the job can retry later.
 */
export async function translateBlocks(
  translator: Translator,
  input: TranslateBlocksInput,
): Promise<TranslateBlocksOutcome> {
  const translated = new Map<string, string>()
  const failed = new Map<string, string>()
  const usage: TranslationUsage[] = []
  const bySource = new Map(input.blocks.map((b) => [b.id, b.text]))
  let previous: Array<{ source: string; target: string }> = []
  let successes = 0
  let lastError: unknown = null

  const run = async (blocks: TranslationBlock[], strict: boolean) => {
    if (blocks.length === 0) return
    let response: Awaited<ReturnType<Translator['translate']>>
    try {
      response = await translator.translate({
        sourceLang: input.sourceLang,
        targetLang: input.targetLang,
        blocks,
        context: { ...input.context, previous },
        strict,
      })
    } catch (err) {
      lastError = err
      for (const b of blocks)
        failed.set(b.id, `provider error: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    successes += 1
    usage.push(response.usage)
    const returned = new Map(response.translations.map((t) => [t.id, t.text]))
    for (const b of blocks) {
      const text = returned.get(b.id)
      if (text === undefined) {
        failed.set(b.id, 'missing from reply')
        continue
      }
      const check = validateTranslation(b.text, text)
      if (check.ok) {
        translated.set(b.id, text)
        failed.delete(b.id)
      } else {
        failed.set(b.id, check.reason)
      }
    }
    const tail = blocks.filter((b) => translated.has(b.id)).slice(-2)
    previous = tail.map((b) => ({ source: b.text, target: translated.get(b.id) as string }))
  }

  for (const chunk of chunkBlocks(input.blocks, input.maxTokensPerChunk ?? DEFAULT_CHUNK_TOKENS)) {
    await run(chunk, false)
  }
  const retry = [...failed.keys()]
    .filter((id) => !failed.get(id)?.startsWith('provider error'))
    .map((id) => ({ id, text: bySource.get(id) as string }))
  for (const chunk of chunkBlocks(retry, input.maxTokensPerChunk ?? DEFAULT_CHUNK_TOKENS)) {
    await run(chunk, true)
  }

  if (successes === 0 && lastError && input.blocks.length > 0) throw lastError
  return {
    translated,
    failed: [...failed.entries()].map(([id, reason]) => ({ id, reason })),
    usage,
  }
}
