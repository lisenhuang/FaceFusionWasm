/**
 * The Support URL given to App Store Connect.
 *
 * App Review needs a reachable human and a page that answers the obvious
 * questions. The answers here are the real ones — the 900 MB download, the
 * device floor and the offline guarantee are the three things people actually
 * write in about.
 */

import type { Metadata } from 'next'
import Link from 'next/link'

import { DocPage, Highlight, List, MailLink, Section, SOURCE_URL } from '@/components/DocPage'

export const metadata: Metadata = {
  title: 'Support — Morphiqo',
  description:
    'Help with Morphiqo: model downloads, device requirements, storage, and how to get in touch.',
  robots: { index: true, follow: true },
}

export default function SupportPage() {
  return (
    <DocPage
      title="Support"
      intro="Something not working, or a question the app does not answer? Write to me directly — every message is read by the person who wrote the app."
    >
      <Highlight>
        Email <MailLink />. Including your device model, OS version and app version makes
        almost every problem faster to sort out. You can find the app version in Settings.
      </Highlight>

      <Section title="The first launch wants to download about 900 MB">
        <p>
          That is expected, and it happens once. Morphiqo does the face swapping on your
          own device, which means the AI models have to be on your device — they are too
          large to ship inside the app itself, so the app fetches them on first run.
        </p>
        <p>
          Use Wi-Fi if you can. Once the download finishes, the app works with no network
          connection at all.
        </p>
      </Section>

      <Section title="The download stopped, failed, or seems stuck">
        <List>
          <li>
            Check you have enough free space. The models need roughly 900 MB, plus room for
            whatever you are exporting.
          </li>
          <li>
            The download resumes rather than restarting, so re-opening the app after a drop
            picks up where it left off.
          </li>
          <li>
            Every file is verified against a checksum, and anything that does not match is
            thrown away and fetched again. A download that restarts a piece is the app
            protecting you from a corrupt model, not a bug.
          </li>
          <li>
            On a restricted network — some workplace and hotel Wi-Fi — the model host may
            be blocked. Trying another network is usually the fastest test.
          </li>
        </List>
      </Section>

      <Section title="Which devices work">
        <List>
          <li>
            <strong>iPhone and iPad</strong> — iOS 17 or later. Older or smaller devices
            work, but <em>Enhance detail</em> is demanding; turn it off if things are slow
            or memory-constrained.
          </li>
          <li>
            <strong>Mac</strong> — a recent macOS, Apple silicon or Intel.
          </li>
          <li>
            <strong>Web</strong> — Chrome or Edge 121+, Safari 17+, or a recent Chrome on
            Android. The browser needs Web Workers, WebCodecs, OffscreenCanvas and the
            Origin Private File System; the app tells you which one is missing if it cannot
            run. There is no server-side fallback, by design.
          </li>
        </List>
      </Section>

      <Section title="The result does not look right">
        <List>
          <li>
            Use a clear, well-lit, roughly front-facing source photo. Almost every
            disappointing swap traces back to the source rather than the settings.
          </li>
          <li>
            If the wrong face was replaced, pick the intended face explicitly rather than
            relying on the automatic match.
          </li>
          <li>
            <em>Enhance detail</em> restores sharpness after the swap. It costs time and
            memory, and on a long video that trade is worth making deliberately.
          </li>
        </List>
      </Section>

      <Section title="Removing the models and your data">
        <p>
          Nothing you process leaves your device, so there is no account to close and
          nothing to request from a server. To reclaim the space: delete the app on iOS or
          macOS, or clear this site&rsquo;s data in the browser for the web version. That
          removes the models and your settings completely.
        </p>
        <p>
          What Morphiqo does and does not touch is set out in full in the{' '}
          <Link href="/privacy" className="text-accent-400 hover:underline">
            privacy policy
          </Link>
          .
        </p>
      </Section>

      <Section title="Bugs and feature requests">
        <p>
          The web version is open source. Bug reports and requests are welcome as issues
          on{' '}
          <a
            href={SOURCE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent-400 hover:underline"
          >
            GitHub
          </a>
          , or by email if you would rather not open one.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          <MailLink /> — for support, bug reports, privacy questions or anything else about
          the app.
        </p>
      </Section>
    </DocPage>
  )
}
