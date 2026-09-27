import { describe, expect, it } from 'bun:test'
import { sql } from 'drizzle-orm'
import { checkD1Limits, D1LimitError } from './db'
import { resendMail } from './mail'
import { fakeClock, libsqlDb, memoryBlobs, memoryJobs, memoryMail, s3Blobs } from './portable'

describe('D1 limits', () => {
  it('allows 100 bound parameters and refuses 101', () => {
    expect(() => checkD1Limits('select 1', 100)).not.toThrow()
    expect(() => checkD1Limits('select 1', 101)).toThrow(D1LimitError)
  })

  it('refuses a statement over 100 KB', () => {
    expect(() => checkD1Limits(`select '${'x'.repeat(100_000)}'`, 0)).toThrow(D1LimitError)
  })
})

describe('libsqlDb holds libSQL to what D1 can do', () => {
  const setup = async () => {
    const { db, client } = libsqlDb({ url: ':memory:', schema: {} })
    await client.execute('create table t (k integer primary key, v text not null)')
    return { db, client }
  }

  it('refuses a statement with more bound parameters than D1 allows', async () => {
    const { db } = await setup()
    const values = Array.from({ length: 101 }, (_, i) => sql`${i}`)
    // Drizzle wraps driver errors in DrizzleQueryError; the limit error is its cause.
    const err = await db.all(sql`select ${sql.join(values, sql`, `)}`).then(
      () => null,
      (e: unknown) => e as { cause?: unknown },
    )
    expect(err?.cause).toBeInstanceOf(D1LimitError)
  })

  it('checks every statement inside a batch', async () => {
    const { db } = await setup()
    const values = Array.from({ length: 101 }, (_, i) => sql`${i}`)
    await expect(
      db.batch([db.run(sql`select 1`), db.run(sql`select ${sql.join(values, sql`, `)}`)]),
    ).rejects.toThrow(D1LimitError)
  })

  it('refuses interactive transactions', async () => {
    const { client } = await setup()
    expect(() => client.transaction()).toThrow(/not portable to D1/)
  })

  it('applies a batch atomically: a failing statement rolls back the ones before it', async () => {
    const { db } = await setup()
    await expect(
      db.batch([
        db.run(sql`insert into t (k, v) values (1, 'kept?')`),
        db.run(sql`insert into t (k, v) values (2, null)`),
      ]),
    ).rejects.toThrow()
    expect(await db.all(sql`select k from t`)).toEqual([])
  })

  it('passes rows through one JSON parameter, which is how bulk writes stay under the limit', async () => {
    const { db } = await setup()
    const rows = Array.from({ length: 500 }, (_, i) => [i, `v${i}`])
    await db.run(
      sql`insert into t (k, v) select value->>0, value->>1 from json_each(${JSON.stringify(rows)}) where true`,
    )
    expect(await db.all(sql`select count(*) as n from t`)).toEqual([{ n: 500 }])
  })
})

describe('memoryBlobs', () => {
  it('stores, lists by prefix a page at a time, and deletes', async () => {
    const blobs = memoryBlobs()
    await blobs.put('c/b.json', '{"b":1}', { contentType: 'application/json' })
    await blobs.put('c/a.json', '{"a":1}')
    await blobs.put('t/x.json', '{}')
    expect(await (await blobs.get('c/b.json'))?.text()).toBe('{"b":1}')
    expect(await blobs.head('c/b.json')).toEqual({
      key: 'c/b.json',
      size: 7,
      contentType: 'application/json',
    })
    const first = await blobs.list({ prefix: 'c/', limit: 1 })
    expect(first).toEqual({ keys: ['c/a.json'], cursor: 'c/a.json' })
    expect(await blobs.list({ prefix: 'c/', cursor: first.cursor ?? '' })).toEqual({
      keys: ['c/b.json'],
      cursor: null,
    })
    await blobs.delete('c/a.json')
    expect(await blobs.get('c/a.json')).toBeNull()
  })
})

describe('s3Blobs', () => {
  it('signs path-style requests, encodes keys, and parses list pages', async () => {
    const seen: Request[] = []
    const fake = async (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      seen.push(req)
      if (req.method === 'GET' && new URL(req.url).searchParams.get('list-type') === '2') {
        return new Response(
          '<ListBucketResult><Contents><Key>c/a&amp;b.json</Key></Contents><NextContinuationToken>tok</NextContinuationToken></ListBucketResult>',
        )
      }
      if (req.method === 'GET') return new Response('missing', { status: 404 })
      return new Response(null, { status: 200 })
    }
    const blobs = s3Blobs({
      endpoint: 'https://acct.r2.cloudflarestorage.com/bucket/',
      accessKeyId: 'id',
      secretAccessKey: 'secret',
      fetch: fake as typeof fetch,
    })
    await blobs.put('c/hello world.json', '{}', {
      contentType: 'application/json',
      cacheControl: 'immutable',
    })
    const put = seen[0]
    expect(put?.method).toBe('PUT')
    expect(put?.url).toBe('https://acct.r2.cloudflarestorage.com/bucket/c/hello%20world.json')
    expect(put?.headers.get('authorization')).toStartWith('AWS4-HMAC-SHA256')
    expect(put?.headers.get('cache-control')).toBe('immutable')
    expect(await blobs.get('c/nope.json')).toBeNull()
    expect(await blobs.list({ prefix: 'c/' })).toEqual({ keys: ['c/a&b.json'], cursor: 'tok' })
  })
})

describe('resendMail', () => {
  it('posts one message to Resend with the API key', async () => {
    let body: Record<string, unknown> = {}
    let auth = ''
    const mail = resendMail({
      apiKey: 're_test',
      from: 'Tela <noreply@ainaive.com>',
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        auth = new Headers(init?.headers).get('authorization') ?? ''
        body = JSON.parse(String(init?.body))
        return new Response('{"id":"x"}')
      }) as typeof fetch,
    })
    await mail.send({ to: 'a@qq.com', subject: 'code 123456', text: '123456' })
    expect(auth).toBe('Bearer re_test')
    expect(body).toEqual({
      from: 'Tela <noreply@ainaive.com>',
      to: ['a@qq.com'],
      subject: 'code 123456',
      text: '123456',
    })
  })

  it('throws when Resend refuses, so the caller can tell the member', async () => {
    const mail = resendMail({
      apiKey: 'k',
      from: 'f',
      fetch: (async () => new Response('bad', { status: 422 })) as unknown as typeof fetch,
    })
    await expect(mail.send({ to: 'a@b.c', subject: 's', text: 't' })).rejects.toThrow(/422/)
  })
})

describe('memoryJobs, memoryMail and fakeClock', () => {
  it('record what was sent and hand it back per queue', async () => {
    const jobs = memoryJobs<{ fetch: { key: string }; translate: { key: string } }>()
    await jobs.send('fetch', { key: 'a' })
    await jobs.sendBatch('translate', [{ body: { key: 'b' }, delaySeconds: 2 }])
    await jobs.send('fetch', { key: 'c' })
    expect(jobs.take('fetch')).toEqual([{ key: 'a' }, { key: 'c' }])
    expect(jobs.sent).toEqual([{ queue: 'translate', body: { key: 'b' }, delaySeconds: 2 }])
    const mail = memoryMail()
    await mail.send({ to: 'x', subject: 'y', text: 'z' })
    expect(mail.outbox).toHaveLength(1)
    const clock = fakeClock(1000)
    clock.advance(500)
    expect(clock.now()).toBe(1500)
  })
})
