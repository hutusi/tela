/** The nine topics from the design. Slugs are stored in sites.topics. */
export const TOPICS = [
  'essays',
  'tech',
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
