'use client'

/**
 * Onboarding.tsx
 *
 * First run: explain what is about to be downloaded, then download it.
 *
 * This is the only moment the app needs a network connection, so it says so
 * plainly rather than leaving the user to wonder. It is also the only screen
 * where the licensing of the models is unavoidable, which is deliberate.
 */

import { useMemo, useState } from 'react'

import { MODEL_DISPLAY_NAME, MODEL_PURPOSE, type ModelID } from '@/engine/types'
import { formatBytes } from '@/lib/format'
import { useStore } from '@/lib/store'
import type { ModelDescriptor, ModelInstallState } from '@/worker/protocol'
import {
  Button,
  GitHubLink,
  IconCheck,
  IconDownload,
  IconShield,
  IconSparkles,
  IconWarning,
  ProgressBar,
  Spinner,
  Toggle,
  cx,
} from './ui'

export function Onboarding() {
  const manifest = useStore((state) => state.manifest)
  const library = useStore((state) => state.library)
  const install = useStore((state) => state.installModels)
  const cancel = useStore((state) => state.cancelInstall)
  const statusMessage = useStore((state) => state.statusMessage)

  const [includeOptional, setIncludeOptional] = useState(true)

  const models = useMemo(() => manifest?.models ?? [], [manifest])
  const selected = useMemo(
    () => (includeOptional ? models : models.filter((model) => model.required)),
    [models, includeOptional],
  )

  const stateOf = (id: string): ModelInstallState =>
    library?.states[id] ?? { kind: 'missing' }

  const downloadSize = selected
    .filter((model) => stateOf(model.id).kind !== 'installed')
    .reduce((total, model) => total + model.bytes, 0)

  const working = library?.isWorking ?? false

  return (
    <main className="relative mx-auto flex w-full max-w-2xl flex-col gap-8 px-5 py-10 sm:px-8 sm:py-16">
      {/* Out of the flow, so it cannot pull the centred header off centre. */}
      <GitHubLink className="absolute right-3 top-3 sm:right-5 sm:top-5" />

      <header className="flex flex-col items-center gap-3 text-center">
        <span className="grid h-[72px] w-[72px] place-items-center rounded-2xl bg-accent-600/12 ring-1 ring-accent-600/25">
          <IconSparkles className="h-8 w-8 text-accent-400" />
        </span>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-[26px]">
          Set up FaceFusion
        </h1>
        <p className="max-w-lg text-balance text-[14px] leading-relaxed text-ink-300">
          The app needs its AI models before it can run. This is a one-time download —
          afterwards face swapping works entirely in this browser, on this device, with no
          internet connection.
        </p>
      </header>

      {statusMessage ? (
        <Banner kind="error">{statusMessage}</Banner>
      ) : null}

      <ul className="divide-y divide-ink-800 overflow-hidden rounded-2xl bg-ink-900/60 ring-1 ring-ink-800">
        {models.map((model) => (
          <ModelRow
            key={model.id}
            descriptor={model}
            state={stateOf(model.id)}
            included={model.required || includeOptional}
          />
        ))}
        {models.length === 0 ? (
          <li className="flex items-center gap-3 px-4 py-6 text-[13px] text-ink-400">
            <Spinner /> Reading the model manifest…
          </li>
        ) : null}
      </ul>

      <div className="flex flex-col gap-5">
        <Toggle
          checked={includeOptional}
          disabled={working}
          onChange={setIncludeOptional}
          title="Include quality extras"
          hint="Sharper results and steadier tracking. You can add these later."
        />

        {working ? (
          <div className="flex flex-col gap-2">
            <ProgressBar
              fraction={
                library && library.sessionTotal > 0
                  ? library.sessionReceived / library.sessionTotal
                  : 0
              }
            />
            <div className="flex items-center justify-between text-[12px] text-ink-400">
              <span className="tabular-nums">
                {formatBytes(library?.sessionReceived ?? 0)} of{' '}
                {formatBytes(library?.sessionTotal ?? 0)}
              </span>
              <Button variant="link" onClick={cancel}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="primary"
            size="lg"
            className="w-full"
            disabled={selected.length === 0}
            onClick={() => install(selected.map((model) => model.id as ModelID))}
          >
            <IconDownload />
            {downloadSize > 0 ? `Download ${formatBytes(downloadSize)}` : 'Continue'}
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-3 rounded-2xl bg-ink-900/50 p-4 text-[12px] leading-relaxed text-ink-300 ring-1 ring-ink-800">
        <Note icon={<IconShield className="h-4 w-4 text-ink-400" />}>
          Downloaded from the FaceFusion model repository and verified against a SHA-256
          checksum before use. Anything that does not match is discarded.
        </Note>
        <Note icon={<IconWarning className="h-4 w-4 text-warn-500" />}>
          The face-swapping models are published for non-commercial research use. Only swap
          faces of people who have agreed to it.
        </Note>
        <Note icon={<IconCheck className="h-4 w-4 text-good-500" />}>
          The models are stored in this browser&rsquo;s private storage. Your photos and
          videos are never uploaded — there is no server to upload them to.
        </Note>
      </div>
    </main>
  )
}

function Note({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2.5">
      <span className="mt-px shrink-0">{icon}</span>
      <span>{children}</span>
    </p>
  )
}

function ModelRow({
  descriptor,
  state,
  included,
}: {
  descriptor: ModelDescriptor
  state: ModelInstallState
  included: boolean
}) {
  const id = descriptor.id as ModelID
  return (
    <li
      className={cx(
        'flex items-center gap-3 px-4 py-3 transition-opacity',
        !included && 'opacity-45',
      )}
    >
      <span className="grid w-5 shrink-0 place-items-center">
        <StatusIcon state={state} />
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-ink-100">
            {MODEL_DISPLAY_NAME[id] ?? descriptor.id}
          </span>
          {!descriptor.required ? (
            <span className="rounded-full bg-ink-700 px-1.5 py-px text-[10px] font-medium text-ink-300">
              Optional
            </span>
          ) : null}
        </span>
        <span className="block truncate text-[11.5px] text-ink-400">
          {MODEL_PURPOSE[id] ?? ''}
        </span>
      </span>

      <span className="shrink-0 text-right text-[12px] tabular-nums text-ink-400">
        <Trailing state={state} bytes={descriptor.bytes} />
      </span>
    </li>
  )
}

function StatusIcon({ state }: { state: ModelInstallState }) {
  switch (state.kind) {
    case 'installed':
      return <IconCheck className="h-4 w-4 text-good-500" />
    case 'failed':
      return <IconWarning className="h-4 w-4 text-warn-500" />
    case 'downloading':
    case 'verifying':
      return <Spinner className="h-4 w-4 text-accent-400" />
    default:
      return <IconDownload className="h-4 w-4 text-ink-500" />
  }
}

function Trailing({ state, bytes }: { state: ModelInstallState; bytes: number }) {
  switch (state.kind) {
    case 'downloading':
      return <>{Math.round((state.received / Math.max(state.total, 1)) * 100)}%</>
    case 'verifying':
      return <>Verifying…</>
    case 'installed':
      return <>Installed</>
    case 'failed':
      return <span className="text-warn-500">Failed</span>
    default:
      return <>{formatBytes(bytes)}</>
  }
}

export function Banner({
  kind,
  children,
}: {
  kind: 'error' | 'info'
  children: React.ReactNode
}) {
  return (
    <div
      className={cx(
        'flex items-start gap-2.5 rounded-xl p-3 text-[13px] leading-relaxed',
        kind === 'error'
          ? 'bg-warn-500/10 text-ink-100 ring-1 ring-warn-500/25'
          : 'bg-ink-800/60 text-ink-200 ring-1 ring-ink-700',
      )}
    >
      <IconWarning
        className={cx('mt-px h-4 w-4 shrink-0', kind === 'error' ? 'text-warn-500' : 'text-ink-400')}
      />
      <span className="min-w-0">{children}</span>
    </div>
  )
}
