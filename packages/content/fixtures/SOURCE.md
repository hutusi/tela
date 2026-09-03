# Feed fixtures

Real feeds captured with `curl` on 2026-09-04 for parser and pipeline tests. They are used only
to exercise the content pipeline; the content belongs to its authors. Keep each file under
~1.5 MB and list every file in `src/fixtures.test-helper.ts` (the test fails otherwise).

| File | Source | Language | Notes |
|---|---|---|---|
| `jvns.atom.xml` | https://jvns.ca/atom.xml | en | Hugo, Atom, full content |
| `simonwillison.atom.xml` | https://simonwillison.net/atom/everything/ | en | Django, Atom, mixed entry types |
| `daringfireball.atom.xml` | https://daringfireball.net/feeds/main | en | Atom with `xml:base`, linked-list posts |
| `daringfireball.feed.json` | https://daringfireball.net/feeds/json | en | JSON Feed |
| `jimnielsen.feed.json` | https://blog.jim-nielsen.com/feed.json | en | JSON Feed, indie blog |
| `joelonsoftware.rss.xml` | https://www.joelonsoftware.com/feed/ | en | WordPress RSS, `content:encoded` |
| `codinghorror.rss.xml` | https://blog.codinghorror.com/rss/ | en | Ghost RSS |
| `smashing.rss.xml` | https://www.smashingmagazine.com/feed/ | en | RSS, large |
| `overreacted.rss.xml` | https://overreacted.io/rss.xml | en | Custom RSS |
| `manuelmoreale.rss.xml` | https://manuelmoreale.com/feed/rss | en | Kirby RSS |
| `ruanyifeng.atom.xml` | https://www.ruanyifeng.com/blog/atom.xml | zh-Hans | Movable Type, Atom |
| `codingnow.atom.xml` | https://blog.codingnow.com/atom.xml | zh-Hans | Movable Type, Atom |
| `tw93weekly.rss.xml` | https://weekly.tw93.fun/rss.xml | zh-Hans | Hexo RSS, weekly digest |
| `hutusi.rss.xml` | https://hutusi.com/feed.xml | zh-Hans | Jekyll, RSS |
| `coolshell.rss.xml` | https://coolshell.cn/feed | zh-Hans | WordPress RSS |
| `owenyoung.atom.xml` | https://www.owenyoung.com/atom.xml | zh-Hans | Hugo, Atom |
| `jnito.rss.xml` | https://blog.jnito.com/rss | ja | Hatena Blog RSS |
| `azukiazusa.rss.xml` | https://azukiazusa.dev/rss.xml | ja | Static site RSS |
| `44bits.rss.xml` | https://www.44bits.io/ko/feed/all | ko | RSS with dc namespace |
| `koalite.rss.xml` | https://blog.koalite.com/feed/ | es | WordPress RSS |
| `slashdot.rdf.xml` | https://rss.slashdot.org/Slashdot/slashdotMain | en | RSS 1.0 (RDF), summary-only |
