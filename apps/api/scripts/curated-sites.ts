import type { Topic } from '@tela/shared'

/**
 * One editorially chosen blog. The note is for whoever reviews a change to this list; it is
 * never stored. Prefer a feed of recent items over a full archive: the worker reads a feed up to
 * 10 MB, and a decade of posts in one file can still fail the fetch as `too_large`.
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
   * The blog's name, where its feed gives a poor one: the feed's own name ("feed - …"), a bare
   * address, a brand, or none at all. Applied unless a writer has claimed the blog.
   */
  title?: string
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
 * a masthead does not belong here. The AI labs at the end are the one exception (ADR 0068): listed
 * under AI alone and never featured, so the front shelf and the other chips stay the writers'.
 *
 * All ten topics are covered on purpose: /discover renders every chip whether or not anything
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
  { feedUrl: 'https://simonwillison.net/atom/everything/', topics: ['ai', 'tech'], featured: true },
  { feedUrl: 'https://jvns.ca/atom.xml', topics: ['tech'] },
  { feedUrl: 'https://overreacted.io/rss.xml', topics: ['tech'] },
  { feedUrl: 'https://daringfireball.net/feeds/main', topics: ['tech'] },
  { feedUrl: 'https://macwright.com/rss.xml', topics: ['tech', 'life'] },
  { feedUrl: 'https://hillelwayne.com/index.xml', topics: ['tech', 'science'] },
  { feedUrl: 'https://www.interconnects.ai/feed', topics: ['ai', 'tech', 'science'] },
  { feedUrl: 'https://magazine.sebastianraschka.com/feed', topics: ['ai', 'tech', 'science'] },
  { feedUrl: 'https://sive.rs/en.atom', topics: ['essays'] },
  { feedUrl: 'https://robinsloan.com/feed.xml', topics: ['essays'], featured: true },
  {
    feedUrl: 'https://manuelmoreale.com/feed/rss',
    title: 'Manuel Moreale',
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
    title: 'Chinese Cooking Demystified',
    topics: ['food'],
    note: 'A couple writing together',
  },
  {
    feedUrl: 'https://www.markhorrell.com/blog/feed/',
    topics: ['outdoors'],
    title: 'Mark Horrell',
  },
  {
    feedUrl: 'https://britishcoast.wordpress.com/feed/',
    topics: ['outdoors'],
    note: 'Walking the coast of mainland Britain in stages',
  },
  { feedUrl: 'https://longstride.net/feed.xml', topics: ['outdoors'] },
  { feedUrl: 'https://theness.com/neurologicablog/feed/', topics: ['science'], featured: true },
  { feedUrl: 'https://www.experimental-history.com/feed', topics: ['science', 'essays'] },
  { feedUrl: 'https://scottaaronson.blog/?feed=rss2', topics: ['science', 'tech'] },
  { feedUrl: 'https://www.chrbutler.com/feed.rss', topics: ['design', 'essays'] },
  {
    feedUrl: 'https://www.johncoulthart.com/feuilleton/feed/',
    topics: ['design', 'essays'],
    note: 'John Coulthart, on illustration, book and poster design',
  },
  {
    feedUrl: 'https://idiotic-hat.blogspot.com/feeds/posts/default',
    topics: ['photography', 'essays'],
  },
  // From the HN Popularity Contest's ranking for 2025 (popularity.refactoringenglish.com), checked
  // on 2026-10-29: blogs one person writes, posted in the 60 days before, whose feed Tela reads.
  // Left out: what is not a person's blog (neal.fun, companies, news sites), rachelbythebay.com
  // (it drops Cloudflare's connections), brooker.co.za (unreachable from production twice on
  // 2026-10-29, though it answers elsewhere), tedunangst.com (its certificate does not verify),
  // xeiaso.net (its robots.txt says `ai-input=no`, and Tela translates with a model), blogs on a
  // host other blogs share (buttondown.com, world.hey.com, and The Old New Thing on
  // devblogs.microsoft.com, beside the TypeScript and .NET blogs: a blog is an origin, so they
  // would be one blog), the politics and economics newsletters and the paywalled ones (the
  // owner's call), and anything quiet 60 days.
  {
    feedUrl: 'https://www.seangoedecke.com/rss.xml',
    topics: ['tech', 'ai'],
    title: 'Sean Goedecke',
  },
  { feedUrl: 'https://jeffgeerling.com/rss.xml', topics: ['tech'] },
  { feedUrl: 'https://krebsonsecurity.com/feed/', topics: ['tech'] },
  { feedUrl: 'https://idiallo.com/feed.rss', topics: ['tech', 'essays'], title: 'iDiallo' },
  { feedUrl: 'https://maurycyz.com/index.xml', topics: ['tech', 'science'] },
  {
    feedUrl: 'https://blog.coredump.cx/feed',
    topics: ['tech', 'science'],
    note: 'Michał Zalewski (lcamtuf); lcamtuf.substack.com redirects here',
  },
  { feedUrl: 'https://mitchellh.com/feed.xml', topics: ['tech'] },
  { feedUrl: 'https://www.righto.com/feeds/posts/default', topics: ['tech', 'science'] },
  { feedUrl: 'https://lucumr.pocoo.org/feed.atom', topics: ['tech', 'ai'] },
  { feedUrl: 'https://matklad.github.io/feed.xml', topics: ['tech'] },
  { feedUrl: 'https://evanhahn.com/feed.xml', topics: ['tech'], title: 'Evan Hahn' },
  { feedUrl: 'https://xania.org/feed.atom', topics: ['tech'] },
  { feedUrl: 'https://nesbitt.io/feed.xml', topics: ['tech'] },
  { feedUrl: 'https://borretti.me/feed', topics: ['tech', 'essays'] },
  {
    feedUrl: 'https://eli.thegreenplace.net/feeds/all.atom.xml',
    topics: ['tech'],
    title: 'Eli Bendersky',
  },
  { feedUrl: 'https://matduggan.com/rss/', topics: ['tech', 'essays'], title: 'Mat Duggan' },
  { feedUrl: 'https://bernsteinbear.com/feed.xml', topics: ['tech'] },
  { feedUrl: 'https://www.troyhunt.com/rss/', topics: ['tech'] },
  { feedUrl: 'https://herman.bearblog.dev/feed/', topics: ['tech', 'life'] },
  { feedUrl: 'https://filippo.io/atom.xml', topics: ['tech'] },
  { feedUrl: 'https://soatok.blog/feed/', topics: ['tech'] },
  { feedUrl: 'https://daniel.haxx.se/blog/feed/', topics: ['tech'], title: 'Daniel Stenberg' },
  { feedUrl: 'https://www.tbray.org/ongoing/ongoing.atom', topics: ['tech', 'essays'] },
  { feedUrl: 'https://alexwlchan.net/feed', topics: ['tech'] },
  { feedUrl: 'https://marginalia.nu/index.xml', topics: ['tech'], title: 'marginalia.nu' },
  { feedUrl: 'https://jyn.dev/atom.xml', topics: ['tech'], title: 'jyn' },
  { feedUrl: 'https://micahflee.com/rss/', topics: ['tech'] },
  { feedUrl: 'https://oldvcr.blogspot.com/feeds/posts/default', topics: ['tech'] },
  { feedUrl: 'https://martinfowler.com/feed.atom', topics: ['tech'] },
  { feedUrl: 'https://blogsystem5.substack.com/feed', topics: ['tech'] },
  { feedUrl: 'https://ounapuu.ee/index.xml', topics: ['tech'] },
  { feedUrl: 'https://entropicthoughts.com/feed', topics: ['tech', 'essays'] },
  { feedUrl: 'https://www.downtowndougbrown.com/feed/', topics: ['tech'] },
  {
    feedUrl: 'https://www.gilesthomas.com/feed/rss.xml',
    topics: ['ai', 'tech'],
    title: 'Giles Thomas',
  },
  { feedUrl: 'https://minimaxir.com/index.xml', topics: ['ai', 'tech'] },
  { feedUrl: 'https://www.dbreunig.com/feed.xml', topics: ['ai', 'tech'] },
  {
    feedUrl: 'https://www.oneusefulthing.org/feed',
    topics: ['ai', 'essays'],
    note: 'Ethan Mollick',
  },
  { feedUrl: 'https://martinalderson.com/feed.xml', topics: ['ai', 'tech'] },
  { feedUrl: 'https://dynomight.net/feed.xml', topics: ['science', 'essays'], title: 'Dynomight' },
  { feedUrl: 'https://www.construction-physics.com/feed', topics: ['science', 'cities'] },
  { feedUrl: 'https://tedium.co/feed', topics: ['essays', 'tech'], note: 'Ernie Smith' },
  { feedUrl: 'https://www.filfre.net/feed/', topics: ['essays', 'tech'] },
  { feedUrl: 'https://computer.rip/rss.xml', topics: ['tech', 'essays'] },
  { feedUrl: 'https://acoup.blog/feed/', topics: ['essays'] },
  { feedUrl: 'https://www.henrikkarlsson.xyz/feed', topics: ['essays'] },
  { feedUrl: 'https://steveblank.com/feed/', topics: ['essays', 'tech'] },
  { feedUrl: 'https://www.anildash.com/feed.xml', topics: ['essays', 'tech'] },
  { feedUrl: 'https://resobscura.substack.com/feed', topics: ['essays', 'science'] },
  // Each of these posts four times a week or more, so they lead Discover's newest whenever they
  // write: kept on the owner's word, for who they are.
  { feedUrl: 'https://www.johndcook.com/blog/feed/', topics: ['science', 'tech'] },
  { feedUrl: 'https://terrytao.wordpress.com/feed/', topics: ['science'], title: 'Terence Tao' },
  { feedUrl: 'https://shkspr.mobi/blog/feed/atom/', topics: ['tech', 'essays'] },
  { feedUrl: 'https://www.astralcodexten.com/feed', topics: ['essays', 'science'] },
  {
    feedUrl: 'https://utcc.utoronto.ca/~cks/space/blog/?atom',
    topics: ['tech'],
    title: 'Chris Siebenmann',
    note: 'Rate-limits a client that asks too often (429)',
  },

  // 简体中文
  { feedUrl: 'https://www.ruanyifeng.com/blog/atom.xml', topics: ['tech'], featured: true },
  { feedUrl: 'https://blog.codingnow.com/atom.xml', topics: ['tech'] },
  { feedUrl: 'https://kexue.fm/feed', topics: ['ai', 'science', 'tech'] },
  { feedUrl: 'https://baoyu.io/feed.xml', topics: ['ai', 'tech'] },
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
  { feedUrl: 'https://yufree.cn/index.xml', topics: ['science', 'essays'], title: '于淼' },
  { feedUrl: 'https://citydatum.cn/feed', topics: ['cities'], title: '橙树志' },
  { feedUrl: 'https://bluehe.cn/feed/', topics: ['photography', 'cities'] },
  { feedUrl: 'https://yilinhut.net/feed/', topics: ['science', 'essays'] },
  { feedUrl: 'https://ygz.ink/feed', topics: ['outdoors', 'life'], title: '宗宗酱' },
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
  {
    feedUrl: 'https://wilsonchao.com/blog/feed.xml',
    topics: ['life', 'science', 'essays'],
    title: '趙玴祥',
    note: 'A cardiac surgeon in Kaohsiung; the site-wide /feed.xml mixes in music links',
  },
  { feedUrl: 'https://tianyanfeng.blog/feed/', topics: ['essays', 'life'] },
  { feedUrl: 'https://shenjing.me/blog/rss.xml', topics: ['life', 'essays'], title: 'Shen Jing' },
  { feedUrl: 'https://jai33snotes.com/feed/', topics: ['essays', 'life', 'outdoors'] },
  {
    feedUrl: 'https://travlog.wei-lee.me/zh-tw/feeds/all.atom.xml',
    topics: ['cities', 'food'],
    note: 'Wei Lee travelling and eating; excerpts in the feed, and the pages extract cleanly',
  },

  // Français
  { feedUrl: 'https://www.bortzmeyer.org/feed-full.atom', topics: ['tech'], featured: true },
  {
    feedUrl: 'https://tcrouzet.com/feeds/feed.xml',
    title: 'Thierry Crouzet',
    topics: ['essays', 'outdoors'],
    featured: true,
  },
  {
    feedUrl: 'https://affordance.framasoft.org/feed/',
    topics: ['essays', 'tech'],
    title: 'Affordance',
  },
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
  {
    feedUrl: 'https://jeanneemard.wordpress.com/feed/',
    topics: ['essays'],
    note: 'Québec',
    title: 'Jeanne Émard',
  },
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
  {
    feedUrl: 'https://www.liminaire.fr/spip.php?page=backend',
    topics: ['photography', 'cities'],
    title: 'Liminaire',
    note: 'Pierre Ménard',
  },
  {
    feedUrl: 'https://lunettesrouges1.wordpress.com/feed/',
    topics: ['photography', 'essays'],
    note: 'Marc Lenot on exhibitions; excerpts in the feed, and the pages extract cleanly',
  },

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
    title: 'ニューロサイエンスとマーケティングの間',
    topics: ['essays', 'cities', 'science'],
    note: '日本語',
  },
  {
    feedUrl: 'https://utsumikeiichi.hateblo.jp/feed',
    topics: ['design', 'cities', 'photography'],
    title: 'ぬかよろこび通信Q',
    note: '日本語; Keiichi Utsumi, on pictograms and everyday street design',
  },
  {
    feedUrl: 'https://yasuhisa.com/could/rss/',
    topics: ['design', 'essays'],
    title: 'could',
    note: '日本語; Yasuhisa Hasegawa; about monthly, in for the design chip',
  },
  {
    feedUrl: 'https://filmmer.hatenablog.com/feed',
    topics: ['photography', 'life'],
    note: '日本語',
  },
  {
    feedUrl: 'https://tsujimotter.hatenablog.com/feed',
    topics: ['science'],
    note: '日本語; mathematics, with TeX',
  },
  {
    feedUrl: 'https://hayasinonakanozou.hatenablog.com/feed',
    topics: ['essays', 'cities'],
    note: '日本語',
  },
  { feedUrl: 'https://www.44bits.io/ko/feed/all', topics: ['tech'], note: '한국어' },
  {
    feedUrl: 'https://www.bluexmas.com/feed/',
    title: 'bluexmas',
    featured: true,
    topics: ['food', 'essays'],
    note: '한국어; excerpts in the feed, and the pages extract cleanly',
  },
  { feedUrl: 'https://jojoldu.tistory.com/rss', topics: ['essays', 'tech'], note: '한국어' },
  {
    feedUrl: 'http://moogi.new21.org/tc/rss',
    title: '김 용묵의 절대공간',
    topics: ['tech', 'science', 'life'],
    note: '한국어; https times out',
  },
  {
    feedUrl: 'https://nasica1.tistory.com/rss',
    topics: ['essays', 'cities'],
    note: '한국어; long history series',
  },
  {
    feedUrl: 'https://ryunan9903.tistory.com/rss',
    topics: ['food', 'life'],
    title: '류토피아',
    note: '한국어; about two posts a day',
  },
  {
    feedUrl: 'https://www.buddenbohm-und-soehne.de/feed/',
    featured: true,
    topics: ['essays', 'life', 'cities'],
    note: 'Deutsch',
  },
  { feedUrl: 'https://www.designtagebuch.de/feed/', topics: ['design'], note: 'Deutsch' },
  { feedUrl: 'https://www.zukunft-mobilitaet.net/feed/', topics: ['cities'], note: 'Deutsch' },
  {
    feedUrl: 'https://maipenquynh.de/de/feed/',
    topics: ['photography', 'life'],
    note: 'Deutsch; the German feed lives under /de/',
  },
  { feedUrl: 'https://magentratzerl.de/feed/', topics: ['food'], note: 'Deutsch' },
  {
    feedUrl: 'https://www.vorspeisenplatte.de/speisen/feed',
    topics: ['life', 'food', 'essays'],
    note: 'Deutsch; die Kaltmamsell, daily',
  },
  {
    feedUrl: 'https://wirres.net/feed/',
    topics: ['essays', 'life'],
    note: 'Deutsch; a soft hyphen in nearly every word, and still detected as German',
  },
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
    feedUrl: 'https://www.santiagodemolina.com/feeds/posts/default?redirect=false',
    topics: ['design', 'essays'],
    title: 'Múltiples estrategias de arquitectura',
    note: 'Español; Santiago de Molina, weekly; excerpts in the feed, and the pages extract cleanly',
  },
  {
    feedUrl: 'https://stepienybarno.es/blog/feed/',
    topics: ['design', 'cities'],
    title: 'Stepien y Barno',
    note: 'Español; an architect couple; the root /feed/ lists only site pages',
  },
  {
    feedUrl: 'https://artedemadrid.wordpress.com/feed/',
    topics: ['cities', 'essays'],
    note: 'Español',
  },
  {
    feedUrl: 'https://danielmurmarin.blogspot.com/feeds/posts/default',
    topics: ['outdoors', 'photography'],
    title: 'Crónicas Montañeras',
    note: 'Español; Pyrenees trip reports',
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
    feedUrl: 'https://saopauloantiga.com.br/feed/',
    topics: ['cities', 'photography'],
    note: 'Português; excerpts in the feed, and the pages extract cleanly',
  },
  {
    feedUrl: 'https://restosdecoleccao.blogspot.com/feeds/posts/default',
    topics: ['cities', 'design'],
    note: 'Português; excerpts in the feed, and the pages extract cleanly',
  },
  {
    feedUrl: 'https://leonardo.blogspot.com/feeds/posts/default?redirect=false',
    topics: ['essays'],
    note: 'Italiano; without redirect=false, Blogger sends the feed to http FeedBurner',
  },
  { feedUrl: 'https://attivissimo.me/feed/', topics: ['science', 'tech'], note: 'Italiano' },
  {
    feedUrl: 'https://letteredallatoscana.substack.com/feed',
    topics: ['food', 'essays'],
    note: 'Italiano; Giulia Scarpaleggia',
  },
  {
    feedUrl: 'https://aldopiombino.blogspot.com/feeds/posts/default',
    topics: ['science'],
    title: 'Scienzeedintorni',
    note: 'Italiano; Aldo Piombino, geology',
  },

  // Blogs an operator listed from members' subscriptions (ADR 0041), here for their topics and
  // names: listed without a topic, a blog shows under All and under no chip. They came in by
  // review rather than by this list's bar, so one stays while it has posted in six months.
  { feedUrl: 'https://addyosmani.com/rss.xml', topics: ['tech'], title: 'Addy Osmani' },
  { feedUrl: 'https://lilianweng.github.io/index.xml', topics: ['ai', 'science', 'tech'] },
  { feedUrl: 'https://swyx.io/rss.xml', topics: ['ai', 'tech', 'essays'], title: 'swyx' },
  {
    feedUrl: 'https://brennan.day/feed.xml',
    topics: ['essays', 'tech'],
    title: "Brennan's Weblog",
  },
  {
    feedUrl: 'https://yihui.org/index.xml',
    topics: ['tech', 'science'],
    title: 'Yihui Xie | 谢益辉',
    note: 'Writes in English and Chinese',
  },
  {
    feedUrl: 'https://refactoringenglish.com/blog/index.xml',
    topics: ['essays', 'tech'],
    title: 'Refactoring English',
  },
  { feedUrl: 'https://limboy.me/index.xml', topics: ['essays', 'tech'] },
  { feedUrl: 'https://www.longluo.me/atom.xml', topics: ['tech', 'science'] },
  { feedUrl: 'https://onevcat.com/feed.xml', topics: ['tech'] },
  { feedUrl: 'https://geektutu.com/feed.xml', topics: ['tech'] },
  { feedUrl: 'https://t9t.io/blog/zh/rss.xml', topics: ['tech', 'essays'], title: 'T9T' },
  { feedUrl: 'https://blog.yihong0618.me/rss.xml', topics: ['life', 'essays'] },
  { feedUrl: 'https://yinji.org/feed.xml', topics: ['life', 'essays', 'cities'] },
  { feedUrl: 'https://catcoding.me/atom.xml', topics: ['tech'] },
  { feedUrl: 'https://conge.livingwithfcs.org/feed.xml', topics: ['essays', 'life'] },
  { feedUrl: 'https://surmon.me/rss.xml', topics: ['tech', 'life'], title: 'Surmon' },
  { feedUrl: 'https://macshuo.com/?feed=rss2', topics: ['tech'], title: 'MacTalk' },
  { feedUrl: 'https://www.changhai.org/feed.xml', topics: ['science', 'essays'], title: '卢昌海' },
  { feedUrl: 'https://depp.wang/rss2.xml', topics: ['essays', 'tech', 'life'] },

  // AI labs (ADR 0068), the exception to blogs written by people: under AI alone, never featured,
  // and named as the lab, since their feeds name a section ("OpenAI News"). A lab with no feed of
  // its own is read through a maintained one elsewhere whose <link> names the lab, so it files
  // under the lab's blog and Add finds it from the lab's address. Never rsshub.app: it refuses
  // feed readers and says it is for testing. Left out on 2026-10-28: NVIDIA's (the whole
  // company's news), Meta AI's and xAI's (nothing in 30 days; x.ai answers bots 403), Qwen's
  // (quiet since 2025-08), and on 2026-10-29 Microsoft Research's: www.microsoft.com is also the
  // Security blog's host, and a blog is an origin, so a member's subscription to it would join
  // the lab under AI and could take its Subscribe.
  {
    feedUrl: 'https://openai.com/news/rss.xml',
    topics: ['ai'],
    title: 'OpenAI',
    note: 'No text in the feed and openai.com answers bots 403 (2026-10-28): posts may stay excerpts',
  },
  { feedUrl: 'https://deepmind.google/blog/rss.xml', topics: ['ai'], title: 'Google DeepMind' },
  { feedUrl: 'https://research.google/blog/rss/', topics: ['ai'], title: 'Google Research' },
  { feedUrl: 'https://huggingface.co/blog/feed.xml', topics: ['ai'], title: 'Hugging Face' },
  { feedUrl: 'https://mistral.ai/news/rss', topics: ['ai'], title: 'Mistral AI' },
  {
    feedUrl:
      'https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_research.xml',
    topics: ['ai'],
    title: 'Anthropic',
    note: 'Kept by github.com/Olshansk/rss-feeds, as Engineering is. Not News: it repeats Research',
  },
  {
    feedUrl:
      'https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_engineering.xml',
    topics: ['ai'],
    title: 'Anthropic',
  },
  {
    feedUrl: 'https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_cohere.xml',
    topics: ['ai'],
    title: 'Cohere',
    note: 'No feed of its own; kept by the same repository',
  },
] as const satisfies readonly CuratedSite[]

// Deliberately absent: rachelbythebay.com. She runs a feed-reader conformance test and blocks
// readers that poll too often — seeding her blog three times in fifteen minutes while staging
// this earned an outright connection refusal. Our scheduled fetches do honour conditional
// requests, so the entry is defensible; re-add it only after verifying that from an address we
// have not already burned, and never inside a `--skip`-less widening run.
