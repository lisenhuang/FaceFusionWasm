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
  'Swap faces in videos and photos entirely on your own device. Morphiqo runs offline in your browser, iPhone or Mac — your media is never uploaded.'

/** Absolute URL for a site-relative path. */
export function absoluteURL(path: string): string {
  return `${SITE_URL}${path.startsWith('/') ? path : `/${path}`}`
}
