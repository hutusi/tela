/**
 * What opening a post does before its body is on screen, which depends on whether the day's limit
 * on blogs the member does not subscribe to can refuse that body (ADR 0066). A subscribed blog's
 * post never is, so it is read, and its translation asked for, the moment it opens, as always. Any
 * other's waits for the body: refused, nothing was read, and a translation would be paid for and
 * refused with it.
 */
import type { ArticleRow } from '@tela/sync'
import type { LocalStore } from '../store/local'
import { isRead, isSubscribed } from '../store/selectors'
import { readingPrefsOf } from './prefs'

/**
 * Whether the reader asks for a post's translation now: when it is wanted, and either the post is
 * from a blog the member subscribes to (its body is never refused, so asking at once saves the
 * first paragraphs a round trip), or its body has answered, and was not refused.
 */
export function asksForTranslation(post: {
  wanted: boolean
  subscribed: boolean
  answered: boolean
  refused: boolean
}): boolean {
  return post.wanted && !post.refused && (post.subscribed || post.answered)
}

/**
 * Marking a post read by opening it (`reader.markOnOpen`), once per open: a post the member marks
 * unread while it is open stays unread until it is opened again. A subscribed blog's post is
 * read as it opens (`opened`); any other's once its body is there to read, or it is known to have
 * none (`readable`), so one refused for the day stays unread. Each reads the rows as they are when
 * it runs.
 */
export function openMarker(store: Pick<LocalStore, 'getSnapshot' | 'article' | 'mutate'>) {
  /** The post this open has marked, or decided not to; null until it does. */
  let marked: number | null = null
  const mark = (id: number) => {
    if (marked === id) return
    marked = id
    const { tables } = store.getSnapshot()
    const article = store.article(tables, id)
    if (!article || !readingPrefsOf(tables).markOnOpen || isRead(tables, article, Date.now())) {
      return
    }
    store.mutate({ type: 'markRead', articleId: id })
  }
  return {
    /** A post opened: read now if it is from a blog the member subscribes to. */
    opened(article: ArticleRow): void {
      if (isSubscribed(store.getSnapshot().tables, article.feedId)) mark(article.id)
    },
    /** Its body is on screen, or it has none: read now, if this open has not marked it. */
    readable(id: number): void {
      mark(id)
    },
    /** The post closed, or another opened: the next open marks again. */
    left(): void {
      marked = null
    },
  }
}
