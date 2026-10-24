/**
 * One post in English and one in Chinese holding every block the reader styles: headings, both
 * kinds of list, inline and block code, an image inside a sentence, a quotation, a table whose
 * corner cell is empty, a figure with its caption, a definition list, a disclosure and a footnote
 * marker. The styles spec measures each in every layout, in both scripts. Served at
 * `/formatting/<lang>.xml`, dated 2020 so they sort below every other fixture.
 */
export const FORMATTING = {
  en: {
    title: 'Formatting fixture in English',
    words: {
      opening: 'The opening paragraph sets the scene for everything the post goes on to say.',
      heading: 'A section heading',
      inline: [
        'Text with',
        'inline code',
        'and a small picture',
        'inside the sentence, which carries on after it.',
      ],
      subheading: 'A smaller heading',
      bullets: ['The first bullet point', 'The second bullet point'],
      steps: ['The first numbered step', 'The second numbered step'],
      quote: 'A quotation from somewhere else, set apart from the text around it.',
      table: ['Before', 'After', 'Speed', 'Slow', 'Fast'],
      caption: 'A caption under the figure',
      term: 'Term',
      definition: 'Its definition, indented under the term it explains.',
      summary: 'More details',
      detail: 'The detail that was folded away.',
      footnote: ['A footnote marker', 'sits in this sentence.'],
      closing:
        'A last paragraph, long enough to wrap onto more than one line in a column of the reader, so that the space after the block above it is measured against real text.',
    },
  },
  zh: {
    title: '排版示例',
    words: {
      opening: '开头这一段交代了整篇文章接下来要讲的所有事情，读者从这里开始进入正文。',
      heading: '这是一个小节标题',
      inline: [
        '这段文字里有',
        '行内代码',
        '还有一张小图',
        '嵌在句子当中，句子在图后面继续往下写。',
      ],
      subheading: '这是一个更小的标题',
      bullets: ['第一个要点写在这里', '第二个要点写在这里'],
      steps: ['第一步先做这件事情', '第二步再做那件事情'],
      quote: '这是从别处引来的一段话，和周围的正文分开排列。',
      table: ['之前', '之后', '速度', '很慢', '很快'],
      caption: '图片下方的说明文字',
      term: '术语',
      definition: '这是术语的解释，排在术语下面并且缩进。',
      summary: '更多细节',
      detail: '这里是被折叠起来的细节内容。',
      footnote: ['句子里有一个脚注标记', '然后句子继续。'],
      closing:
        '最后一段写得足够长，在阅读器的一栏里会换成好几行，这样上面那个块之后的间距就是对着真实的文字来测量的，而不是一行短短的字。',
    },
  },
} as const

export const FORMATTING_LANGS = Object.keys(FORMATTING) as (keyof typeof FORMATTING)[]

function body(lang: keyof typeof FORMATTING, port: number): string {
  const w = FORMATTING[lang].words
  const pixel = `http://127.0.0.1:${port}/pixel.png`
  return [
    `<p>${w.opening}</p>`,
    `<h2>${w.heading}</h2>`,
    `<p>${w.inline[0]} <code>${w.inline[1]}</code> ${w.inline[2]} <img src="${pixel}" alt="dot" width="16" height="16"> ${w.inline[3]}</p>`,
    `<h3>${w.subheading}</h3>`,
    `<ul>${w.bullets.map((b) => `<li>${b}</li>`).join('')}</ul>`,
    `<ol>${w.steps.map((s) => `<li>${s}</li>`).join('')}</ol>`,
    '<pre><code>const answer = 42\nconsole.log(answer)</code></pre>',
    `<blockquote><p>${w.quote}</p></blockquote>`,
    `<table><tr><th></th><th>${w.table[0]}</th><th>${w.table[1]}</th></tr><tr><td>${w.table[2]}</td><td>${w.table[3]}</td><td>${w.table[4]}</td></tr></table>`,
    `<figure><img src="${pixel}" alt="figure" width="320" height="200"><figcaption>${w.caption}</figcaption></figure>`,
    `<dl><dt>${w.term}</dt><dd>${w.definition}</dd></dl>`,
    `<details><summary>${w.summary}</summary><p>${w.detail}</p></details>`,
    `<p>${w.footnote[0]}<sup>1</sup>${lang === 'en' ? ' ' : ''}${w.footnote[1]}</p>`,
    `<p>${w.closing}</p>`,
  ].join('')
}

export function formattingFeed(lang: keyof typeof FORMATTING, port: number): string {
  const { title } = FORMATTING[lang]
  const home = `http://127.0.0.1:${port}/formatting/${lang}`
  return `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
    <channel><title>Formatting Fixture (${lang})</title><link>${home}</link><language>${lang}</language>
    <item><guid>formatting-${lang}-1</guid><link>${home}/posts/1</link>
      <title>${title}</title><pubDate>Wed, 08 Jan 2020 08:00:00 GMT</pubDate>
      <content:encoded><![CDATA[${body(lang, port)}]]></content:encoded>
    </item></channel></rss>`
}
