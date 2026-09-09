import { describe, expect, test } from 'bun:test'
import { MockLanguageModelV4 } from 'ai/test'
import { chunkBlocks, estimateTokens } from './chunk'
import { createMockTranslator } from './mock'
import { buildUserPayload } from './prompt'
import { configFromEnv, isAccidentalMock } from './providers'
import { type TranslateBlocksInput, translateBlocks } from './translate'
import { createSdkTranslator, parseJsonReply, parseTranslations } from './translator'
import type { TranslationRequest } from './types'
import { validateTranslation } from './validate'

describe('chunking', () => {
  test('estimates CJK as one token per character and Latin as four characters per token', () => {
    expect(estimateTokens('中文四个字')).toBe(5)
    expect(estimateTokens('twelve chars')).toBe(3)
  })

  test('groups consecutive blocks and never splits an oversized block', () => {
    const blocks = [
      { id: 'a', text: 'x'.repeat(400) }, // 100 tokens
      { id: 'b', text: 'x'.repeat(400) },
      { id: 'c', text: 'x'.repeat(2000) }, // 500 tokens, alone
      { id: 'd', text: 'short' },
    ]
    expect(chunkBlocks(blocks, 250).map((c) => c.map((b) => b.id))).toEqual([
      ['a', 'b'],
      ['c'],
      ['d'],
    ])
  })
})

describe('validateTranslation', () => {
  const src = 'Click <g1>here</g1> to read the <x1/> documentation, please.'
  test('accepts a faithful translation', () => {
    expect(validateTranslation(src, '点击<g1>这里</g1>阅读 <x1/> 文档。').ok).toBe(true)
  })
  test('rejects lost placeholders, empties, wild lengths, and echoes', () => {
    expect(validateTranslation(src, '点击这里阅读文档。')).toMatchObject({ ok: false })
    expect(validateTranslation(src, '<g1></g1><x1/>')).toMatchObject({
      ok: false,
      reason: 'empty translation',
    })
    expect(validateTranslation(src, `<g1>x</g1><x1/>${'很'.repeat(500)}`)).toMatchObject({
      ok: false,
    })
    expect(validateTranslation(src, src)).toMatchObject({
      ok: false,
      reason: 'identical to source',
    })
  })
  test('short blocks may stay identical (names, labels)', () => {
    expect(validateTranslation('GitHub', 'GitHub').ok).toBe(true)
  })
  test('allowIdentical accepts an echo, for titles that are their own translation', () => {
    // Both are just past SHORT_BLOCK, so the echo check applies and used to reject them: a
    // package name plus a version, and a pair of map projections.
    const pkg = 'llm-openrouter 0.7.1'
    const projections = 'Mercator to Equal Earth'
    expect(validateTranslation(pkg, pkg)).toMatchObject({ reason: 'identical to source' })
    expect(validateTranslation(pkg, pkg, { allowIdentical: true }).ok).toBe(true)
    expect(validateTranslation(projections, projections, { allowIdentical: true }).ok).toBe(true)
    // It relaxes only that rule; a mangled translation is still refused.
    expect(validateTranslation(projections, '', { allowIdentical: true })).toMatchObject({
      ok: false,
      reason: 'empty translation',
    })
  })
})

describe('parseJsonReply', () => {
  test('handles fences and surrounding prose', () => {
    expect(parseJsonReply('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(parseJsonReply('Here you go: {"a":[1,2]} hope it helps')).toEqual({ a: [1, 2] })
    expect(() => parseJsonReply('no json here')).toThrow()
  })
})

describe('parseTranslations', () => {
  test('parses a valid reply as before', () => {
    const reply = '{"translations":[{"id":"a","text":"你好"},{"id":"b","text":"再见"}]}'
    expect(parseTranslations(reply, ['a', 'b'])).toEqual([
      { id: 'a', text: '你好' },
      { id: 'b', text: '再见' },
    ])
  })

  test('recovers entries whose text carries unescaped quotes, keeping real escapes', () => {
    // What GLM returned for a Japanese title with 「」 quotes: straight quotes copied raw.
    const reply =
      '```json\n{"translations":[{"id":"t","text":"《书评》"上手的传达方式"教科书\\n第二行"},{"id":"u","text":"plain"}]}\n```'
    expect(parseTranslations(reply, ['t', 'u'])).toEqual([
      { id: 't', text: '《书评》"上手的传达方式"教科书\n第二行' },
      { id: 'u', text: 'plain' },
    ])
  })

  test('still throws when nothing can be recovered', () => {
    expect(() => parseTranslations('Sorry, I cannot help with that.', ['a'])).toThrow()
  })
})

describe('translateBlocks with the mock translator', () => {
  const blocks = [
    { id: 'b1', text: 'On Calle de Toledo there is a <g1>bakery</g1> open since 1928.' },
    { id: 'b2', text: 'The bread has not changed at all in a century.' },
    { id: 'b3', text: 'See <x1/> for the recipe and the history.' },
  ]

  test('translates every block and records usage', async () => {
    const calls: Parameters<ReturnType<typeof createMockTranslator>['translate']>[0][] = []
    const out = await translateBlocks(createMockTranslator({ calls }), {
      blocks,
      sourceLang: 'en',
      targetLang: 'zh-Hans',
      context: { title: 'The bakery' },
    })
    expect(out.failed).toEqual([])
    expect(out.translated.get('b1')).toBe(
      'zh-Hans:On Calle de Toledo there is a <g1>zh-Hans:bakery</g1>zh-Hans: open since 1928.',
    )
    expect(out.translated.get('b3')).toBe(
      'zh-Hans:See <x1/>zh-Hans: for the recipe and the history.',
    )
    expect(out.usage).toHaveLength(1)
    expect(calls[0]?.context?.title).toBe('The bakery')
    expect(calls[0]?.strict).toBe(false)
  })

  test('retries invalid blocks once in strict mode and reports the rest', async () => {
    const calls: Parameters<ReturnType<typeof createMockTranslator>['translate']>[0][] = []
    const out = await translateBlocks(
      createMockTranslator({ calls, failIds: new Set(['b1']), dropIds: new Set(['b2']) }),
      {
        blocks,
        sourceLang: 'en',
        targetLang: 'zh-Hans',
      },
    )
    expect(out.translated.has('b3')).toBe(true)
    expect(out.failed.map((f) => f.id).sort()).toEqual(['b1', 'b2'])
    expect(calls).toHaveLength(2)
    expect(calls[1]?.strict).toBe(true)
    expect(calls[1]?.blocks.map((b) => b.id).sort()).toEqual(['b1', 'b2'])
  })

  test('carries previous translations into the next chunk as context', async () => {
    const calls: Parameters<ReturnType<typeof createMockTranslator>['translate']>[0][] = []
    const out = await translateBlocks(createMockTranslator({ calls }), {
      blocks,
      sourceLang: 'en',
      targetLang: 'zh-Hans',
      maxTokensPerChunk: 20,
    })
    expect(out.failed).toEqual([])
    expect(calls.length).toBeGreaterThan(1)
    expect(calls[1]?.context?.previous?.length).toBeGreaterThan(0)
  })

  test('stops at the source-token ceiling and never sends the rest', async () => {
    const calls: Parameters<ReturnType<typeof createMockTranslator>['translate']>[0][] = []
    const out = await translateBlocks(createMockTranslator({ calls }), {
      blocks,
      sourceLang: 'en',
      targetLang: 'zh-Hans',
      maxSourceTokens: 20,
    })
    expect([...out.translated.keys()]).toEqual(['b1'])
    expect(out.failed).toEqual([
      { id: 'b2', reason: 'article too long' },
      { id: 'b3', reason: 'article too long' },
    ])
    // One call, and no strict retry for the blocks that were never sent.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.blocks.map((b) => b.id)).toEqual(['b1'])
  })

  test('reports every successful call through onChunk as it lands', async () => {
    const calls: Parameters<ReturnType<typeof createMockTranslator>['translate']>[0][] = []
    const chunks: Array<{ ids: string[]; inputTokens: number }> = []
    const out = await translateBlocks(createMockTranslator({ calls }), {
      blocks,
      sourceLang: 'en',
      targetLang: 'zh-Hans',
      maxTokensPerChunk: 20,
      onChunk: async ({ translated, usage }) => {
        chunks.push({ ids: [...translated.keys()], inputTokens: usage.inputTokens })
      },
    })
    expect(out.failed).toEqual([])
    expect(chunks).toHaveLength(calls.length)
    expect(chunks.flatMap((c) => c.ids).sort()).toEqual(['b1', 'b2', 'b3'])
    expect(chunks.every((c) => c.inputTokens > 0)).toBe(true)
  })

  test('throws when the provider fails for every chunk', async () => {
    await expect(
      translateBlocks(createMockTranslator({ fail: true }), {
        blocks,
        sourceLang: 'en',
        targetLang: 'zh-Hans',
      }),
    ).rejects.toThrow(/mock provider failure/)
  })
})

describe('translateBlocks deadline', () => {
  test('stops starting provider calls once the deadline has passed, and says so', async () => {
    const calls: TranslationRequest[] = []
    const inner = createMockTranslator({ calls })
    const input: TranslateBlocksInput = {
      blocks: [
        { id: 'a', text: 'x'.repeat(400) },
        { id: 'b', text: 'y'.repeat(400) },
      ],
      sourceLang: 'en',
      targetLang: 'zh-Hans',
      maxTokensPerChunk: 100,
      deadline: Date.now() + 60_000,
    }
    const translator = {
      model: inner.model,
      translate: async (req: TranslationRequest) => {
        // Time runs out while the first chunk is in flight.
        input.deadline = Date.now() - 1
        return inner.translate(req)
      },
    }
    const out = await translateBlocks(translator, input)
    expect(calls.map((c) => c.blocks.map((b) => b.id))).toEqual([['a']])
    expect(out.stopped).toBe(true)
    expect([...out.translated.keys()]).toEqual(['a'])
    expect(out.failed).toEqual([])
    // Without a deadline the run is never stopped.
    const { deadline: _deadline, ...noDeadline } = input
    expect((await translateBlocks(inner, noDeadline)).stopped).toBe(false)
  })
})

describe('configFromEnv', () => {
  test('falls back to the mock without keys and honors overrides', () => {
    expect(configFromEnv({})).toEqual({ provider: 'mock', model: 'mock' })
    expect(isAccidentalMock(configFromEnv({}), {})).toBe(true)
    expect(
      isAccidentalMock(configFromEnv({ LLM_PROVIDER: 'mock' }), { LLM_PROVIDER: 'mock' }),
    ).toBe(false)
    // The mock never borrows a real model's name, so its cache rows stay recognizable.
    expect(configFromEnv({ LLM_PROVIDER: 'mock', LLM_MODEL: 'glm-5.2' })).toEqual({
      provider: 'mock',
      model: 'mock',
    })
    expect(configFromEnv({ LLM_PROVIDER: 'bailian', LLM_MODEL: 'glm-5.2' })).toEqual({
      provider: 'mock',
      model: 'mock',
    })
    expect(() => configFromEnv({ LLM_PROVIDER: 'bailain', BAILIAN_API_KEY: 'k' })).toThrow(
      /Unknown LLM_PROVIDER "bailain"/,
    )
    expect(configFromEnv({ LLM_PROVIDER: 'bailian', BAILIAN_API_KEY: 'k' })).toMatchObject({
      provider: 'bailian',
      model: 'glm-5.2',
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    })
    expect(
      configFromEnv({
        LLM_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: 'k',
        LLM_MODEL: 'claude-sonnet-5',
      }),
    ).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    })
  })
})

describe('buildUserPayload', () => {
  test('clips context strings so a feed cannot grow every prompt', () => {
    const payload = JSON.parse(
      buildUserPayload({
        sourceLang: 'en',
        targetLang: 'zh-Hans',
        blocks: [{ id: 'b1', text: 'Hello' }],
        context: {
          title: 'T'.repeat(5000),
          siteTitle: 'S'.repeat(5000),
          previous: [{ source: 'p'.repeat(5000), target: 'q'.repeat(5000) }],
        },
      }),
    ) as {
      context: { title: string; site: string; previous: Array<{ source: string; target: string }> }
    }
    expect(payload.context.title).toHaveLength(201)
    expect(payload.context.site).toHaveLength(201)
    expect(payload.context.previous[0]?.source).toHaveLength(401)
    expect(payload.context.previous[0]?.target).toHaveLength(401)
  })
})

describe('createSdkTranslator', () => {
  test('a provider call that never answers is abandoned at the deadline', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: (options) =>
        new Promise((_, reject) => {
          options.abortSignal?.addEventListener('abort', () => reject(options.abortSignal?.reason))
        }),
    })
    const translator = createSdkTranslator(model, { modelName: 'never', timeoutMs: 50 })
    await expect(
      translator.translate({
        sourceLang: 'en',
        targetLang: 'zh-Hans',
        blocks: [{ id: 'a', text: 'hi' }],
        context: { previous: [] },
        strict: false,
      }),
    ).rejects.toThrow()
  })
})
