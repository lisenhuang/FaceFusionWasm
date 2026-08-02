/**
 * site.ts
 *
 * The facts about this site that more than one file needs to agree on: the
 * canonical origin, the name, and the one-sentence description.
 *
 * Kept here because they are duplicated into places that are easy to forget —
 * `metadataBase`, every page's canonical URL, the sitemap, robots.txt and the
 * JSON-LD. A domain change should be one edit, not a grep.
 */

/**
 * The canonical origin. Every absolute URL the site emits is built from this,
 * so search engines and answer engines are told about exactly one hostname
 * rather than deciding for themselves which of several is the real one.
 *
 * `NEXT_PUBLIC_SITE_URL` overrides it, which is what a custom domain should set
 * rather than editing this file.
 */
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ?? 'https://morphiqo.vercel.app'
).replace(/\/$/, '')

export const SITE_NAME = 'Morphiqo'

/**
 * The sentence that has to carry the whole product in a search result, so it
 * leads with what the thing is and what makes it different, and stays inside
 * the ~155 characters Google will render before truncating.
 */
export const SITE_DESCRIPTION =
  'Swap faces in videos and photos entirely on your iPhone, iPad or Mac. Morphiqo works offline and never uploads your media — there is no server.'

/**
 * One App Store record covers both platforms, so both buttons point here.
 *
 * The landing page is about the iOS and macOS apps and nothing else. The
 * browser build lives at `/studio` and is deliberately unadvertised — it is not
 * linked from `/`, not in the sitemap, and marked `noindex`.
 */
export const APP_STORE_ID = '6797135085'
export const APP_STORE_URL = `https://apps.apple.com/app/id${APP_STORE_ID}`

/** Absolute URL for a site-relative path. */
export function absoluteURL(path: string): string {
  return `${SITE_URL}${path.startsWith('/') ? path : `/${path}`}`
}
