/**
 * The Support URL given to App Store Connect.
 *
 * App Review needs a reachable human and a page that answers the obvious
 * questions. The answers here are the real ones — the 900 MB download, the
 * device floor and the offline guarantee are the three things people actually
 * write in about.
 *
 * The questions are held as data rather than as prose so that the visible page
 * and the `FAQPage` structured data are generated from one source. A search
 * result or an AI answer that quotes this page is quoting the same words a
 * reader sees, and the two cannot drift apart later — which is both the rule
 * Google states for FAQ markup and the only version worth having.
 */

import type { Metadata } from 'next'
import Link from 'next/link'

import { DocPage, Highlight, List, MailLink, Section } from '@/components/DocPage'
import { absoluteURL } from '@/lib/site'

const TITLE = 'Support'
const DESCRIPTION =
  'Help with Morphiqo: the one-time model download, which devices work, why a swap looks wrong, removing your data, and how to get in touch.'

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/support' },
  openGraph: { title: `${TITLE} — Morphiqo`, description: DESCRIPTION, url: '/support' },
  robots: { index: true, follow: true },
}

/**
 * One question, and its answer as either paragraphs or bullets.
 *
 * Plain strings, deliberately: anything that needs a link or an email address
 * stays out of this array and is written as ordinary JSX below, because an
 * answer that only makes sense with a hyperlink in it makes a poor quotation.
 */
type Faq = { question: string; paragraphs?: string[]; bullets?: string[] }

const FAQS: Faq[] = [
  {
    question: 'The first launch wants to download about 900 MB',
    paragraphs: [
      'That is expected, and it happens once. Morphiqo does the face swapping on your own device, which means the AI models have to be on your device — they are too large to ship inside the app itself, so the app fetches them on first run.',
      'Use Wi-Fi if you can. Once the download finishes, the app works with no network connection at all.',
    ],
  },
  {
    question: 'The download stopped, failed, or seems stuck',
    bullets: [
      'Check you have enough free space. The models need roughly 900 MB, plus room for whatever you are exporting.',
      'The download resumes rather than restarting, so re-opening the app after a drop picks up where it left off.',
      'Every file is verified against a checksum, and anything that does not match is thrown away and fetched again. A download that restarts a piece is the app protecting you from a corrupt model, not a bug.',
      'On a restricted network — some workplace and hotel Wi-Fi — the model host may be blocked. Trying another network is usually the fastest test.',
    ],
  },
  {
    question: 'Which devices work',
    bullets: [
      'iPhone and iPad — iOS 17 or later. Older or smaller devices work, but Enhance detail is demanding; turn it off if things are slow or memory-constrained.',
      'Mac — macOS 14 or later, Apple silicon or Intel.',
      'Web — Chrome or Edge 121+, Safari 17+, or a recent Chrome on Android. The browser needs Web Workers, WebCodecs, OffscreenCanvas and the Origin Private File System; the app tells you which one is missing if it cannot run. There is no server-side fallback, by design.',
    ],
  },
  {
    question: 'The result does not look right',
    bullets: [
      'Use a clear, well-lit, roughly front-facing source photo. Almost every disappointing swap traces back to the source rather than the settings.',
      'If the wrong face was replaced, pick the intended face explicitly rather than relying on the automatic match.',
      'Enhance detail restores sharpness after the swap. It costs time and memory, and on a long video that trade is worth making deliberately.',
    ],
  },
  {
    question: 'Is my video or photo uploaded anywhere?',
    paragraphs: [
      'No. Detection, face matching, swapping and enhancement all run on your own device, and the result is written back only when you export it. There is no server to upload to, no account, and no copy of your media anywhere but your device.',
    ],
  },
  {
    question: 'Does Morphiqo work offline?',
    paragraphs: [
      'Yes, once the one-time model download has finished. After that the iOS and macOS apps run with the network switched off entirely, and the web version needs the network only to load the page itself.',
    ],
  },
  {
    question: 'Bugs and feature requests',
    paragraphs: [
      'Both are welcome by email. For a bug, the most useful things to include are what you did, what happened instead, and the device and OS version it happened on — a swap that goes wrong on one device and not another is usually a hardware or browser difference, and knowing which narrows it down immediately.',
    ],
  },
]

/** The same questions and answers, in the shape schema.org asks for. */
const faqStructuredData = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  '@id': absoluteURL('/support#faq'),
  mainEntity: FAQS.map((faq) => ({
    '@type': 'Question',
    name: faq.question,
    acceptedAnswer: {
      '@type': 'Answer',
      text: [...(faq.paragraphs ?? []), ...(faq.bullets ?? [])].join(' '),
    },
  })),
}

export default function SupportPage() {
  return (
    <>
      <script
        type="application/ld+json"
        // Built from the `FAQS` literal above — no user input reaches it.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqStructuredData) }}
      />
      <DocPage
        title="Support"
        intro="Something not working, or a question the app does not answer? Write to me directly — every message is read by the person who wrote the app."
      >
        <Highlight>
          Email <MailLink />. Including your device model, OS version and app version makes
          almost every problem faster to sort out. You can find the app version in Settings.
        </Highlight>

        {FAQS.map((faq) => (
          <Section key={faq.question} title={faq.question}>
            {faq.paragraphs?.map((text) => <p key={text}>{text}</p>)}
            {faq.bullets && (
              <List>
                {faq.bullets.map((text) => (
                  <li key={text}>{text}</li>
                ))}
              </List>
            )}
          </Section>
        ))}

        <Section title="Removing the models and your data">
          <p>
            Nothing you process leaves your device, so there is no account to close and
            nothing to request from a server. On iOS and macOS, deleting the app reclaims
            the space.
          </p>
          <p>
            In the web version, the Storage section in Settings shows what the models are
            using and removes any of them. The quality extras are nearly half of the total
            and face swapping still works without them; removing anything else stops face
            swapping until you download it again. Clearing this site&rsquo;s data in the
            browser removes the models and your settings completely.
          </p>
          <p>
            What Morphiqo does and does not touch is set out in full in the{' '}
            <Link href="/privacy" className="text-accent-400 hover:underline">
              privacy policy
            </Link>
            .
          </p>
        </Section>

        <Section title="Contact">
          <p>
            <MailLink /> — for support, bug reports, privacy questions or anything else
            about the app.
          </p>
        </Section>
      </DocPage>
    </>
  )
}
