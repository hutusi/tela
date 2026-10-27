/**
 * `bun run api:openapi`: write `docs/api/openapi.json` from the v1 formats (`../src/openapi.ts`).
 * Commit what it writes; `src/openapi.test.ts` fails while the committed document and the schemas
 * disagree. Biome leaves `docs/api/**\/*.json` alone, so the file is byte for byte what this writes,
 * and what tela-api serves at `/v1/openapi.json`.
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openapiText } from '../src/openapi'

export const OPENAPI_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'docs',
  'api',
  'openapi.json',
)

if (import.meta.main) {
  writeFileSync(OPENAPI_PATH, openapiText())
  console.log(`wrote ${OPENAPI_PATH}`)
}
