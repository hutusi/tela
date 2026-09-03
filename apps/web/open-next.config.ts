import { defineCloudflareConfig } from '@opennextjs/cloudflare'

// No ISR / incremental cache: pages render dynamically and public pages use the
// Cache API explicitly. Keeps the app free of R2/KV/queue bindings.
export default defineCloudflareConfig({})
