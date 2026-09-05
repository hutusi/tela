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
        translations = responseSchema.parse(parseJsonReply(result.text)).translations
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
