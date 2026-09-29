/**
 * Adapters that run anywhere: the test suite uses them, and they are the exit path off Cloudflare
 * (ADR 0021). Nothing here may be imported by a Worker bundle.
 */
import { type Client, createClient, type InArgs, type InStatement } from '@libsql/client'
import { AwsClient } from 'aws4fetch'
import { drizzle } from 'drizzle-orm/libsql'
import type { BlobObject, BlobPutOptions, Blobs } from './blobs'
import type { Clock } from './clock'
import { checkD1Limits, type Db } from './db'

function parameterCount(args: InArgs | undefined): number {
  if (!args) return 0
  return Array.isArray(args) ? args.length : Object.keys(args).length
}

function checkStatement(stmt: InStatement, args?: InArgs): void {
  if (typeof stmt === 'string') checkD1Limits(stmt, parameterCount(args))
  else checkD1Limits(stmt.sql, parameterCount(stmt.args))
}

/**
 * A libSQL client held to D1's rules: every statement is checked against D1's limits, and the
 * interactive `transaction()` D1 does not have is refused outright.
 */
export function d1CompatibleClient(client: Client): Client {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'execute') {
        return (stmt: InStatement, args?: InArgs) => {
          checkStatement(stmt, args)
          return args === undefined ? target.execute(stmt) : target.execute(stmt as string, args)
        }
      }
      if (prop === 'batch') {
        return (stmts: InStatement[], mode?: Parameters<Client['batch']>[1]) => {
          for (const stmt of stmts) checkStatement(stmt)
          return target.batch(stmts, mode)
        }
      }
      if (prop === 'transaction') {
        return () => {
          throw new Error('Interactive transactions are not portable to D1 (ADR 0021); use batch')
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** Drizzle over libSQL (`:memory:`, a file, or a libSQL server), with D1's rules enforced. */
export function libsqlDb<TSchema extends Record<string, unknown>>(options: {
  url: string
  authToken?: string
  schema: TSchema
}): { db: Db<TSchema>; client: Client } {
  const client = d1CompatibleClient(
    createClient({
      url: options.url,
      ...(options.authToken ? { authToken: options.authToken } : {}),
    }),
  )
  const db = drizzle(client, { schema: options.schema, casing: 'snake_case' })
  return { db: db as unknown as Db<TSchema>, client }
}

function toBytes(body: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof body === 'string') return new TextEncoder().encode(body)
  return body instanceof Uint8Array ? body : new Uint8Array(body)
}

function blobObject(key: string, bytes: Uint8Array, contentType: string | null): BlobObject {
  return {
    key,
    size: bytes.byteLength,
    contentType,
    text: async () => new TextDecoder().decode(bytes),
    arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
  }
}

/** In-memory blobs, for tests. */
export function memoryBlobs(): Blobs & { readonly size: number } {
  const store = new Map<string, { bytes: Uint8Array; contentType: string | null }>()
  return {
    get size() {
      return store.size
    },
    async get(key) {
      const hit = store.get(key)
      return hit ? blobObject(key, hit.bytes, hit.contentType) : null
    },
    async head(key) {
      const hit = store.get(key)
      return hit ? { key, size: hit.bytes.byteLength, contentType: hit.contentType } : null
    },
    async put(key, body, options?: BlobPutOptions) {
      store.set(key, { bytes: toBytes(body), contentType: options?.contentType ?? null })
    },
    async delete(key) {
      store.delete(key)
    },
    async list({ prefix, cursor, limit = 1000 }) {
      const keys = [...store.keys()]
        .filter((k) => k.startsWith(prefix) && (cursor === undefined || k > cursor))
        .sort()
      const page = keys.slice(0, limit)
      return { keys: page, cursor: keys.length > limit ? (page.at(-1) ?? null) : null }
    },
  }
}

export type S3Config = {
  /** Bucket URL, path style: `https://<account>.r2.cloudflarestorage.com/<bucket>`, or any S3. */
  endpoint: string
  accessKeyId: string
  secretAccessKey: string
  region?: string
  fetch?: typeof fetch
}

/** Any S3-compatible store (R2's S3 API, MinIO, AWS), signed with aws4fetch; no SDK. */
export function s3Blobs(config: S3Config): Blobs {
  const signer = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: 's3',
    region: config.region ?? 'auto',
  })
  const doFetch = config.fetch ?? fetch
  // Sign with aws4fetch, send with our own fetch, so tests (and runtimes) can supply one.
  const client = {
    fetch: async (input: string, init?: RequestInit) => doFetch(await signer.sign(input, init)),
  }
  const base = config.endpoint.replace(/\/$/, '')
  const url = (key: string) => `${base}/${key.split('/').map(encodeURIComponent).join('/')}`
  const fail = async (op: string, key: string, res: Response): Promise<never> => {
    throw new Error(
      `S3 ${op} ${key}: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`,
    )
  }
  return {
    async get(key) {
      const res = await client.fetch(url(key))
      if (res.status === 404) return null
      if (!res.ok) return fail('get', key, res)
      const bytes = new Uint8Array(await res.arrayBuffer())
      return blobObject(key, bytes, res.headers.get('content-type'))
    },
    async head(key) {
      const res = await client.fetch(url(key), { method: 'HEAD' })
      if (res.status === 404) return null
      if (!res.ok) return fail('head', key, res)
      return {
        key,
        size: Number(res.headers.get('content-length') ?? 0),
        contentType: res.headers.get('content-type'),
      }
    },
    async put(key, body, options) {
      const headers: Record<string, string> = {}
      if (options?.contentType) headers['content-type'] = options.contentType
      if (options?.cacheControl) headers['cache-control'] = options.cacheControl
      const res = await client.fetch(url(key), { method: 'PUT', headers, body: toBytes(body) })
      if (!res.ok) await fail('put', key, res)
    },
    async delete(key) {
      const res = await client.fetch(url(key), { method: 'DELETE' })
      if (!res.ok && res.status !== 404) await fail('delete', key, res)
    },
    async list({ prefix, cursor, limit = 1000 }) {
      const params = new URLSearchParams({ 'list-type': '2', prefix, 'max-keys': String(limit) })
      if (cursor) params.set('continuation-token', cursor)
      const res = await client.fetch(`${base}?${params}`)
      if (!res.ok) return fail('list', prefix, res)
      const xml = await res.text()
      const keys = [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => decodeXml(m[1] ?? ''))
      const next = xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/)?.[1]
      return { keys, cursor: next ? decodeXml(next) : null }
    },
  }
}

function decodeXml(text: string): string {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}

/** A clock tests move by hand. */
export function fakeClock(start = Date.UTC(2026, 8, 27)): Clock & {
  advance(ms: number): void
  set(ms: number): void
} {
  let now = start
  return {
    now: () => now,
    advance: (ms) => {
      now += ms
    },
    set: (ms) => {
      now = ms
    },
  }
}

/** In `./jobs`, so a Worker's test mode can drain work in-process without libSQL. */
export { memoryJobs, type SentJob } from './jobs'

/** Mail that goes nowhere (in `./mail`, so a Worker's test mode can use it without libSQL). */
export { memoryMail } from './mail'
