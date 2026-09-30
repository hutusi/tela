import { chunkBlocks, DEFAULT_CHUNK_TOKENS, estimateTokens } from './chunk'
import type { TranslationBlock, TranslationContext, TranslationUsage, Translator } from './types'
import { validateTranslation } from './validate'

/** What one successful provider call produced, handed to `onChunk` as it lands. */
export type ChunkResult = {
  translated: Map<string, string>
  usage: TranslationUsage
}

export type TranslateBlocksInput = {
  blocks: TranslationBlock[]
  sourceLang: string | null
  targetLang: string
  context?: Pick<TranslationContext, 'title' | 'siteTitle'>
  maxTokensPerChunk?: number
  /**
   * Ceiling on estimated source tokens for the whole call. Blocks are taken in order until the
   * ceiling would be crossed; the rest are reported as failed (`article too long`) and never
   * sent, so one article costs a bounded number of calls.
   */
  maxSourceTokens?: number
  /**
   * Block ids whose translation may equal their source. This is deliberately per-block: a title
   * can be a name that stays unchanged while prose beside it still needs the echo guard.
   */
  allowIdenticalBlockIds?: readonly string[]
  /** Called after every successful provider call, so progress can be persisted before the next. */
  onChunk?: (chunk: ChunkResult) => Promise<void>
  /**
   * Called before every provider call, the strict retry's included. What it throws ends the run
   * unhandled: a job that has lost its lease uses it to stop before it pays for another call,
   * whether or not the call before succeeded.
   */
  beforeCall?: () => Promise<void>
  /**
   * Epoch milliseconds after which no further provider call is started. Blocks left unattempted
   * are neither translated nor failed; the outcome says the run `stopped` so the caller can
   * continue it later from what was persisted.
   */
  deadline?: number
}

export type TranslateBlocksOutcome = {
  /** id → validated translated tagged text */
  translated: Map<string, string>
  failed: Array<{ id: string; reason: string }>
  /**
   * Ids accepted only because `allowIdenticalBlockIds` permitted an echo of the source. The
   * caller decides whether such a block is safe to write to the shared, content-addressed
   * translation cache — for a title it is not, see translateArticleTitle.
   */
  echoed: Set<string>
  usage: TranslationUsage[]
  /** The deadline passed with blocks still unattempted. */
  stopped: boolean
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
  const allowIdentical = new Set(input.allowIdenticalBlockIds ?? [])
  const echoed = new Set<string>()
  const capped = new Set<string>()
  let accepted = input.blocks
  if (input.maxSourceTokens !== undefined) {
    accepted = []
    let total = 0
    let over = false
    for (const b of input.blocks) {
      if (!over) {
        total += estimateTokens(b.text)
        if (total > input.maxSourceTokens) over = true
      }
      if (over) {
        capped.add(b.id)
        failed.set(b.id, 'article too long')
      } else {
        accepted.push(b)
      }
    }
  }
  let previous: Array<{ source: string; target: string }> = []
  let successes = 0
  let lastError: unknown = null

  const run = async (blocks: TranslationBlock[], strict: boolean) => {
    if (blocks.length === 0) return
    if (input.beforeCall) await input.beforeCall()
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
    const chunkTranslated = new Map<string, string>()
    for (const b of blocks) {
      const text = returned.get(b.id)
      if (text === undefined) {
        failed.set(b.id, 'missing from reply')
        continue
      }
      const check = validateTranslation(b.text, text, {
        allowIdentical: allowIdentical.has(b.id),
      })
      if (check.ok) {
        translated.set(b.id, text)
        chunkTranslated.set(b.id, text)
        if (check.identical) echoed.add(b.id)
        else echoed.delete(b.id)
        failed.delete(b.id)
      } else {
        failed.set(b.id, check.reason)
      }
    }
    const tail = blocks.filter((b) => translated.has(b.id)).slice(-2)
    previous = tail.map((b) => ({ source: b.text, target: translated.get(b.id) as string }))
    if (input.onChunk) await input.onChunk({ translated: chunkTranslated, usage: response.usage })
  }

  const past = () => input.deadline !== undefined && Date.now() >= input.deadline
  let stopped = false
  for (const chunk of chunkBlocks(accepted, input.maxTokensPerChunk ?? DEFAULT_CHUNK_TOKENS)) {
    if (past()) {
      stopped = true
      break
    }
    await run(chunk, false)
  }
  if (!stopped) {
    const retry = [...failed.keys()]
      .filter((id) => !capped.has(id) && !failed.get(id)?.startsWith('provider error'))
      .map((id) => ({ id, text: bySource.get(id) as string }))
    for (const chunk of chunkBlocks(retry, input.maxTokensPerChunk ?? DEFAULT_CHUNK_TOKENS)) {
      if (past()) {
        stopped = true
        break
      }
      await run(chunk, true)
    }
  }

  if (successes === 0 && lastError && accepted.length > 0) throw lastError
  return {
    translated,
    failed: [...failed.entries()].map(([id, reason]) => ({ id, reason })),
    echoed,
    usage,
    stopped,
  }
}
