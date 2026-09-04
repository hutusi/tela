import { type Db, llmUsage } from '@tela/db'
import type { TranslationUsage } from '@tela/llm'

/** One llm_usage row per provider call, for budgets and cost visibility. */
export async function recordUsage(
  db: Db,
  job: string,
  articleId: number,
  targetLang: string,
  usage: TranslationUsage[],
): Promise<void> {
  if (usage.length === 0) return
  await db.insert(llmUsage).values(
    usage.map((u) => ({
      job,
      articleId,
      targetLang,
      model: u.model,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      latencyMs: u.latencyMs,
    })),
  )
}
