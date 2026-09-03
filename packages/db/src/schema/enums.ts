import {
  CLAIM_METHODS,
  CLAIM_STATUSES,
  CONTENT_MODES,
  EXTRACTED_FROM,
  FEED_FORMATS,
  FEED_STATUSES,
  FETCH_REGIONS,
  SITE_LISTINGS,
  TRANSLATION_STATUSES,
} from '@tela/shared'
import { pgEnum } from 'drizzle-orm/pg-core'

export const siteListingEnum = pgEnum('site_listing', SITE_LISTINGS)
export const feedFormatEnum = pgEnum('feed_format', FEED_FORMATS)
export const feedStatusEnum = pgEnum('feed_status', FEED_STATUSES)
export const fetchRegionEnum = pgEnum('fetch_region', FETCH_REGIONS)
export const contentModeEnum = pgEnum('content_mode', CONTENT_MODES)
export const extractedFromEnum = pgEnum('extracted_from', EXTRACTED_FROM)
export const translationStatusEnum = pgEnum('translation_status', TRANSLATION_STATUSES)
export const claimMethodEnum = pgEnum('claim_method', CLAIM_METHODS)
export const claimStatusEnum = pgEnum('claim_status', CLAIM_STATUSES)
