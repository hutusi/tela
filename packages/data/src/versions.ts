/**
 * Which version of an article's body readers see (ADR 0022). Versions are never rewritten; this
 * decides between them. It is the fix for the regression where a changed feed summary put itself
 * back over a full-text extraction and nothing ever extracted again.
 */
import type { ContentMode } from '@tela/shared'
import type { Provenance } from './schema/values'

export type VersionSummary = {
  version: number
  provenance: Provenance
  contentKey: string
  bodyChars: number
}

/** A readability version must be clearly longer to win on a feed of unknown mode. */
export const EXTRACTION_MUST_BE_LONGER_BY = 1.2

function latest(versions: VersionSummary[], provenance: Provenance): VersionSummary | undefined {
  let best: VersionSummary | undefined
  for (const v of versions) {
    if (v.provenance === provenance && (!best || v.version > best.version)) best = v
  }
  return best
}

/**
 * The current version:
 * - on a full-content feed, the latest feed version;
 * - on a summary feed, the latest readability version once there is one (an older extraction
 *   stays current while a newer summary waits for re-extraction);
 * - on a feed of unknown mode, the latest readability version only when it is clearly longer
 *   than the latest feed version.
 * Falls back to whichever kind exists. Undefined only when there are no versions.
 */
export function chooseCurrent(
  versions: VersionSummary[],
  contentMode: ContentMode,
): VersionSummary | undefined {
  const feed = latest(versions, 'feed')
  const readability = latest(versions, 'readability')
  if (!feed || !readability) return feed ?? readability
  if (contentMode === 'full') return feed
  if (contentMode === 'summary') return readability
  return readability.bodyChars >= feed.bodyChars * EXTRACTION_MUST_BE_LONGER_BY ? readability : feed
}

/** Whether an article should (again) have its page extracted, given its versions and feed. */
export function wantsExtraction(
  versions: VersionSummary[],
  contentMode: ContentMode,
  summaryMaxChars: number,
): boolean {
  const feed = latest(versions, 'feed')
  if (!feed) return false
  const readability = latest(versions, 'readability')
  // Already extracted from this summary or a later one: nothing new to extract.
  if (readability && readability.version > feed.version) return false
  if (contentMode === 'summary') return true
  if (contentMode === 'full') return false
  return feed.bodyChars < summaryMaxChars
}
