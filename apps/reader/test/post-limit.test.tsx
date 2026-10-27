/**
 * A post refused for the day's limit on blogs the member does not subscribe to (ADR 0066), drawn
 * on the server: the excerpt, the limit and when more open in the member's own time, one button
 * and the link to the blog. No effect runs in a server render, so the button's work (subscribe,
 * wait for tela-api's answer, ask again) is not exercised here: its parts are, in
 * `store.test.ts` (`unanswered`) and `objects.test.ts` (forgetting refusals).
 */
import { describe, expect, test } from 'bun:test'
import type { UiLocale } from '@tela/shared'
import { renderToString } from 'react-dom/server'
import { PostLimit, type PostLimitAction } from '../src/components/post-limit'
import { localTime } from '../src/components/translation-bar'
import { I18n } from '../src/i18n'

const DAY = 86_400_000
const NOW = 400 * DAY + 3_600_000
const RESETS = 401 * DAY

function render(
  over: {
    locale?: UiLocale
    limit?: number | null
    url?: string | null
    excerpt?: string | null
    action?: PostLimitAction
  } = {},
) {
  return renderToString(
    <I18n locale={over.locale ?? 'en'}>
      <PostLimit
        excerpt={over.excerpt === undefined ? 'The first lines of the post.' : over.excerpt}
        excerptLang="en"
        url={over.url === undefined ? 'https://blog.example/post' : over.url}
        refusal={{ limit: over.limit === undefined ? 100 : over.limit, resetsAt: RESETS }}
        action={over.action ?? 'subscribe'}
        onAction={() => {}}
        now={NOW}
      />
    </I18n>,
  )
}

/** The text as a reader sees it: tags gone, React's comment markers and entities undone. */
const text = (html: string) =>
  html
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()

describe('a post refused for the day', () => {
  test('shows the excerpt, the limit, when more open, Subscribe and the blog', () => {
    const html = render()
    const { time, tomorrow } = localTime(RESETS, 'en', NOW)
    expect(html).toContain('data-testid="body-refused"')
    expect(html).toContain('The first lines of the post.')
    expect(text(html)).toContain('You’ve reached today’s limit')
    expect(text(html)).toContain(
      'You can open 100 posts a day in full from blogs you don’t subscribe to, and any number from blogs you do.',
    )
    expect(text(html)).toContain(
      tomorrow ? `You can open more tomorrow, after ${time}.` : `You can open more after ${time}.`,
    )
    expect(html).toContain('data-testid="post-limit-subscribe"')
    expect(text(html)).toContain('Subscribe to keep reading')
    // The blog opens beside Tela, as the original's link does.
    expect(html).toMatch(
      /<a href="https:\/\/blog\.example\/post" target="_blank" rel="noopener noreferrer"[^>]*data-testid="post-limit-blog"/,
    )
  })

  test('one post a day, an unknown limit, and no excerpt or address', () => {
    expect(text(render({ limit: 1 }))).toContain('You can open 1 post a day in full')
    const bare = render({ limit: null, url: null, excerpt: null })
    expect(text(bare)).toContain('You can open a few posts a day in full')
    expect(bare).not.toContain('post-limit-blog')
    expect(bare).not.toContain('article-body')
  })

  test('while the subscription is on its way the button waits; subscribed, it asks again', () => {
    const waiting = render({ action: 'subscribing' })
    expect(waiting).toMatch(/<button[^>]*disabled=""[^>]*aria-busy="true"/)
    expect(text(waiting)).toContain('Subscribing…')
    const subscribed = render({ action: 'retry' })
    expect(subscribed).toContain('data-testid="post-limit-retry"')
    expect(text(subscribed)).toContain('Try again')
  })

  test('Chinese joins its two sentences with no space', () => {
    const { time, tomorrow } = localTime(RESETS, 'zh-Hans', NOW)
    const again = tomorrow ? `明天 ${time} 之后可以再打开。` : `${time} 之后可以再打开。`
    expect(text(render({ locale: 'zh-Hans' }))).toContain(
      `未订阅的博客每天可以完整打开 100 篇文章，已订阅的博客不限篇数。${again}`,
    )
  })
})
