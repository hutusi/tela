import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createMockTranslator } from './mock'
import { createSdkTranslator } from './translator'
import type { Translator } from './types'

export type ProviderName = 'bailian' | 'anthropic' | 'mock'

export type ProviderConfig = {
  provider: ProviderName
  model: string
  baseURL?: string
  apiKey?: string
  jsonMode?: 'schema' | 'text'
  /** Extra JSON fields merged into every chat request body (e.g. Bailian's enable_thinking). */
  extraBody?: Record<string, unknown>
}

/** Aliyun Bailian (Model Studio), OpenAI-compatible endpoint. Also the international host. */
export const BAILIAN_DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
export const BAILIAN_DEFAULT_MODEL = 'glm-5.2'
export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5'

/** Wrap fetch so extra fields land in the JSON body of chat completion requests. */
function fetchWithExtraBody(extra: Record<string, unknown>): typeof fetch {
  const wrapped = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (init?.body && typeof init.body === 'string') {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>
        return fetch(input, { ...init, body: JSON.stringify({ ...body, ...extra }) })
      } catch {
        // not JSON; send unchanged
      }
    }
    return fetch(input, init)
  }
  return wrapped as unknown as typeof fetch
}

export function createTranslator(config: ProviderConfig): Translator {
  switch (config.provider) {
    case 'mock':
      return createMockTranslator({ model: config.model || 'mock' })
    case 'bailian': {
      if (!config.apiKey) throw new Error('BAILIAN_API_KEY is required for the bailian provider')
      const extra = config.extraBody ?? { enable_thinking: false }
      const provider = createOpenAICompatible({
        name: 'bailian',
        baseURL: config.baseURL ?? BAILIAN_DEFAULT_BASE_URL,
        apiKey: config.apiKey,
        fetch: fetchWithExtraBody(extra),
        supportsStructuredOutputs: config.jsonMode === 'schema',
      })
      return createSdkTranslator(provider.chatModel(config.model), {
        modelName: `bailian/${config.model}`,
        jsonMode: config.jsonMode ?? 'text',
      })
    }
    case 'anthropic': {
      if (!config.apiKey)
        throw new Error('ANTHROPIC_API_KEY is required for the anthropic provider')
      const provider = createAnthropic({
        apiKey: config.apiKey,
        ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      })
      return createSdkTranslator(provider(config.model), {
        modelName: `anthropic/${config.model}`,
        jsonMode: config.jsonMode ?? 'schema',
      })
    }
  }
}

/**
 * Provider config from the environment. LLM_PROVIDER selects the backend (default bailian);
 * unset keys fall back to the mock so local runs and tests never call a paid API by accident.
 */
export function configFromEnv(
  env: Record<string, string | undefined> = process.env,
): ProviderConfig {
  const provider = (env.LLM_PROVIDER ?? 'bailian') as ProviderName
  const jsonMode =
    env.LLM_JSON_MODE === 'schema' ? 'schema' : env.LLM_JSON_MODE === 'text' ? 'text' : undefined
  if (provider === 'anthropic') {
    if (!env.ANTHROPIC_API_KEY) return { provider: 'mock', model: 'mock' }
    return {
      provider,
      model: env.LLM_MODEL ?? ANTHROPIC_DEFAULT_MODEL,
      apiKey: env.ANTHROPIC_API_KEY,
      ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}),
      ...(jsonMode ? { jsonMode } : {}),
    }
  }
  if (provider === 'bailian') {
    if (!env.BAILIAN_API_KEY) return { provider: 'mock', model: 'mock' }
    return {
      provider,
      model: env.LLM_MODEL ?? BAILIAN_DEFAULT_MODEL,
      apiKey: env.BAILIAN_API_KEY,
      baseURL: env.BAILIAN_BASE_URL ?? BAILIAN_DEFAULT_BASE_URL,
      ...(jsonMode ? { jsonMode } : {}),
    }
  }
  return { provider: 'mock', model: env.LLM_MODEL ?? 'mock' }
}
