import type { MetadataRoute } from 'next'

import { absoluteURL } from '@/lib/site'

/**
 * Generates `/sitemap.xml`.
 *
 * Four pages, so this could be omitted and nothing would be missed — except
 * that a sitemap is also how you state a priority order and a change cadence,
 * and the studio and the documents differ sharply on both.
 *
 * No `lastModified`: it would have to be either a build timestamp, which tells
 * a crawler the text changed when only the bundle did, or a hand-maintained
 * date, which goes stale silently. Omitting it is more honest than either.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: absoluteURL('/'), changeFrequency: 'monthly', priority: 1 },
    { url: absoluteURL('/support'), changeFrequency: 'monthly', priority: 0.8 },
    { url: absoluteURL('/privacy'), changeFrequency: 'yearly', priority: 0.5 },
    { url: absoluteURL('/terms'), changeFrequency: 'yearly', priority: 0.5 },
  ]
}
