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
   * On Discover's front shelf: featured blogs come before every other listed one. Kept to a
   * hand-picked few, posting and spread across languages and topics, or the shelf means nothing.
   */
  featured?: true
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
 * Each entry was verified to serve a parseable feed under the body cap when it was added, and to
 * have posted in the 60 days before. A blog silent for six months leaves the list, since a
 * featured card that leads to a blog nobody writes any more makes the directory look abandoned.
 * Removing it here changes nothing in production: set it from Feature to List in the console as
 * well, and it stays readable under All.
 * Every entry is listed; the few marked `featured` are featured, and an entry that loses the mark
 * goes back to listed when the list is applied. A blog that leaves the list keeps its listing.
 * Changing this list is a reviewable commit; `bun run admin curate` applies it, and applying it
 * again changes nothing that is already right.
 */
export const CURATED_SITES = [
  // English
  { feedUrl: 'https://simonwillison.net/atom/everything/', topics: ['tech'], featured: true },
  { feedUrl: 'https://jvns.ca/atom.xml', topics: ['tech'] },
  { feedUrl: 'https://overreacted.io/rss.xml', topics: ['tech'] },
  { feedUrl: 'https://daringfireball.net/feeds/main', topics: ['tech'] },
  { feedUrl: 'https://macwright.com/rss.xml', topics: ['tech', 'life'] },
  { feedUrl: 'https://hillelwayne.com/index.xml', topics: ['tech', 'science'] },
  { feedUrl: 'https://sive.rs/en.atom', topics: ['essays'] },
  { feedUrl: 'https://robinsloan.com/feed.xml', topics: ['essays'], featured: true },
  {
    feedUrl: 'https://manuelmoreale.com/feed/rss',
    topics: ['essays', 'life'],
    note: 'Runs People & Blogs, an interview series about personal sites',
  },
  { feedUrl: 'https://craigmod.com/index.xml', topics: ['essays', 'photography'], featured: true },
  { feedUrl: 'https://maggieappleton.com/rss.xml', topics: ['design'] },
  { feedUrl: 'https://blog.jim-nielsen.com/feed.xml', topics: ['design', 'tech'] },
  { feedUrl: 'https://kottke.org/index.xml', topics: ['life'] },
  { feedUrl: 'https://austinkleon.com/feed/', topics: ['life', 'design'], featured: true },
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
  { feedUrl: 'https://caseyhandmer.wordpress.com/feed/', topics: ['science'] },
  {
    feedUrl: 'https://cphmag.com/feed-atom/',
    topics: ['photography'],
    note: 'Jörg Colberg alone, despite "Magazine"',
  },
  { feedUrl: 'https://guytal.blog/feed/', topics: ['photography', 'outdoors', 'essays'] },
  { feedUrl: 'https://www.thewanderinglensman.com/feeds/posts/default', topics: ['photography'] },
  { feedUrl: 'https://fupduckphoto.wordpress.com/feed/', topics: ['photography'] },
  { feedUrl: 'https://blog.jimgrey.net/feed/', topics: ['photography', 'life'] },
  {
    feedUrl: 'https://spitalfieldslife.com/feed/',
    featured: true,
    topics: ['cities', 'life'],
    note: 'East London, daily since 2009',
  },
  { feedUrl: 'https://ephemeralnewyork.wordpress.com/feed/', topics: ['cities'] },
  { feedUrl: 'https://humantransit.org/feed', topics: ['cities'] },
  { feedUrl: 'https://ruthreichl.substack.com/feed', topics: ['food', 'essays'], featured: true },
  { feedUrl: 'https://restaurant-ingthroughhistory.com/feed/', topics: ['food'] },
  { feedUrl: 'https://www.foodpolitics.com/feed/', topics: ['food', 'science'] },
  {
    feedUrl: 'https://chinesecookingdemystified.substack.com/feed',
    topics: ['food'],
    note: 'A couple writing together',
  },
  { feedUrl: 'https://www.markhorrell.com/blog/feed/', topics: ['outdoors'] },
  {
    feedUrl: 'https://britishcoast.wordpress.com/feed/',
    topics: ['outdoors'],
    note: 'Walking the coast of mainland Britain in stages',
  },
  { feedUrl: 'https://longstride.net/feed.xml', topics: ['outdoors'] },
  { feedUrl: 'https://theness.com/neurologicablog/feed/', topics: ['science'], featured: true },
  { feedUrl: 'https://www.experimental-history.com/feed', topics: ['science', 'essays'] },
  { feedUrl: 'https://scottaaronson.blog/?feed=rss2', topics: ['science', 'tech'] },

  // 简体中文
  { feedUrl: 'https://www.ruanyifeng.com/blog/atom.xml', topics: ['tech'], featured: true },
  { feedUrl: 'https://blog.codingnow.com/atom.xml', topics: ['tech'] },
  { feedUrl: 'https://kexue.fm/feed', topics: ['science', 'tech'] },
  { feedUrl: 'https://baoyu.io/feed.xml', topics: ['tech'] },
  {
    feedUrl: 'https://www.zhangxinxu.com/wordpress/feed/',
    topics: ['design', 'tech'],
    featured: true,
  },
  { feedUrl: 'https://tw93.fun/feed.xml', topics: ['tech', 'life'] },
  { feedUrl: 'https://hutusi.com/feed.xml', topics: ['tech', 'essays'], featured: true },
  { feedUrl: 'https://www.tortorse.com/atom.xml', topics: ['essays', 'design'], featured: true },
  { feedUrl: 'https://jia.je/feed.xml', topics: ['tech'] },
  { feedUrl: 'https://colobu.com/atom.xml', topics: ['tech'] },
  {
    feedUrl: 'https://feeds.feedburner.com/initiative',
    topics: ['tech', 'essays'],
    note: 'blog.est.im',
  },
  { feedUrl: 'https://www.jfsay.com/feed', topics: ['life', 'cities'], featured: true },
  { feedUrl: 'https://anotherdayu.com/feed/', topics: ['life', 'food', 'outdoors'] },
  { feedUrl: 'https://www.kawabangga.com/feed', topics: ['tech'] },
  { feedUrl: 'https://www.fengcan.net/feed/', topics: ['essays'] },
  { feedUrl: 'https://www.ixiqin.com/feed/', topics: ['tech', 'life'] },
  { feedUrl: 'https://mobius.blog/feed/', topics: ['essays', 'life'], featured: true },
  { feedUrl: 'https://elmagnifico.tech/feed.xml', topics: ['tech', 'outdoors'] },
  {
    feedUrl: 'http://weiwuhui.com/feed',
    topics: ['essays', 'tech'],
    note: 'https fails the handshake',
  },
  {
    feedUrl: 'https://blog.douchi.space/index.xml',
    topics: ['outdoors', 'life'],
    note: 'Excerpts in the feed; the pages extract cleanly',
  },
  { feedUrl: 'https://yufree.cn/index.xml', topics: ['science', 'essays'] },
  { feedUrl: 'https://citydatum.cn/feed', topics: ['cities'] },
  { feedUrl: 'https://bluehe.cn/feed/', topics: ['photography', 'cities'] },
  { feedUrl: 'https://yilinhut.net/feed/', topics: ['science', 'essays'] },
  { feedUrl: 'https://ygz.ink/feed', topics: ['outdoors', 'life'] },
  { feedUrl: 'https://www.geedea.pro/index.xml', topics: ['tech', 'essays'] },

  // 正體中文
  { feedUrl: 'https://blog.gslin.org/feed/', topics: ['tech'], featured: true },
  { feedUrl: 'https://www.playpcesor.com/feeds/posts/default', topics: ['tech', 'life'] },
  { feedUrl: 'https://readingoutpost.com/feed/', topics: ['essays'], featured: true },
  {
    feedUrl: 'https://blog.darkthread.net/feed/rss/',
    topics: ['tech'],
    note: 'Excerpts in the feed; the pages extract cleanly',
  },
  { feedUrl: 'https://alexhsu.com/rss.xml', topics: ['essays', 'life'], featured: true },
  { feedUrl: 'https://oliveassignment.xyz/feed/', topics: ['essays', 'cities'] },
  { feedUrl: 'https://ivonblog.com/index.xml', topics: ['tech'] },
  { feedUrl: 'https://blog.serv.idv.tw/feed', topics: ['tech', 'life'] },
  {
    feedUrl: 'https://feeds.feedburner.com/pmmustknow',
    topics: ['design', 'tech'],
    note: 'mrpm.cc; its own /feed answers a feed reader with HTML',
  },
  {
    feedUrl: 'https://taxodium.ink/rss.xml',
    topics: ['food', 'tech', 'outdoors'],
    note: 'Hong Kong; mixes scripts, and detection reads it as Traditional',
  },

  // Français
  { feedUrl: 'https://www.bortzmeyer.org/feed-full.atom', topics: ['tech'], featured: true },
  {
    feedUrl: 'https://tcrouzet.com/feeds/feed.xml',
    topics: ['essays', 'outdoors'],
    featured: true,
  },
  { feedUrl: 'https://affordance.framasoft.org/feed/', topics: ['essays', 'tech'] },
  { feedUrl: 'https://linterconnexionnestplusassuree.fr/feed/', topics: ['cities'] },
  {
    feedUrl: 'https://www.isabelleetlevelo.fr/feed/',
    featured: true,
    topics: ['cities'],
    note: 'Excerpts in the feed; the pages extract cleanly',
  },
  {
    feedUrl: 'https://ploum.net/atom_fr.xml',
    topics: ['essays', 'tech'],
    note: 'Belgium; the French feed of a blog that also writes in English',
  },
  { feedUrl: 'https://menace-theoriste.fr/feed/', topics: ['science', 'essays'] },
  {
    feedUrl: 'https://www.la-grange.net/feed.atom',
    topics: ['life', 'photography', 'cities'],
    note: 'Karl Dubost, writing from Japan',
  },
  {
    feedUrl: 'https://www.tierslivre.net/spip/spip.php?page=backend',
    featured: true,
    topics: ['essays', 'photography'],
    note: 'François Bon',
  },
  { feedUrl: 'https://jeanneemard.wordpress.com/feed/', topics: ['essays'], note: 'Québec' },
  { feedUrl: 'https://standblog.org/blog/feed/atom', topics: ['tech', 'essays'] },
  { feedUrl: 'https://gregorymignard.com/index.xml', topics: ['photography', 'life'] },
  {
    feedUrl: 'https://www.iletaitunefoislapatisserie.com/feeds/posts/default',
    topics: ['food'],
    note: 'Excerpts in the feed; the pages extract cleanly',
  },
  { feedUrl: 'https://couleur-science.eu/rss.php', topics: ['science'] },
  { feedUrl: 'https://www.velophile.be/feed/', topics: ['outdoors'], note: 'Belgium' },
  { feedUrl: 'https://www.arthurperret.fr/feed.xml', topics: ['design', 'tech'] },

  // Other source languages, which is where reading a post beside its original earns its keep.
  { feedUrl: 'https://azukiazusa.dev/rss.xml', topics: ['tech'], note: '日本語' },
  {
    feedUrl: 'https://p-shirokuma.hatenadiary.com/feed',
    featured: true,
    topics: ['essays', 'life'],
    note: '日本語',
  },
  { feedUrl: 'https://nonswan.hatenablog.com/feed', topics: ['outdoors', 'food'], note: '日本語' },
  {
    feedUrl: 'https://kaz-ataka.hatenablog.com/feed',
    topics: ['essays', 'cities', 'science'],
    note: '日本語',
  },
  { feedUrl: 'https://www.44bits.io/ko/feed/all', topics: ['tech'], note: '한국어' },
  {
    feedUrl: 'https://www.bluexmas.com/feed/',
    featured: true,
    topics: ['food', 'essays'],
    note: '한국어; excerpts in the feed, and the pages extract cleanly',
  },
  { feedUrl: 'https://jojoldu.tistory.com/rss', topics: ['essays', 'tech'], note: '한국어' },
  {
    feedUrl: 'http://moogi.new21.org/tc/rss',
    topics: ['tech', 'science', 'life'],
    note: '한국어; https times out',
  },
  {
    feedUrl: 'https://www.buddenbohm-und-soehne.de/feed/',
    featured: true,
    topics: ['essays', 'life', 'cities'],
    note: 'Deutsch',
  },
  { feedUrl: 'https://www.designtagebuch.de/feed/', topics: ['design'], note: 'Deutsch' },
  { feedUrl: 'https://www.zukunft-mobilitaet.net/feed/', topics: ['cities'], note: 'Deutsch' },
  { feedUrl: 'https://kirainet.com/feed/', topics: ['life', 'cities'], note: 'Español' },
  {
    feedUrl: 'https://danielmarin.naukas.com/feed/',
    topics: ['science'],
    note: 'Español',
    featured: true,
  },
  {
    feedUrl: 'https://elcafedeocata.blogspot.com/feeds/posts/default',
    topics: ['essays'],
    note: 'Español',
  },
  {
    feedUrl: 'https://manualdousuario.net/feed/',
    topics: ['tech'],
    note: 'Português',
    featured: true,
  },
  {
    feedUrl: 'https://cristhianoaguiar.substack.com/feed',
    topics: ['essays'],
    note: 'Português',
  },
  {
    feedUrl: 'https://dias-com-arvores.blogspot.com/feeds/posts/default',
    topics: ['science', 'outdoors', 'photography'],
    note: 'Português; excerpts in the feed, and the pages extract cleanly',
  },
  {
    feedUrl: 'https://leonardo.blogspot.com/feeds/posts/default?redirect=false',
    topics: ['essays'],
    note: 'Italiano; without redirect=false, Blogger sends the feed to http FeedBurner',
  },
  { feedUrl: 'https://attivissimo.me/feed/', topics: ['science', 'tech'], note: 'Italiano' },
] as const satisfies readonly CuratedSite[]

// Deliberately absent: rachelbythebay.com. She runs a feed-reader conformance test and blocks
// readers that poll too often — seeding her blog three times in fifteen minutes while staging
// this earned an outright connection refusal. Our scheduled fetches do honour conditional
// requests, so the entry is defensible; re-add it only after verifying that from an address we
// have not already burned, and never inside a `--skip`-less widening run.
