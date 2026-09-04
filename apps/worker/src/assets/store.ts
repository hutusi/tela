import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AwsClient } from 'aws4fetch'

/** Where normalized favicons and covers go. Keys are like `sites/12/favicon.png`. */
export interface AssetStore {
  readonly kind: string
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>
}

export type R2Config = {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
}

/** Cloudflare R2 through its S3-compatible API (signed with aws4fetch, no SDK). */
export function createR2Store(config: R2Config): AssetStore {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: 's3',
    region: 'auto',
  })
  const endpoint = `https://${config.accountId}.r2.cloudflarestorage.com/${config.bucket}`
  return {
    kind: 'r2',
    async put(key, bytes, contentType) {
      const res = await client.fetch(`${endpoint}/${key}`, {
        method: 'PUT',
        headers: {
          'content-type': contentType,
          'cache-control': 'public, max-age=31536000, immutable',
        },
        body: bytes,
      })
      if (!res.ok)
        throw new Error(
          `R2 put ${key} failed: HTTP ${res.status} ${await res.text().catch(() => '')}`,
        )
    },
  }
}

/** Local directory, for development and tests. */
export function createFsStore(dir: string): AssetStore {
  return {
    kind: 'fs',
    async put(key, bytes) {
      const path = join(dir, key)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, bytes)
    },
  }
}

/** Pick a store from the environment: R2 when configured, a directory when ASSETS_DIR is set, else none. */
export function createStoreFromEnv(
  env: Record<string, string | undefined> = process.env,
): AssetStore | null {
  if (env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET) {
    return createR2Store({
      accountId: env.R2_ACCOUNT_ID,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      bucket: env.R2_BUCKET,
    })
  }
  if (env.ASSETS_DIR) return createFsStore(env.ASSETS_DIR)
  return null
}
