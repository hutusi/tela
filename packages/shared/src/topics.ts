/**
 * The design's nine topics and AI (ADR 0068), in the order Discover shows them. Slugs are stored in
 * sites.topics.
 */
export const TOPICS = [
  'essays',
  'tech',
  'ai',
  'cities',
  'food',
  'design',
  'outdoors',
  'life',
  'photography',
  'science',
] as const
export type Topic = (typeof TOPICS)[number]

export function isTopic(value: unknown): value is Topic {
  return typeof value === 'string' && (TOPICS as readonly string[]).includes(value)
}
