/**
 * The Privacy Policy URL given to App Store Connect.
 *
 * Every claim here is a claim about code that exists. The iOS and macOS apps
 * make exactly one network request — the model download — and the web app makes
 * that one plus the page load itself. If a future change adds a second, this
 * document is wrong and has to change with it.
 */

import type { Metadata } from 'next'

import { DocPage, Highlight, List, MailLink, Section } from '@/components/DocPage'

const TITLE = 'Privacy Policy'
const DESCRIPTION =
  'Morphiqo processes your photos and videos entirely on your device. No accounts, no uploads, and nothing that sees your media.'

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/privacy' },
  openGraph: { title: `${TITLE} — Morphiqo`, description: DESCRIPTION, url: '/privacy' },
  robots: { index: true, follow: true },
}

export default function PrivacyPage() {
  return (
    <DocPage
      title="Privacy Policy"
      intro="Morphiqo does not collect your personal data, because it never sends your media anywhere. Face swapping runs entirely on your own device."
    >
      <Highlight>
        Your photos and videos are never uploaded. There is no account to create, no
        advertising and no crash-reporting service, and the face swapping itself happens
        entirely on your device. This website counts page views in aggregate; the apps do
        not, and nothing anywhere sees your media.
      </Highlight>

      <Section title="What Morphiqo collects">
        <p>
          Nothing. Morphiqo has no server, no database and no user accounts. It does not
          ask for your name, email address, phone number or any identifier, and it has no
          way to associate activity with a person.
        </p>
        <p>Specifically, Morphiqo does not collect or transmit:</p>
        <List>
          <li>Photos, videos, or any frame or face extracted from them</li>
          <li>Event logs, feature counters or session recordings</li>
          <li>Crash reports or diagnostics (no third-party reporting SDK is integrated)</li>
          <li>Device identifiers, advertising identifiers or precise location</li>
          <li>Contacts, calendar, microphone or any data unrelated to the media you pick</li>
        </List>
        <p>
          The one exception is website traffic, which is measured in aggregate and is
          described in the next section. It applies to this site only — the iOS and macOS
          apps contain no analytics of any kind.
        </p>
      </Section>

      <Section title="Website analytics">
        <p>
          This website uses Vercel Web Analytics to count page views. It is cookieless and
          stores nothing on your device: no cookie, no local storage, no identifier that
          would let one visit be linked to another or to you.
        </p>
        <p>
          What it records is the sort of thing any web server log contains — which page was
          viewed, the referring page, and coarse signals such as country, browser and
          device type — held as counts rather than as a profile of a person.
        </p>
        <p>
          It never sees the media you work with. That never leaves your device to begin
          with, so there is nothing about your photos, videos or faces for any analytics to
          collect. The iOS and macOS apps do not include it.
        </p>
      </Section>

      <Section title="Your photos and videos">
        <p>
          When you choose a photo or video, Morphiqo reads it only to process it on your
          device. Detection, face matching, swapping and optional enhancement all run
          locally, using the processor and graphics hardware already in the device you are
          holding.
        </p>
        <p>
          The result is written back only when you explicitly export or save it. On iOS
          that means saving to your Photos library; on macOS and the web it means the file
          you choose. Nothing is written anywhere else, and nothing is retained after you
          close the app beyond the files you saved yourself.
        </p>
      </Section>

      <Section title="Faces and face data">
        <p>
          To match a face across frames, Morphiqo computes a numeric representation — an
          embedding — of the faces in the media you supplied. This is worth being precise
          about:
        </p>
        <List>
          <li>The computation happens on your device and the result stays in memory.</li>
          <li>
            It is used only to tell the faces in <em>your</em> media apart from one another
            during the current job.
          </li>
          <li>
            It is discarded when the job ends. It is not saved to disk, not built into a
            profile, and not compared against any database of people.
          </li>
          <li>It is never transmitted, because nothing in the app transmits media data.</li>
        </List>
        <p>
          Morphiqo cannot identify who anyone is. It has no reference set of known people
          to compare anyone against, and it never acquires one.
        </p>
      </Section>

      <Section title="The model download">
        <p>
          Morphiqo needs its AI models before it can run, and those are too large to ship
          inside the app. On first launch it downloads them over HTTPS from third-party
          file hosting — roughly 900 MB, once.
        </p>
        <p>
          The direction is the whole point, so it is worth stating plainly: this is a
          download and nothing else. The app asks for a fixed list of files and receives
          them. Those requests have no body, so there is nothing for your media to be
          carried in even in principle. Bytes travel towards your device and never away
          from it. The models come to your media; your media never goes to a model.
        </p>
        <p>
          Every byte is checked against a SHA-256 digest before use, and anything that does
          not match is discarded. Those hosts are operated by third parties and, like any
          web server, will see the IP address that asked for a file — the same thing that
          happens when you download anything at all. They see nothing else about you, and
          none of your media is part of the request.
        </p>
        <p>
          After the download completes, the app works with the network switched off
          entirely.
        </p>
      </Section>

      <Section title="What is stored on your device">
        <p>
          The downloaded models — roughly 900 MB — are stored in the app&rsquo;s own private
          storage: the sandboxed container on iOS and macOS, and the browser&rsquo;s Origin
          Private File System on the web. Your settings are stored alongside them.
        </p>
        <p>
          You can remove all of it at any time. Deleting the app removes its container on
          iOS and macOS. In the web app, the Storage section in Settings removes the models
          — any one of them, or all of them — and clearing this site&rsquo;s data in the
          browser removes everything, settings included. Nothing is left behind on a
          server, because there is no server.
        </p>
      </Section>

      <Section title="Children">
        <p>
          Morphiqo is not directed at children and does not knowingly collect information
          from anyone, of any age — there is no collection mechanism to direct at anybody.
        </p>
      </Section>

      <Section title="Your responsibilities">
        <p>
          Morphiqo is a tool that alters images of people. You are responsible for having
          the right to use the media you process, and for how you use what you produce.
          Only swap faces of people who have agreed to it.
        </p>
      </Section>

      <Section title="Changes to this policy">
        <p>
          If this policy changes, the date at the top of this page changes with it. Because
          the app collects nothing, a change here would mean a change in what the app does
          — and that would ship as an app update you can choose to install.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          Questions about privacy, or about anything above, can go to <MailLink />.
        </p>
      </Section>
    </DocPage>
  )
}
