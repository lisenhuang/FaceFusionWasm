/**
 * Terms of Use — the EULA link for the App Store listing.
 *
 * If a developer supplies their own EULA rather than relying on Apple's
 * standard one, Apple requires it to cover a specific set of points: that the
 * agreement is with the developer and not Apple, the scope of the licence, who
 * handles support and warranty claims, product and IP claims, export
 * compliance, and Apple's standing as a third-party beneficiary. Those live in
 * the "Apple and the App Store" section and should not be trimmed without
 * checking that requirement first.
 */

import type { Metadata } from 'next'
import Link from 'next/link'

import { DocPage, Highlight, List, MailLink, Section } from '@/components/DocPage'

const TITLE = 'Terms of Use'
const DESCRIPTION =
  'The terms that apply when you use Morphiqo, including acceptable use of face-swapping and the licences covering its AI models.'

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/terms' },
  openGraph: { title: `${TITLE} — Morphiqo`, description: DESCRIPTION, url: '/terms' },
  robots: { index: true, follow: true },
}

export default function TermsPage() {
  return (
    <DocPage
      title="Terms of Use"
      intro="These terms apply when you use Morphiqo on iOS, macOS or the web. Using the app means you accept them."
    >
      <Highlight>
        Morphiqo alters images of people. You are responsible for having the right to use
        the media you process, and for what you do with the result. Only swap faces of
        people who have agreed to it.
      </Highlight>

      <Section title="Your licence to use Morphiqo">
        <p>
          You are granted a personal, non-exclusive, non-transferable, revocable licence to
          use Morphiqo on devices you own or control, for as long as you comply with these
          terms. On iOS and macOS the licence is limited to what the App Store&rsquo;s Usage
          Rules allow.
        </p>
        <p>
          The app is licensed, not sold. You may not sell, rent, sublicense or redistribute
          it, and you may not reverse-engineer, decompile or attempt to derive its source
          beyond what applicable law allows regardless of contract. The web version&rsquo;s
          source is published separately under its own open-source licence, which governs
          that code rather than this document.
        </p>
      </Section>

      <Section title="Acceptable use">
        <p>You agree not to use Morphiqo to produce or distribute:</p>
        <List>
          <li>
            Imagery of any person who has not agreed to have their likeness used — the
            single rule this app most depends on you keeping.
          </li>
          <li>
            Sexual or intimate imagery of anyone, and under no circumstances imagery of
            minors.
          </li>
          <li>
            Content that impersonates a real person in order to deceive, defraud, harass,
            defame, or influence an election or public decision.
          </li>
          <li>
            Anything that breaks the law where you are. Rules on synthetic and manipulated
            media differ significantly between countries and are changing quickly; keeping
            up with the ones that apply to you is your responsibility, not the
            app&rsquo;s.
          </li>
        </List>
        <p>
          Morphiqo runs entirely on your device and has no server, no account and no
          moderation layer. That means nobody can review, intercept or take down what you
          make — the responsibility genuinely is yours alone.
        </p>
      </Section>

      <Section title="Your content stays yours">
        <p>
          The photos, videos and results you work with remain yours. Morphiqo claims no
          rights over them, and could not exercise any if it did: nothing you process is
          ever transmitted, so it is never seen by the developer or by anyone else. See the{' '}
          <Link href="/privacy" className="text-accent-400 hover:underline">
            privacy policy
          </Link>{' '}
          for exactly what the app does and does not touch.
        </p>
      </Section>

      <Section title="The AI models and their licences">
        <p>
          Morphiqo downloads its models from the public releases of the open-source
          FaceFusion project. Those models are third-party works, and each carries its own
          licence — several of them, including the face swapper and identity encoder, are
          published for <strong>non-commercial research use only</strong>.
        </p>
        <p>
          Your use of the models is subject to those licences. If you intend to use
          Morphiqo&rsquo;s output commercially, it is on you to confirm that the licences
          covering the models permit it. Nothing in these terms grants you rights to the
          models beyond what their own licences give.
        </p>
      </Section>

      <Section title="No warranty">
        <p>
          Morphiqo is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;, without
          warranty of any kind, express or implied, including any implied warranty of
          merchantability, fitness for a particular purpose or non-infringement. It is not
          guaranteed to be uninterrupted, error-free, or to produce any particular quality
          of result.
        </p>
        <p>
          Some jurisdictions do not allow the exclusion of implied warranties or of certain
          consumer guarantees. Where that is the case, those protections apply to you and
          the exclusions above apply only to the extent the law permits.
        </p>
      </Section>

      <Section title="Limitation of liability">
        <p>
          To the extent permitted by law, the developer is not liable for indirect,
          incidental, special or consequential damages, or for lost data, lost profits or
          loss of goodwill, arising out of your use of Morphiqo — including any claim
          brought by a person whose likeness you processed.
        </p>
      </Section>

      <Section title="Apple and the App Store">
        <p>
          For the iOS and macOS apps distributed through the App Store, the following
          apply:
        </p>
        <List>
          <li>
            These terms are between you and the developer of Morphiqo only, <strong>not
            with Apple</strong>. Apple is not responsible for the app or its content.
          </li>
          <li>
            The developer, not Apple, is solely responsible for support and maintenance.
            Apple has no obligation to provide either.
          </li>
          <li>
            If the app fails to conform to any applicable warranty, you may notify Apple
            and Apple will refund the purchase price, if any. To the maximum extent
            permitted by law, Apple has no other warranty obligation.
          </li>
          <li>
            The developer, not Apple, is responsible for addressing any claim that the app
            or your use of it infringes intellectual property rights, and for any claim of
            product liability, legal non-compliance, or consumer-protection breach.
          </li>
          <li>
            You confirm you are not located in a country subject to a U.S. Government
            embargo or designated as terrorist-supporting, and that you are not on any U.S.
            Government list of prohibited or restricted parties.
          </li>
          <li>
            Apple and its subsidiaries are third-party beneficiaries of these terms and
            have the right to enforce them against you.
          </li>
        </List>
      </Section>

      <Section title="Changes and ending the agreement">
        <p>
          These terms may change; the date at the top of this page changes with them, and
          continuing to use the app after a change means accepting it. You may end this
          agreement at any time by deleting the app, which also removes everything it
          stored on your device.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          Questions about these terms can go to <MailLink />.
        </p>
      </Section>
    </DocPage>
  )
}
