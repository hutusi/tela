# 0006 — Translation: eager titles, lazy bodies, one provider adapter (Bailian GLM first)

Status: accepted (2026-09-04)

## Context

Translation is the product's core promise and its main variable cost. Translating every post
into every language would be unbounded; translating nothing until asked makes lists unreadable.
The owner wants the model provider to be configurable, starting with Aliyun Bailian (Model
Studio) serving GLM, with Claude available later. Bailian exposes an OpenAI-compatible endpoint.

## Decision

- **Targets** are the reading languages the product offers (`READING_LANGUAGES` in
  `@tela/shared`: `zh-Hans`, `en`), never "every language a subscriber speaks".
- **Eager**: after each fetch the worker queues `translate.title` for every new or changed article
  into each target that differs from the source. Titles and excerpts are what lists show, and
  they cost a few hundred tokens.
- **Lazy**: bodies are translated on first open. The web app upserts
  `article_translations(status='requested')` and sends `translate.body` at priority 10; the reader
  polls until `done`/`partial`/`failed`. Cache hits skip the model entirely.
- **Unit of work**: consecutive translatable blocks up to ~3k estimated source tokens per call,
  with the previous chunk's last two translations as context. Every block is validated
  (placeholder multiset, length ratio, non-identity); failures are retried once in strict mode,
  then recorded in `failed_block_ids` and rendered as source (`partial`).
- **Cache**: `translations(source_hash, target_lang, source_lang)` keyed by the tagged-text hash
  and the article's source language (`und` when undetected: the same short text can mean
  different things in different languages); the
  materialized `article_translations.html` is rebuilt from the cache and goes stale when
  `content_hash` changes.
- **Adapter**: `packages/llm` exposes a `Translator` interface. Providers: Bailian through
  `@ai-sdk/openai-compatible` (custom `fetch` injects `enable_thinking: false`; JSON asked for in
  the prompt and parsed, since structured-output support varies), Anthropic through
  `@ai-sdk/anthropic` (structured output), and a deterministic mock used by tests and any
  environment without keys. `LLM_PROVIDER`, `LLM_MODEL`, and the keys select the backend; the
  model label is stored on every cache row and usage row.
- **Cost control**: one `llm_usage` row per call; `LLM_DAILY_BUDGET_TOKENS` pauses background
  (priority < 10) work while on-demand requests continue; sites can opt out of translation.

## Consequences

- Retranslation after an edit costs only the changed blocks; a language switch by one reader
  benefits everyone else who reads that post in that language.
- Prompt-injected content cannot reach the page: model output is re-escaped and only known
  placeholders become markup.
- Provider quality is comparable per row via the `model` column; switching providers is an
  environment change.
