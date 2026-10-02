/**
 * Four blogs that wrote this week, in four languages, for the front page's edition (ADR 0035):
 * every captured feed is months old by the time a run reads it. The fixture server serves them
 * at `/fresh/<lang>.xml`; the visitor spec looks for their titles. Text long and plain enough to
 * be read in its own language, and no images.
 */
export const FRESH = {
  es: {
    blog: 'Cuaderno de Valparaíso',
    titles: [
      'Un paseo por el mercado de los sábados',
      'La biblioteca del barrio cumple cien años',
      'Cartas desde la costa en invierno',
    ],
    body: [
      'Cada sábado por la mañana, el mercado se llena de vecinos que buscan fruta fresca, pan recién horneado y una conversación tranquila con los vendedores de siempre.',
      'Las calles del puerto suben y bajan entre casas de colores, y desde cada mirador se ve el mar, que cambia de color según la hora del día y el humor del cielo.',
      'Escribo estas notas para recordar lo pequeño: el olor del café en la esquina, el ruido de los ascensores antiguos y las voces de los niños que vuelven de la escuela.',
    ],
  },
  ja: {
    blog: '港町の手帖',
    titles: ['土曜日の市場を歩く', '町の図書館が百周年を迎えた', '冬の海辺からの手紙'],
    body: [
      '毎週土曜日の朝になると、市場には新鮮な果物や焼きたてのパンを求める近所の人たちが集まり、いつもの店主とのんびりした会話を楽しんでいます。',
      '港の坂道は色とりどりの家々のあいだを上ったり下ったりしていて、どの展望台からも海が見えます。海の色は時間や空の機嫌によって少しずつ変わっていきます。',
      'このノートは小さなことを覚えておくために書いています。角の喫茶店のコーヒーの香り、古いエレベーターの音、そして学校から帰る子どもたちの声のことです。',
    ],
  },
  zh: {
    blog: '海港笔记',
    titles: ['周六的集市漫步', '街区图书馆迎来百年', '冬日海边的来信'],
    body: [
      '每个星期六的早晨，集市里都挤满了邻居，他们来买新鲜的水果和刚出炉的面包，也和熟悉的摊主们慢慢地聊上几句家常。',
      '港口的街道在五颜六色的房子之间上上下下，从每一个观景台都能看到大海，海水的颜色随着时间和天空的心情不断变化。',
      '我写下这些笔记，是为了记住那些小事情：街角咖啡馆的香气，老电梯发出的声音，还有放学回家的孩子们的说笑声。',
    ],
  },
  en: {
    blog: 'Harbour Notebook',
    titles: [
      'A walk through the Saturday market',
      'The neighbourhood library turns one hundred',
      'Letters from the coast in winter',
    ],
    body: [
      'Every Saturday morning the market fills with neighbours looking for fresh fruit, warm bread and an unhurried conversation with the stallholders they have known for years.',
      'The streets of the harbour climb and fall between painted houses, and from every lookout you can see the sea, which changes colour with the hour and with the mood of the sky.',
      'I write these notes to remember the small things: the smell of coffee on the corner, the creak of the old lifts, and the voices of children walking home from school.',
    ],
  },
} as const

export type FreshLang = keyof typeof FRESH

export const FRESH_LANGS = Object.keys(FRESH) as FreshLang[]

const DAY_MS = 86_400_000

/**
 * A feed built when it is asked for, dated from today but rounded to the day, so a refetch the
 * same day finds nothing changed. It declares its own home on a loopback port nothing listens on
 * (the fixture server's port + 1..4), so it is a blog of its own; its posts live on the fixture
 * server, at addresses no other feed shares.
 */
export function freshFeed(lang: FreshLang, port: number): string {
  const { blog, titles } = FRESH[lang]
  const index = FRESH_LANGS.indexOf(lang)
  const today = Math.floor(Date.now() / DAY_MS) * DAY_MS
  const items = titles.map((title, i) => {
    const n = i + 1
    // Newest first, a day apart; an hour apart between blogs; never after now.
    const at = new Date(today - i * DAY_MS - (index + 1) * 3_600_000).toUTCString()
    return `<item><guid>fresh-${lang}-${n}</guid><link>http://127.0.0.1:${port}/fresh/${lang}/${n}</link>
        <title>${title}</title><pubDate>${at}</pubDate>
        <content:encoded><![CDATA[${freshPost(lang, n)}]]></content:encoded></item>`
  })
  return `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
    <channel><title>${blog}</title><link>http://127.0.0.1:${port + index + 1}/</link>
      <language>${lang}</language>${items.join('')}</channel></rss>`
}

/** A post's body: its title's paragraph, then the blog's own text twice, 600 characters and more. */
export function freshPost(lang: FreshLang, n: number): string {
  const { titles, body } = FRESH[lang]
  return [titles[n - 1] ?? '', ...body, ...body].map((p) => `<p>${p}</p>`).join('')
}
