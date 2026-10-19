/** One block to translate: its stable id and tagged text (see @tela/content/tagged). */
export type TranslationBlock = { id: string; text: string }

export type TranslationContext = {
  /** Article title, for terminology consistency. */
  title?: string | null
  /** Site or feed name. */
  siteTitle?: string | null
  /** The last translated blocks of the previous chunk, source and target. */
  previous?: Array<{ source: string; target: string }>
}

export type TranslationRequest = {
  sourceLang: string | null
  targetLang: string
  blocks: TranslationBlock[]
  context?: TranslationContext
  /** Retry mode: stronger instructions about placeholders and completeness. */
  strict?: boolean
}

export type TranslationUsage = {
  model: string
  inputTokens: number
  outputTokens: number
  latencyMs: number
}

export type TranslationResponse = {
  translations: TranslationBlock[]
  usage: TranslationUsage
}

/**
 * A translation that failed after the provider had answered, and so billed: a reply that was not
 * the JSON asked for, or a run whose every call failed that way. `usage` is what was paid, which
 * the caller records and charges like any other call's: uncounted, a reply that always fails to
 * parse would be paid for on every retry while the budget saw nothing.
 */
export class TranslationFailed extends Error {
  override name = 'TranslationFailed'
  constructor(
    message: string,
    readonly usage: TranslationUsage[],
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

/** What a failure cost: the usage it carries, or none for one the provider never billed. */
export function billedUsage(err: unknown): TranslationUsage[] {
  return err instanceof TranslationFailed ? err.usage : []
}

/** A translation backend. Implementations: AI SDK models (Bailian, Anthropic) and a mock. */
export interface Translator {
  readonly model: string
  translate(request: TranslationRequest): Promise<TranslationResponse>
}
