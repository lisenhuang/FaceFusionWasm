import type { MetadataRoute } from 'next'

import { absoluteURL } from '@/lib/site'

/**
 * Generates `/robots.txt`.
 *
 * Everything here is public and worth indexing, so the only real job is
 * pointing crawlers at the sitemap. `/ort/` is excluded because it holds the
 * ONNX Runtime WebAssembly binaries — tens of megabytes of content-addressed
 * blobs that waste a crawl budget and say nothing about the product.
 *
 * Answer-engine crawlers (GPTBot, ClaudeBot, PerplexityBot and the rest) are
 * deliberately *not* blocked: being quotable by them is the point of the
 * document pages.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/ort/'],
      },
    ],
    sitemap: absoluteURL('/sitemap.xml'),
  }
}
