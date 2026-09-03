import { type AnnotatedContent, annotateBlocks } from './blocks'
import { makeExcerpt, readingMinutes, wordCount } from './excerpt'
import { sha256Hex } from './hash'
import { detectLanguage } from './lang'
import { sanitizeArticleHtml } from './sanitize'

export type ProcessedContent = AnnotatedContent & {
  /** Plain text of all translatable blocks, newline separated. */
  text: string
  excerpt: string
  lang: string
  wordCount: number
  readingMinutes: number
  /** Hash of the annotated HTML; changes when the article changes. */
  contentHash: string
}

export type ProcessInput = {
  html: string
  /** Article URL (or feed URL) used to absolutize links and images. */
  baseUrl?: string
  /** Feed-level language, used only to break ties. */
  langHint?: string | null
  /** Article title, included in language detection. */
  title?: string | null
}

/** Sanitize, normalize, annotate, and describe one article body. */
export async function processArticleHtml(input: ProcessInput): Promise<ProcessedContent> {
  const clean = sanitizeArticleHtml(input.html, input.baseUrl)
  const annotated = await annotateBlocks(clean)
  const text = annotated.texts.join('\n')
  const lang = detectLanguage(`${input.title ?? ''}\n${text}`, input.langHint)
  return {
    ...annotated,
    text,
    excerpt: makeExcerpt(annotated.texts.slice(0, 3)),
    lang,
    wordCount: wordCount(text),
    readingMinutes: readingMinutes(text),
    contentHash: await sha256Hex(annotated.html),
  }
}
