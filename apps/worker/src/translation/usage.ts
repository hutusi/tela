import { type Db, llmUsage } from '@tela/db'
import type { TranslationUsage } from '@tela/llm'

/** One llm_usage row per provider call, for budgets and cost visibility. */
export async function recordUsage(
  db: Db,
  job: string,
  articleId: number,
  targetLang: string,
  usage: TranslationUsage[],
  /** Member whose request caused the calls; null for background work. */
  userId: string | null = null,
): Promise<void> {
  if (usage.length === 0) return
  await db.insert(llmUsage).values(
    usage.map((u) => ({
      job,
      articleId,
      targetLang,
      userId,
      model: u.model,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      latencyMs: u.latencyMs,
    })),
  )
}
