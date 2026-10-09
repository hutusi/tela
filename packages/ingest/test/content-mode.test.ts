import { describe, expect, test } from 'bun:test'
import { endsWithJumpLink, learnContentMode, wantsExtraction } from '../src/content-mode'

const sample = (chars: number, hadFullContent: boolean, tail = 'the end.', jumpLink = false) => ({
  chars,
  hadFullContent,
  tail,
  jumpLink,
})

describe('learnContentMode', () => {
  test('needs three samples', () => {
    expect(learnContentMode([sample(100, false), sample(100, false)])).toBe('unknown')
  })

  test('short bodies without a full-content field are summaries', () => {
    expect(learnContentMode([sample(120, false), sample(200, false), sample(90, false)])).toBe(
      'summary',
    )
  })

  test('long bodies are full even without content:encoded', () => {
    expect(learnContentMode([sample(2000, false), sample(3500, false), sample(1800, false)])).toBe(
      'full',
    )
  })

  test('read-more tails mark summaries even with a content field', () => {
    expect(
      learnContentMode([
        sample(900, true, 'Continue reading'),
        sample(950, true, '阅读全文'),
        sample(800, true, 'done'),
      ]),
    ).toBe('summary')
  })

  // The tails of three feeds learned as full that ship excerpts: a French Blogger blog, smitten
  // kitchen's theme, and kexue.fm. Each body is long enough to pass the median check alone.
  test('read-more tails with what themes put after them, and WordPress elisions', () => {
    for (const tail of ['réussir du premier coup. ... la suite par ici', 'Read more »', '[...]']) {
      expect(
        learnContentMode([
          sample(400, true, tail),
          sample(500, true, tail),
          sample(450, true, tail),
        ]),
      ).toBe('summary')
    }
    expect(
      learnContentMode([
        sample(900, true, '閱讀全文 →'),
        sample(950, true, 'Lire la suite ›'),
        sample(800, true),
      ]),
    ).toBe('summary')
  })

  test('a jump link marks a summary whatever its words say', () => {
    const jump = (chars: number) => sample(chars, true, 'Continuar a ler', true)
    expect(learnContentMode([jump(400), jump(500), jump(450)])).toBe('summary')
  })

  test('very short bodies are summaries even with a content field', () => {
    expect(learnContentMode([sample(200, true), sample(150, true), sample(250, true)])).toBe(
      'summary',
    )
  })
})

describe('endsWithJumpLink', () => {
  const post = 'https://www.iletaitunefoislapatisserie.com/2013/06/tarte-au-chocolat.html'

  test("Blogger's jump break and WordPress's more tag", () => {
    const blogger = `<p>Fondante et bien chocolatée.</p><div><img src="t.jpg"></div>\n<br><br>\n<a href="${post}#more">... la suite par ici</a>`
    expect(endsWithJumpLink(blogger, post)).toBe(true)
    const wordpress = `<p>The start.</p> <p><a href="https://example.com/2026/10/x/#more-123" class="more-link">Continue <span>&rarr;</span></a></p>\n`
    expect(endsWithJumpLink(wordpress, 'https://example.com/2026/10/x/')).toBe(true)
  })

  test('a link to its own page labelled "read more" or with an elision', () => {
    const kexue = 'https://kexue.fm/archives/11928'
    const elision = `<p>$f(x)$</p><p class="more"><a href="${kexue}" title="排序不等式">[...]</a></p>`
    expect(endsWithJumpLink(elision, kexue)).toBe(true)
    const smitten = 'https://smittenkitchen.com/2026/09/simple-chicken-tacos/'
    const theme = `<p>getting started.</p>\n<p><a class="more-link" href="${smitten}">Read more <span>&raquo;</span></a></p>`
    expect(endsWithJumpLink(theme, smitten)).toBe(true)
  })

  test('a permalink, a link elsewhere, or a jump link mid-post is not one', () => {
    // Daring Fireball's full posts end with their permalink: no fragment, no "read more".
    expect(
      endsWithJumpLink(
        `<p>A full post.</p><p><a href="${post}" title="Permanent link">★</a></p>`,
        post,
      ),
    ).toBe(false)
    expect(
      endsWithJumpLink(`<p>See <a href="https://other.example/a.html#more">that</a></p>`, post),
    ).toBe(false)
    expect(
      endsWithJumpLink(`<p><a href="${post}#more">jump</a></p><p>And the rest of it.</p>`, post),
    ).toBe(false)
    expect(endsWithJumpLink(`<a href="${post}#more">x</a>`, null)).toBe(false)
  })
})

describe('wantsExtraction', () => {
  test('summary feeds, and short bodies from feeds too small to classify', () => {
    const base = { extractedFrom: 'feed' as const, extractCheckedAt: null }
    expect(wantsExtraction({ ...base, contentMode: 'summary', bodyChars: 5000 })).toBe(true)
    expect(wantsExtraction({ ...base, contentMode: 'unknown', bodyChars: 300 })).toBe(true)
    expect(wantsExtraction({ ...base, contentMode: 'unknown', bodyChars: 2000 })).toBe(false)
    expect(wantsExtraction({ ...base, contentMode: 'full', bodyChars: 300 })).toBe(false)
  })

  test('never twice, and never for content that already came from the page', () => {
    expect(
      wantsExtraction({
        contentMode: 'summary',
        extractedFrom: 'feed',
        extractCheckedAt: new Date(),
        bodyChars: 100,
      }),
    ).toBe(false)
    expect(
      wantsExtraction({
        contentMode: 'summary',
        extractedFrom: 'readability',
        extractCheckedAt: null,
        bodyChars: 100,
      }),
    ).toBe(false)
  })
})
