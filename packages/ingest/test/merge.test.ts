import { describe, expect, test } from 'bun:test'
import { canonicalOf, planMerge, postKey, samePosts } from '../src/pipeline/merge'

const DAY = 86_400_000
const post = (id: number, n: number, url = `http://blog.example/posts/${n}`) => ({
  id,
  url,
  dedupKey: `g:${id}`,
  sortAt: n * DAY,
})

describe('one blog, one feed', () => {
  test('a post URL matches however either feed spells its scheme, www, slash or tracking', () => {
    expect(postKey('https://www.Blog.example/posts/1/?utm_source=feedburner')).toBe(
      postKey('http://blog.example/posts/1'),
    )
    expect(postKey('http://blog.example/posts/1?page=2')).not.toBe(
      postKey('http://blog.example/posts/1'),
    )
  })

  test('two feeds are one when they list the same posts over the time both cover', () => {
    // The mirror carries six posts; the blog's own feed only its latest three.
    const mirror = [1, 2, 3, 4, 5, 6].map((n) => post(100 + n, n))
    const own = [4, 5, 6].map((n) => post(n, n))
    expect(samePosts(mirror, own)).toBe(true)
  })

  test('a category feed is not the blog feed, and three shared posts are the least that counts', () => {
    const all = [1, 2, 3, 4, 5, 6].map((n) => post(n, n))
    const category = [2, 4, 6].map((n) => post(100 + n, n))
    expect(samePosts(category, all)).toBe(false)
    const two = [5, 6]
    expect(
      samePosts(
        two.map((n) => post(100 + n, n)),
        two.map((n) => post(n, n)),
      ),
    ).toBe(false)
  })

  test("the blog's own host wins over a mirror, whichever is older; otherwise the older", () => {
    const home = 'http://www.ruanyifeng.com'
    const own = { id: 24, host: 'www.ruanyifeng.com' }
    const mirror = { id: 42, host: 'feeds.feedburner.com' }
    expect(canonicalOf(home, own, mirror)).toBe(24)
    expect(canonicalOf(home, mirror, { ...own, id: 50 })).toBe(50)
    expect(canonicalOf(home, { id: 7, host: 'ruanyifeng.com' }, own)).toBe(7)
  })

  test('the alias moves the posts its target lacks and pairs the rest for their read state', () => {
    const mirror = {
      id: 42,
      host: 'feeds.feedburner.com',
      posts: [1, 2, 3, 4].map((n) => post(100 + n, n)),
    }
    const own = { id: 24, host: 'blog.example', posts: [2, 3, 4].map((n) => post(n, n)) }
    expect(planMerge(mirror, 'http://blog.example', [own, mirror])).toEqual({
      target: 24,
      move: [101],
      carry: [
        [102, 2],
        [103, 3],
        [104, 4],
      ],
    })
    // Seen from the blog's own feed, there is nothing to merge.
    expect(planMerge(own, 'http://blog.example', [own, mirror])).toBeNull()
  })
})
