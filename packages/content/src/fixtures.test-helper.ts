import { join } from 'node:path'

export const FIXTURES_DIR = join(import.meta.dir, '..', 'fixtures', 'feeds')

/** Fixture file → the URL it was captured from. Keep in sync with fixtures/SOURCE.md. */
export const FIXTURE_FEEDS: Record<string, string> = {
  'jvns.atom.xml': 'https://jvns.ca/atom.xml',
  'simonwillison.atom.xml': 'https://simonwillison.net/atom/everything/',
  'daringfireball.atom.xml': 'https://daringfireball.net/feeds/main',
  'daringfireball.feed.json': 'https://daringfireball.net/feeds/json',
  'jimnielsen.feed.json': 'https://blog.jim-nielsen.com/feed.json',
  'joelonsoftware.rss.xml': 'https://www.joelonsoftware.com/feed/',
  'codinghorror.rss.xml': 'https://blog.codinghorror.com/rss/',
  'smashing.rss.xml': 'https://www.smashingmagazine.com/feed/',
  'overreacted.rss.xml': 'https://overreacted.io/rss.xml',
  'manuelmoreale.rss.xml': 'https://manuelmoreale.com/feed/rss',
  'ruanyifeng.atom.xml': 'https://www.ruanyifeng.com/blog/atom.xml',
  'codingnow.atom.xml': 'https://blog.codingnow.com/atom.xml',
  'tw93weekly.rss.xml': 'https://weekly.tw93.fun/rss.xml',
  'hutusi.rss.xml': 'https://hutusi.com/feed.xml',
  'coolshell.rss.xml': 'https://coolshell.cn/feed',
  'owenyoung.atom.xml': 'https://www.owenyoung.com/atom.xml',
  'jnito.rss.xml': 'https://blog.jnito.com/rss',
  'azukiazusa.rss.xml': 'https://azukiazusa.dev/rss.xml',
  '44bits.rss.xml': 'https://www.44bits.io/ko/feed/all',
  'koalite.rss.xml': 'https://blog.koalite.com/feed/',
  'slashdot.rdf.xml': 'https://rss.slashdot.org/Slashdot/slashdotMain',
}
