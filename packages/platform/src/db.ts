import type { BatchItem, BatchResponse } from 'drizzle-orm/batch'
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'

/**
 * The database as Tela's code may use it: Drizzle over SQLite, async, with atomic batches and no
 * interactive transactions (ADR 0021). D1 has no `BEGIN … COMMIT` from a Worker, and libSQL is
 * held to the same subset so the portable path runs exactly the statements production runs.
 *
 * The run-result type is `unknown` on purpose: D1 reports `meta.changes` and libSQL
 * `rowsAffected`, so code that needs to know what a write touched asks with `RETURNING`.
 */
export type Db<TSchema extends Record<string, unknown> = Record<string, never>> = Omit<
  BaseSQLiteDatabase<'async', unknown, TSchema>,
  'transaction'
> & {
  batch<U extends BatchItem<'sqlite'>, T extends Readonly<[U, ...U[]]>>(
    batch: T,
  ): Promise<BatchResponse<T>>
}

/** D1's per-statement limits, which the portable adapter enforces so tests fail where D1 would. */
export const D1_LIMITS = {
  maxBoundParameters: 100,
  maxStatementBytes: 100_000,
  /**
   * Terms in one UNION / INTERSECT / EXCEPT chain; SQLite's default is 500. Measured on D1
   * 2026-09-28: 5 runs, 6 is "too many terms in compound SELECT". A multi-row VALUES is not a
   * compound and takes 50 rows.
   */
  maxCompoundTerms: 5,
} as const

/** Thrown by the portable adapter for a statement D1 would refuse. */
export class D1LimitError extends Error {
  override name = 'D1LimitError'
}

/** Check one statement against D1's limits; the portable adapter calls this for every statement. */
export function checkD1Limits(sql: string, parameterCount: number): void {
  if (parameterCount > D1_LIMITS.maxBoundParameters) {
    throw new D1LimitError(
      `${parameterCount} bound parameters (D1 allows ${D1_LIMITS.maxBoundParameters}); pass rows through json_each(?1) instead`,
    )
  }
  const bytes = new TextEncoder().encode(sql).length
  if (bytes > D1_LIMITS.maxStatementBytes) {
    throw new D1LimitError(`${bytes} bytes of SQL (D1 allows ${D1_LIMITS.maxStatementBytes})`)
  }
  const terms = longestCompound(sql)
  if (terms > D1_LIMITS.maxCompoundTerms) {
    throw new D1LimitError(
      `a compound SELECT of ${terms} terms (D1 allows ${D1_LIMITS.maxCompoundTerms}); pass rows through json_each(?1) instead`,
    )
  }
}

/**
 * Terms in the longest compound chain. A chain is the operators at one parenthesis level, so two
 * short unions in separate subqueries are not added together. Literals, quoted identifiers and
 * comments are blanked first, so a keyword inside them counts for nothing.
 */
function longestCompound(sql: string): number {
  const code = sql.replace(
    /'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\//g,
    ' ',
  )
  const levels = [0]
  let longest = 0
  for (const [token] of code.matchAll(/[()]|\b(?:union|intersect|except)\b/gi)) {
    if (token === '(') levels.push(0)
    else if (token === ')') longest = Math.max(longest, levels.length > 1 ? (levels.pop() ?? 0) : 0)
    else levels[levels.length - 1] = (levels[levels.length - 1] ?? 0) + 1
  }
  for (const operators of levels) longest = Math.max(longest, operators)
  return longest + 1
}
