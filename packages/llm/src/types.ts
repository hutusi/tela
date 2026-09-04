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

/** A translation backend. Implementations: AI SDK models (Bailian, Anthropic) and a mock. */
export interface Translator {
  readonly model: string
  translate(request: TranslationRequest): Promise<TranslationResponse>
}
