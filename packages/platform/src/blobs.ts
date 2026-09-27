/** An object in the blob store. Content objects are immutable; the store is not asked to know that. */
export type BlobObject = {
  key: string
  size: number
  contentType: string | null
  text(): Promise<string>
  arrayBuffer(): Promise<ArrayBuffer>
}

export type BlobPutOptions = {
  contentType?: string
  cacheControl?: string
}

/** Object storage: R2 in production, S3 (any compatible store) or memory elsewhere. */
export interface Blobs {
  get(key: string): Promise<BlobObject | null>
  head(key: string): Promise<Omit<BlobObject, 'text' | 'arrayBuffer'> | null>
  put(key: string, body: string | Uint8Array | ArrayBuffer, options?: BlobPutOptions): Promise<void>
  delete(key: string): Promise<void>
  /** Keys under `prefix`, a page at a time; `cursor` is null on the last page. */
  list(options: {
    prefix: string
    cursor?: string
    limit?: number
  }): Promise<{ keys: string[]; cursor: string | null }>
}
