import type { Topic } from '@tela/shared'

/**
 * One editorially chosen blog. The note is for whoever reviews a change to this list; it is
 * never stored. Prefer a feed of recent items over a full archive: the worker caps a response
 * body at 5 MB and a decade of posts in one file fails the fetch as `too_large`.
 */
export type CuratedSite = {
  feedUrl: string
  topics: readonly [Topic, ...Topic[]]
  note?: string
  /**
   * Known mainland-China host. Kept as a note: every such feed fetched from Cloudflare in spike
   * S2, so it is registered like any other until one times out (OPERATIONS.md, the relay).
   */
  region?: 'cn'
}

/**
 * The editorial door into Discover (ADR 0018). The other doors are slow to open: a claim needs a
 * blogger to join and prove their blog, the community door three readers of one blog, and the
 * operator's review of the blogs members add (ADR 0041) needs members to have added some. Before
 * any of that the directory is empty, which reads as a broken page, not as an empty one. These
 * are independent blogs written by people, which is what the directory is for; a publication with
 * a masthead does not belong here.
 *
 * All nine topics are covered on purpose: /discover renders every chip whether or not anything
 * is behind it, and a chip that lands on "No blogs listed here yet" is worse than no chip.
 *
 * Each entry was verified to serve a parseable feed under the body cap when it was added.
 * Changing this list is a reviewable commit; `bun run admin curate` applies it, and applying it
 * again changes nothing that is already right.
 */
export const CURATED_SITES = [
  // English
  { feedUrl: 'https://simonwillison.net/atom/everything/', topics: ['tech'] },
  { feedUrl: 'https://jvns.ca/atom.xml', topics: ['tech'] },
  { feedUrl: 'https://fasterthanli.me/index.xml', topics: ['tech'] },
  { feedUrl: 'https://overreacted.io/rss.xml', topics: ['tech'] },
  { feedUrl: 'https://daringfireball.net/feeds/main', topics: ['tech'] },
  { feedUrl: 'https://macwright.com/rss.xml', topics: ['tech', 'life'] },
  { feedUrl: 'https://hillelwayne.com/index.xml', topics: ['tech', 'science'] },
  { feedUrl: 'https://sive.rs/en.atom', topics: ['essays'] },
  { feedUrl: 'https://robinsloan.com/feed.xml', topics: ['essays'] },
  {
    feedUrl: 'https://manuelmoreale.com/feed/rss',
    topics: ['essays', 'life'],
    note: 'Runs People & Blogs, an interview series about personal sites',
  },
  { feedUrl: 'https://craigmod.com/index.xml', topics: ['essays', 'photography'] },
  { feedUrl: 'https://maggieappleton.com/rss.xml', topics: ['design'] },
  { feedUrl: 'https://blog.jim-nielsen.com/feed.xml', topics: ['design', 'tech'] },
  { feedUrl: 'https://kottke.org/index.xml', topics: ['life'] },
  { feedUrl: 'https://austinkleon.com/feed/', topics: ['life', 'design'] },
  { feedUrl: 'https://pedestrianobservations.com/feed/', topics: ['cities'] },
  {
    feedUrl: 'https://diamondgeezer.blogspot.com/feeds/posts/default',
    topics: ['cities', 'life'],
    note: 'London, daily since 2002',
  },
  { feedUrl: 'https://www.davidlebovitz.com/feed/', topics: ['food'] },
  { feedUrl: 'https://smittenkitchen.com/feed/', topics: ['food'] },
  { feedUrl: 'https://alastairhumphreys.com/feed/', topics: ['outdoors'] },
  { feedUrl: 'https://andrewskurka.com/feed/', topics: ['outdoors'] },
  { feedUrl: 'https://blog.mingthein.com/feed/', topics: ['photography'] },
  { feedUrl: 'https://caseyhandmer.wordpress.com/feed/', topics: ['science'] },

  // 简体中文
  { feedUrl: 'https://www.ruanyifeng.com/blog/atom.xml', topics: ['tech'] },
  { feedUrl: 'https://blog.codingnow.com/atom.xml', topics: ['tech'] },
  { feedUrl: 'https://kexue.fm/feed', topics: ['science', 'tech'] },
  { feedUrl: 'https://baoyu.io/feed.xml', topics: ['tech'] },
  { feedUrl: 'https://www.zhangxinxu.com/wordpress/feed/', topics: ['design', 'tech'] },
  { feedUrl: 'https://tw93.fun/feed.xml', topics: ['tech', 'life'] },
  { feedUrl: 'https://hutusi.com/feed.xml', topics: ['tech', 'essays'] },

  // 正體中文
  { feedUrl: 'https://blog.gslin.org/feed/', topics: ['tech'] },
  { feedUrl: 'https://www.playpcesor.com/feeds/posts/default', topics: ['tech', 'life'] },

  // Other source languages, which is where reading a post beside its original earns its keep.
  { feedUrl: 'https://azukiazusa.dev/rss.xml', topics: ['tech'], note: '日本語' },
  { feedUrl: 'https://www.44bits.io/ko/feed/all', topics: ['tech'], note: '한국어' },
  { feedUrl: 'https://blog.koalite.com/feed/', topics: ['tech'], note: 'Español' },
] as const satisfies readonly CuratedSite[]

// Deliberately absent: rachelbythebay.com. She runs a feed-reader conformance test and blocks
// readers that poll too often — seeding her blog three times in fifteen minutes while staging
// this earned an outright connection refusal. Our scheduled fetches do honour conditional
// requests, so the entry is defensible; re-add it only after verifying that from an address we
// have not already burned, and never inside a `--skip`-less widening run.
