import { generateText, type LanguageModel, Output } from 'ai'
import { z } from 'zod'
import { buildSystemPrompt, buildUserPayload } from './prompt'
import type { TranslationRequest, TranslationResponse, Translator } from './types'

const responseSchema = z.object({
  translations: z.array(z.object({ id: z.string(), text: z.string() })),
})

/** One provider call, the SDK's own retries included, is abandoned after this long. */
export const DEFAULT_CALL_TIMEOUT_MS = 120_000

export type SdkTranslatorOptions = {
  /** Label recorded in llm_usage and translations.model. */
  modelName: string
  /** Deadline for one provider call; a hung connection must not hold an attempt forever. */
  timeoutMs?: number
  /** 'schema' uses the provider's structured output; 'text' asks for JSON and parses it. */
  jsonMode?: 'schema' | 'text'
  providerOptions?: Record<string, Record<string, string | number | boolean | null>>
  temperature?: number
  maxOutputTokens?: number
}

/** Pull the first JSON object out of a text reply, tolerating fences and prose around it. */
export function parseJsonReply(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start === -1 || end <= start) throw new Error('reply contains no JSON object')
    return JSON.parse(trimmed.slice(start, end + 1))
  }
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Recover entries from a reply that is not valid JSON. Some models copy quotation marks into
 * the "text" value unescaped, which breaks the whole object; the shape is fixed and the ids are
 * known, so each entry is found by its id and its text taken up to the closing `"}`, with the
 * stray quotes escaped before JSON decodes the remaining escapes. Entries that cannot be found
 * are simply absent, which the caller reports as missing.
 */
export function recoverTranslations(
  text: string,
  ids: string[],
): Array<{ id: string; text: string }> {
  const out: Array<{ id: string; text: string }> = []
  for (const id of ids) {
    const m = new RegExp(
      `"id"\\s*:\\s*"${escapeRegExp(id)}"\\s*,\\s*"text"\\s*:\\s*"([\\s\\S]*?)"\\s*\\}`,
    ).exec(text)
    if (!m) continue
    // Escape the quotes the model left raw; ones it did escape stay as they are.
    const escaped = (m[1] as string).replace(/(?<!\\)"/g, '\\"')
    try {
      out.push({ id, text: JSON.parse(`"${escaped}"`) as string })
    } catch {
      // not decodable even after repair: leave it missing
    }
  }
  return out
}

/** The translations in a text reply: parsed as JSON, or recovered entry by entry when that fails. */
export function parseTranslations(
  text: string,
  ids: string[],
): Array<{ id: string; text: string }> {
  try {
    return responseSchema.parse(parseJsonReply(text)).translations
  } catch (err) {
    const recovered = recoverTranslations(text, ids)
    if (recovered.length === 0) throw err
    return recovered
  }
}

/** A Translator over any Vercel AI SDK language model. */
export function createSdkTranslator(
  model: LanguageModel,
  options: SdkTranslatorOptions,
): Translator {
  const jsonMode = options.jsonMode ?? 'text'
  return {
    model: options.modelName,
    async translate(request: TranslationRequest): Promise<TranslationResponse> {
      const started = Date.now()
      const system = buildSystemPrompt(request)
      const prompt = buildUserPayload(request)
      const common = {
        model,
        system,
        prompt,
        temperature: options.temperature ?? 0.2,
        maxOutputTokens: options.maxOutputTokens ?? 16_000,
        abortSignal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS),
        ...(options.providerOptions ? { providerOptions: options.providerOptions } : {}),
      }
      let translations: Array<{ id: string; text: string }>
      let usage: { inputTokens?: number | undefined; outputTokens?: number | undefined }
      if (jsonMode === 'schema') {
        const result = await generateText({
          ...common,
          output: Output.object({ schema: responseSchema }),
        })
        translations = result.output.translations
        usage = result.usage
      } else {
        const result = await generateText(common)
        translations = parseTranslations(
          result.text,
          request.blocks.map((b) => b.id),
        )
        usage = result.usage
      }
      return {
        translations,
        usage: {
          model: options.modelName,
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          latencyMs: Date.now() - started,
        },
      }
    },
  }
}
