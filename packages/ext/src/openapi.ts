/**
 * The v1 API as an OpenAPI 3.1 document, generated from the formats in `./schema` (ADR 0065):
 * committed as `docs/api/openapi.json` (`bun run api:openapi`, held to it by a drift test) and
 * served at `api.telaread.com/v1/openapi.json`. The route table below is where each route's
 * method, scope, inputs, answer and refusals are written down; a route tela-api serves and this
 * table does not name is not part of v1.
 */
import { API_VERSIONS } from '@tela/shared'
import { z } from 'zod'
import {
  addFeedRequestSchema,
  addFeedSchema,
  articlePageSchema,
  blogrollPageSchema,
  bodiesQuerySchema,
  bodiesSchema,
  contentObjectSchema,
  discoverBlogrollsSchema,
  discoverBlogsSchema,
  discoverFeedsRequestSchema,
  discoverFeedsSchema,
  discoverPostsSchema,
  discoverReadersSchema,
  errorSchema,
  importFeedsSchema,
  limitErrorSchema,
  meSchema,
  metaSchema,
  mutationSchema,
  OPEN_ENUM,
  prefRowDocSchema,
  profilePageSchema,
  publicQuerySchema,
  pushSchema,
  searchQuerySchema,
  searchSchema,
  sitePageSchema,
  syncQuerySchema,
  syncSchema,
  translationAnswerSchema,
  translationChunkSchema,
  translationObjectSchema,
  translationRequestSchema,
  translationStatusSchema,
  usageSchema,
} from './schema'

/**
 * The version this document describes: v1, whichever version is current. A v2 gets a document of
 * its own, and this one keeps saying 1, with v1's status.
 */
const DOCUMENTED_VERSION = 1

/** Production's addresses: the document describes the API as apps reach it. */
const API_ORIGIN = 'https://api.telaread.com'
const CONSENT_PAGE = 'https://telaread.com/connect'

type Status = 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 503

type Param = { name: string; schema: z.ZodType; description: string }

type Route = {
  method: 'get' | 'post'
  /** As OpenAPI templates it: `{name}` for a path parameter. */
  path: string
  summary: string
  /** `null`: no token. Every other route takes a bearer access token with at least this scope. */
  scope: 'read' | 'write' | null
  params?: Param[]
  query?: z.ZodObject
  body?: { schema: z.ZodType; contentType: string; name: string }
  /** The 200 answer, by name in `components.schemas`; a binary answer gives a media type. */
  answer: { name: string; schema: z.ZodType } | { media: string; description: string }
  /**
   * Refusals this route gives besides those every token route gives (401, 403, 429, 503) and the
   * 400 every route with a query or a body gives.
   */
  errors?: Status[]
  /** How long a cache may keep the 200 answer, as the route's `Cache-Control` says. */
  cache?: string
}

const contentKey = z.string().regex(/^[0-9a-f]{32}$/)
const PUBLIC_CACHE =
  'Viewer-independent: `public, max-age=300` when `lang` is named; `private, no-store` without it'

/** The push as the docs show it: each mutation one of the 17 kinds (`mutationSchema`). */
const pushRequestDoc = z.object({ mutations: z.array(mutationSchema).max(50) })

/** Sync as the docs show it: a pref row may name a key this version does not, to be ignored. */
const syncDoc = syncSchema.extend({
  rows: syncSchema.shape.rows.extend({ prefs: z.array(prefRowDocSchema) }),
})

const ROUTES: Route[] = [
  {
    method: 'get',
    path: '/meta',
    summary: 'Versions, features, limits and the OAuth metadata link',
    scope: null,
    answer: { name: 'Meta', schema: metaSchema },
    cache: 'public, max-age=300',
  },
  {
    method: 'get',
    path: '/v1/openapi.json',
    summary: 'This document',
    scope: null,
    answer: { media: 'application/json', description: 'The OpenAPI 3.1 document' },
    cache: 'public, max-age=300',
  },
  {
    method: 'get',
    path: '/v1/me',
    summary: 'Who the token acts for, and its scope; the address only with that permission',
    scope: 'read',
    answer: { name: 'Me', schema: meSchema },
  },
  {
    method: 'get',
    path: '/v1/usage',
    summary: 'The member’s daily limits and what is left of them, and this app’s rate limits',
    scope: 'read',
    answer: { name: 'Usage', schema: usageSchema },
  },
  {
    method: 'get',
    path: '/v1/sync',
    summary: 'A snapshot, then deltas: the member’s rows after the cursor',
    scope: 'read',
    query: syncQuerySchema,
    answer: { name: 'Sync', schema: syncDoc },
    errors: [400],
  },
  {
    method: 'post',
    path: '/v1/mutations',
    summary: 'Apply changes made offline, one answer each, in order',
    scope: 'write',
    body: { schema: pushRequestDoc, contentType: 'application/json', name: 'PushRequest' },
    answer: { name: 'Push', schema: pushSchema },
    errors: [400, 413],
  },
  {
    method: 'get',
    path: '/v1/bodies',
    summary: 'Content objects by key, a bundle at a time, with the keys refused for today’s limit',
    scope: 'read',
    query: bodiesQuerySchema,
    answer: { name: 'Bodies', schema: bodiesSchema },
    errors: [400],
  },
  {
    method: 'get',
    path: '/o/c/{key}.json',
    summary: 'A post’s body: an immutable content object',
    scope: 'read',
    params: [{ name: 'key', schema: contentKey, description: 'The content key' }],
    answer: { name: 'ContentObject', schema: contentObjectSchema },
    errors: [404],
    cache: 'private, max-age=31536000, immutable',
  },
  {
    method: 'get',
    path: '/o/t/{key}/{lang}/{version}.json',
    summary: 'A finished translation, as a translation row’s `object` names it',
    scope: 'read',
    params: [
      { name: 'key', schema: contentKey, description: 'The content key' },
      { name: 'lang', schema: z.string(), description: 'The reading language' },
      { name: 'version', schema: z.string(), description: 'As the row names it' },
    ],
    answer: { name: 'TranslationObject', schema: translationObjectSchema },
    errors: [404],
    cache: 'private, max-age=31536000, immutable',
  },
  {
    method: 'get',
    path: '/o/tc/{key}/{lang}/{request}/{n}.json',
    summary: 'A chunk of a translation still running, as a translation row’s `chunks` name it',
    scope: 'read',
    params: [
      { name: 'key', schema: contentKey, description: 'The content key' },
      { name: 'lang', schema: z.string(), description: 'The reading language' },
      { name: 'request', schema: z.string(), description: 'As the row names it' },
      { name: 'n', schema: z.string(), description: 'The chunk’s number' },
    ],
    answer: { name: 'TranslationChunk', schema: translationChunkSchema },
    errors: [404],
    cache: 'private, max-age=31536000, immutable',
  },
  {
    method: 'get',
    path: '/img/{key}/{index}',
    summary: 'An image a body names, at the index of its content object’s `images`',
    scope: 'read',
    params: [
      { name: 'key', schema: contentKey, description: 'The content key' },
      { name: 'index', schema: z.string(), description: 'Its index in `images`' },
    ],
    answer: { media: 'image/*', description: 'The image' },
    errors: [404],
  },
  {
    method: 'post',
    path: '/v1/translations',
    summary: 'Ask for a post’s body in a reading language',
    scope: 'write',
    body: {
      schema: translationRequestSchema,
      contentType: 'application/json',
      name: 'TranslationRequest',
    },
    answer: { name: 'TranslationAnswer', schema: translationAnswerSchema },
    errors: [400, 404],
  },
  {
    method: 'get',
    path: '/v1/translations/{contentKey}/{lang}',
    summary: 'What exists of a body translation now, polled while it runs',
    scope: 'read',
    params: [
      { name: 'contentKey', schema: contentKey, description: 'The content key' },
      { name: 'lang', schema: z.string(), description: 'A reading language' },
    ],
    answer: { name: 'TranslationStatus', schema: translationStatusSchema },
    errors: [400],
  },
  {
    method: 'post',
    path: '/v1/feeds/discover',
    summary: 'The feeds a URL offers, and which of them Tela has',
    scope: 'write',
    body: {
      schema: discoverFeedsRequestSchema,
      contentType: 'application/json',
      name: 'DiscoverFeedsRequest',
    },
    answer: { name: 'DiscoverFeeds', schema: discoverFeedsSchema },
    errors: [400, 422],
  },
  {
    method: 'post',
    path: '/v1/feeds',
    summary: 'Add a feed by URL and subscribe the member to it',
    scope: 'write',
    body: { schema: addFeedRequestSchema, contentType: 'application/json', name: 'AddFeedRequest' },
    answer: { name: 'AddFeed', schema: addFeedSchema },
    errors: [400, 409, 422],
  },
  {
    method: 'post',
    path: '/v1/feeds/opml',
    summary: 'Import an OPML document’s feeds, within the day’s and the subscription limits',
    scope: 'write',
    body: { schema: z.string(), contentType: 'text/x-opml', name: 'Opml' },
    answer: { name: 'ImportFeeds', schema: importFeedsSchema },
    errors: [400, 413],
  },
  ...(
    [
      [
        'week',
        'This week: the week’s most recommended posts, then the newest',
        discoverPostsSchema,
      ],
      ['articles', 'Every public post, newest first', discoverPostsSchema],
      ['blogs', 'Public blogs, featured first', discoverBlogsSchema],
      ['blogrolls', 'Public blogrolls, the newest made public first', discoverBlogrollsSchema],
      ['readers', 'Members to follow', discoverReadersSchema],
    ] as const
  ).map(
    ([tab, summary, schema]): Route => ({
      method: 'get',
      path: `/v1/discover/${tab}`,
      summary,
      scope: 'read',
      query: publicQuerySchema,
      answer: {
        name: `Discover${tab.charAt(0).toUpperCase()}${tab.slice(1)}`,
        schema,
      },
      cache: PUBLIC_CACHE,
    }),
  ),
  {
    method: 'get',
    path: '/v1/sites/{id}',
    summary: 'A public blog: its card, feeds and a page of its posts',
    scope: 'read',
    params: [{ name: 'id', schema: z.number().int(), description: 'The blog’s id' }],
    query: publicQuerySchema.pick({ page: true, lang: true }),
    answer: { name: 'SitePage', schema: sitePageSchema },
    errors: [400, 404],
    cache: PUBLIC_CACHE,
  },
  {
    method: 'get',
    path: '/v1/profiles/{handle}',
    summary: 'A member’s public profile, as far as they show it',
    scope: 'read',
    params: [{ name: 'handle', schema: z.string(), description: 'The member’s handle' }],
    query: publicQuerySchema.pick({ page: true, lang: true }),
    answer: { name: 'ProfilePage', schema: profilePageSchema },
    errors: [404],
    cache: PUBLIC_CACHE,
  },
  {
    method: 'get',
    path: '/v1/blogrolls/{id}',
    summary: 'A public blogroll and its blogs',
    scope: 'read',
    params: [{ name: 'id', schema: z.string(), description: 'The blogroll’s id' }],
    query: publicQuerySchema.pick({ lang: true }),
    answer: { name: 'BlogrollPage', schema: blogrollPageSchema },
    errors: [404],
    cache: PUBLIC_CACHE,
  },
  {
    method: 'get',
    path: '/v1/search',
    summary: 'Posts of the member’s feeds by title in either language, and blogs',
    scope: 'read',
    query: searchQuerySchema,
    answer: { name: 'Search', schema: searchSchema },
    errors: [400],
    cache: 'private, no-store',
  },
  {
    method: 'get',
    path: '/v1/articles/{id}',
    summary: 'A post by id, as a synced one, to open from a public page',
    scope: 'read',
    params: [{ name: 'id', schema: z.number().int(), description: 'The post’s id' }],
    answer: { name: 'ArticlePage', schema: articlePageSchema },
    errors: [400, 404],
    cache: 'private, no-store',
  },
]

/** The JSON Schema (2020-12, as OpenAPI 3.1 takes it) of a zod schema, without its `$schema`. */
function jsonSchema(schema: z.ZodType, io: 'input' | 'output'): Record<string, unknown> {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io,
    unrepresentable: 'any',
  }) as Record<string, unknown>
  return open(rest) as Record<string, unknown>
}

/**
 * A schema as open as v1 is: v1 grows by addition, and an app ignores what it does not know, so no
 * generated client may refuse an answer for it. The contract suite holds tela-api to the exact
 * fields and values.
 *
 * - No `additionalProperties: false`, which zod writes for every object it outputs: an answer may
 *   carry a field added later.
 * - An open enum (`OPEN_ENUM`) is a string with its known values under `x-extensible-enum`, not a
 *   closed `enum`: an answer may carry a value added later.
 */
function open(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(open)
  if (value === null || typeof value !== 'object') return value
  const node = value as Record<string, unknown>
  const extensible = node[OPEN_ENUM] === true && Array.isArray(node.enum)
  return Object.fromEntries(
    Object.entries(node)
      .filter(([k, v]) => !(k === 'additionalProperties' && v === false) && k !== OPEN_ENUM)
      .map(([k, v]): [string, unknown] =>
        extensible && k === 'enum' ? ['x-extensible-enum', v] : [k, open(v)],
      ),
  )
}

const retryAfter = {
  'Retry-After': {
    description: 'Seconds to wait before trying again',
    schema: { type: 'integer', minimum: 1 },
  },
}
const challenge = {
  'WWW-Authenticate': {
    description: 'An RFC 6750 challenge naming the error, and the scope needed',
    schema: { type: 'string' },
  },
}
const errorRef = { $ref: '#/components/schemas/Error' }
const json = (schema: unknown) => ({ 'application/json': { schema } })

/** Each refusal: what it means, which `error` codes it carries, and its headers. */
const ERRORS: Record<Status, Record<string, unknown>> = {
  400: {
    description: '`invalid_request`, `invalid_url`, `opml_invalid`',
    content: json(errorRef),
  },
  401: {
    description: '`invalid_token`: none, unknown, expired or ended. Refresh it, or connect again',
    headers: challenge,
    content: json(errorRef),
  },
  403: {
    description:
      '`app_suspended`: the operator cut this app off for now; keep the tokens, they work again once it is restored',
    headers: challenge,
    content: json(errorRef),
  },
  404: { description: '`not_found`', content: json(errorRef) },
  409: {
    description: '`subscription_limit`, with the member’s `limit`',
    content: json(errorRef),
  },
  413: { description: '`too_large`: the body is over the route’s limit', content: json(errorRef) },
  422: {
    description: '`unreachable`, `not_a_feed`, `feed_too_large`: Tela could not take that feed',
    content: json(errorRef),
  },
  429: {
    description:
      '`rate_limited` (this app’s or the member’s rate), `feed_limit` or `post_limit` (a daily limit, with `limit` and `resetsAt`)',
    headers: retryAfter,
    content: json({ oneOf: [errorRef, { $ref: '#/components/schemas/LimitError' }] }),
  },
  503: {
    description: '`apps_paused` (the operator stopped every app) or `unavailable`',
    headers: retryAfter,
    content: json(errorRef),
  },
}

function operation(route: Route, schemas: Record<string, unknown>) {
  const parameters: Record<string, unknown>[] = (route.params ?? []).map((p) => ({
    name: p.name,
    in: 'path',
    required: true,
    description: p.description,
    schema: jsonSchema(p.schema, 'input'),
  }))
  if (route.query) {
    const query = jsonSchema(route.query, 'input') as {
      properties?: Record<string, Record<string, unknown>>
      required?: string[]
    }
    for (const [name, schema] of Object.entries(query.properties ?? {})) {
      const { description, ...rest } = schema
      parameters.push({
        name,
        in: 'query',
        required: (query.required ?? []).includes(name),
        ...(description ? { description } : {}),
        schema: rest,
      })
    }
  }
  let ok: Record<string, unknown>
  if ('name' in route.answer) {
    schemas[route.answer.name] = jsonSchema(route.answer.schema, 'output')
    ok = { description: 'OK', content: json({ $ref: `#/components/schemas/${route.answer.name}` }) }
  } else {
    ok = { description: route.answer.description, content: { [route.answer.media]: {} } }
  }
  if (route.cache) {
    ok.headers = {
      'Cache-Control': { description: route.cache, schema: { type: 'string' } },
    }
  }
  const statuses = new Set<Status>(route.errors ?? [])
  // A route that reads a query or a body refuses one it cannot take.
  if (route.query || route.body) statuses.add(400)
  // Any token can be refused, its app cut off, limited, or every app paused.
  if (route.scope !== null) for (const s of [401, 403, 429, 503] as const) statuses.add(s)
  const responses: Record<string, unknown> = { 200: ok }
  for (const status of [...statuses].sort((a, b) => a - b)) responses[status] = ERRORS[status]
  if (route.scope === 'write') {
    responses[403] = {
      ...ERRORS[403],
      description:
        '`insufficient_scope`: the token’s scope does not cover this route (`write`); or `app_suspended`: the operator cut this app off for now, keep the tokens',
    }
  }
  let requestBody: Record<string, unknown> | undefined
  if (route.body) {
    schemas[route.body.name] = jsonSchema(route.body.schema, 'input')
    requestBody = {
      required: true,
      content: {
        [route.body.contentType]: { schema: { $ref: `#/components/schemas/${route.body.name}` } },
      },
    }
  }
  return {
    summary: route.summary,
    ...(route.scope === null
      ? { security: [] }
      : { security: [{ tela: route.scope === 'write' ? ['write'] : ['read'] }] }),
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(requestBody ? { requestBody } : {}),
    responses,
  }
}

/** The document, the same on every call. */
export function openapiDocument(): Record<string, unknown> {
  const schemas: Record<string, unknown> = {
    Error: jsonSchema(errorSchema, 'output'),
    LimitError: jsonSchema(limitErrorSchema, 'output'),
  }
  const paths: Record<string, Record<string, unknown>> = {}
  for (const route of ROUTES) {
    const path = paths[route.path] ?? {}
    path[route.method] = operation(route, schemas)
    paths[route.path] = path
  }
  const documented = API_VERSIONS.find((v) => v.version === DOCUMENTED_VERSION)
  return {
    openapi: '3.1.0',
    info: {
      title: 'Tela API',
      version: String(DOCUMENTED_VERSION),
      description:
        'Tela’s API for approved apps (ADR 0065). Camel-case keys, epoch milliseconds, integer server ids; an app ignores fields it does not know. Errors are `{ "error": code, … }`. Within v1, changes are additive only.',
      'x-status': documented?.status ?? 'preview',
    },
    servers: [{ url: API_ORIGIN }],
    security: [{ tela: ['read'] }],
    paths,
    components: {
      securitySchemes: {
        tela: {
          type: 'oauth2',
          description:
            'Authorization code with PKCE (S256) for public native apps (ADR 0064). `write` includes `read`; `email` lets `/v1/me` say the address.',
          flows: {
            authorizationCode: {
              authorizationUrl: CONSENT_PAGE,
              tokenUrl: `${API_ORIGIN}/oauth/token`,
              refreshUrl: `${API_ORIGIN}/oauth/token`,
              scopes: {
                read: 'Read the member’s rows, bodies and Tela’s public side',
                write: 'Read, and change: mutations, translations, feeds',
                email: 'See the member’s email address',
              },
            },
          },
        },
      },
      schemas,
    },
  }
}

/** The document as `docs/api/openapi.json` holds it. */
export const openapiText = () => `${JSON.stringify(openapiDocument(), null, 2)}\n`
