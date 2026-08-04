'use client'

/**
 * StoragePanel.tsx
 *
 * What the model library costs on disk, and how to get it back.
 *
 * The library is nearly a gigabyte, and it is the only thing this app leaves
 * behind on a device — so it is the only thing worth a storage screen. The
 * arrangement here is the whole feature: three models are what swapping is, and
 * two are quality on top of them. Those two are almost half the bytes, and
 * removing them costs the user nothing but a slightly softer result. A flat list
 * of five rows would hide the one action most people actually want, so the
 * reclaim-half-of-it case is offered first and by name, and the three that
 * cannot be removed without stopping the app ask before they go.
 *
 * The models are named by what they do, never by what they are — the same rule
 * as the setup screen, and the reason `MODEL_DISPLAY_NAME` exists.
 */

import { useState } from 'react'

import { MODEL_DISPLAY_NAME, MODEL_PURPOSE, type ModelID } from '@/engine/types'
import { formatBytes } from '@/lib/format'
import { installedBytes, useStore } from '@/lib/store'
import type { ModelDescriptor } from '@/worker/protocol'
import {
  Button,
  IconCheck,
  IconDownload,
  IconWarning,
  ProgressBar,
  SectionLabel,
  Spinner,
  cx,
} from './ui'

/** Which row, if any, is waiting for a second press. `all` is the whole library. */
type Pending = ModelID | 'all' | null

export function StoragePanel() {
  const manifest = useStore((state) => state.manifest)
  const library = useStore((state) => state.library)
  const onDisk = useStore(installedBytes)
  const libraryBusy = useStore((state) => state.libraryBusy)
  const downloading = useStore((state) => state.library?.isWorking ?? false)
  const rendering = useStore((state) => state.phase.kind === 'rendering')
  const scanning = useStore((state) => state.scanProgress !== null)

  const installModels = useStore((state) => state.installModels)
  const cancelInstall = useStore((state) => state.cancelInstall)
  const removeModels = useStore((state) => state.removeModels)
  const removeAllModels = useStore((state) => state.removeAllModels)

  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<Pending>(null)

  const models = manifest?.models ?? []
  const required = models.filter((model) => model.required)
  const optional = models.filter((model) => !model.required)

  const isInstalled = (model: ModelDescriptor) =>
    library?.states[model.id]?.kind === 'installed'

  const installedOptional = optional.filter(isInstalled)
  const optionalBytes = installedOptional.reduce((total, model) => total + model.bytes, 0)

  // A deletion tears the engine down and builds it again, so it has to wait for
  // whatever is using it. Saying which of those is in the way beats a button
  // that is greyed out for no stated reason.
  const blocked = downloading
    ? 'Not while a download is running.'
    : rendering
      ? 'Not while an export is running.'
      : scanning
        ? 'Not while the target is being scanned.'
        : null
  const disabled = blocked !== null || libraryBusy

  const act = (run: () => Promise<void>) => {
    setPending(null)
    void run()
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <SectionLabel>Storage</SectionLabel>
        <Button
          variant="link"
          onClick={() => {
            setPending(null)
            setOpen((wasOpen) => !wasOpen)
          }}
        >
          {open ? 'Done' : 'Manage'}
        </Button>
      </div>

      <Usage onDisk={onDisk} usageBytes={library?.usageBytes ?? null} />

      {open ? (
        <div className="flex flex-col gap-3">
          {libraryBusy ? (
            <p className="flex items-center gap-2 text-[11.5px] text-ink-400">
              <Spinner className="h-3.5 w-3.5" /> Freeing space…
            </p>
          ) : downloading ? (
            // A top-up started from here keeps its progress here. The setup
            // screen owns the first-run download; this one must not send the
            // user back to it and take their media off the screen with it.
            <div className="flex flex-col gap-1.5">
              <ProgressBar
                fraction={
                  library && library.sessionTotal > 0
                    ? library.sessionReceived / library.sessionTotal
                    : 0
                }
              />
              <div className="flex items-center justify-between text-[11.5px] text-ink-400">
                <span className="tabular-nums">
                  {formatBytes(library?.sessionReceived ?? 0)} of{' '}
                  {formatBytes(library?.sessionTotal ?? 0)}
                </span>
                <Button variant="link" onClick={cancelInstall}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : blocked ? (
            <p className="text-[11.5px] text-ink-400">{blocked}</p>
          ) : null}

          {optionalBytes > 0 ? (
            <div className="rounded-xl bg-accent-600/10 p-3 ring-1 ring-accent-600/25">
              <p className="text-[12.5px] font-medium text-ink-100">
                Free {formatBytes(optionalBytes)} and keep swapping
              </p>
              <p className="mt-1 text-[11.5px] leading-relaxed text-ink-300">
                The extras are quality, not capability. Without them faces are still
                swapped — the result is a little softer and tracking a little less steady.
                Adding them back is another {formatBytes(optionalBytes)} download, whenever
                you want it.
              </p>
              <Button
                size="sm"
                className="mt-2.5"
                disabled={disabled}
                onClick={() =>
                  act(() => removeModels(installedOptional.map((model) => model.id)))
                }
              >
                {installedOptional.length === 1
                  ? `Remove the ${MODEL_DISPLAY_NAME[installedOptional[0].id]}`
                  : 'Remove the quality extras'}
              </Button>
            </div>
          ) : null}

          <Group
            title="Needed to swap"
            hint="Removing any of these stops face swapping until it is downloaded again."
          >
            {required.map((model) => (
              <Row
                key={model.id}
                descriptor={model}
                installed={isInstalled(model)}
                disabled={disabled}
                pending={pending === model.id}
                onRemove={() => setPending(model.id)}
                onDismiss={() => setPending(null)}
                onConfirm={() => act(() => removeModels([model.id]))}
                onInstall={() => act(() => installModels([model.id]))}
              />
            ))}
          </Group>

          <Group
            title="Quality extras"
            hint="Optional. Swapping works without them, at a lower quality."
          >
            {optional.map((model) => (
              <Row
                key={model.id}
                descriptor={model}
                installed={isInstalled(model)}
                disabled={disabled}
                pending={false}
                // Nothing breaks, so nothing is asked. A confirmation here would
                // make the safe half of this screen feel like the risky half.
                onRemove={() => act(() => removeModels([model.id]))}
                onDismiss={() => setPending(null)}
                onConfirm={() => act(() => removeModels([model.id]))}
                onInstall={() => act(() => installModels([model.id]))}
              />
            ))}
          </Group>

          {onDisk > 0 ? (
            pending === 'all' ? (
              <Confirmation
                message={`Frees ${formatBytes(onDisk)}. Nothing can be swapped until the whole library has been downloaded again.`}
                action={`Remove ${formatBytes(onDisk)}`}
                disabled={disabled}
                onConfirm={() => act(() => removeAllModels())}
                onDismiss={() => setPending(null)}
              />
            ) : (
              <Button
                variant="link"
                className="self-start text-ink-400 hover:text-ink-200"
                disabled={disabled}
                onClick={() => setPending('all')}
              >
                Remove everything
              </Button>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

// MARK: - Numbers

/**
 * Two totals that are not the same total, labelled so.
 *
 * The first is the models: the manifest's byte counts, which a file only reads
 * as installed by matching. The second is what the browser says this whole
 * origin is using — a different question with a different answer, and one that
 * lags a deletion and rounds where it likes. Showing either one under the
 * other's name would be a number the user could check and find wrong.
 */
function Usage({ onDisk, usageBytes }: { onDisk: number; usageBytes: number | null }) {
  return (
    <div className="flex flex-col gap-1 text-[11.5px]">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-ink-300">Models on this device</span>
        <span className="tabular-nums text-ink-100">{formatBytes(onDisk)}</span>
      </div>
      {usageBytes === null ? (
        <p className="text-ink-500">
          Your browser will not say how much it is storing for this site in total.
        </p>
      ) : (
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-ink-500">Everything this site stores, as your browser counts it</span>
          <span className="tabular-nums text-ink-400">{formatBytes(usageBytes)}</span>
        </div>
      )}
    </div>
  )
}

// MARK: - Rows

function Group({
  title,
  hint,
  children,
}: {
  title: string
  hint: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div>
        <p className="text-[12px] font-medium text-ink-200">{title}</p>
        <p className="text-[11px] leading-relaxed text-ink-500">{hint}</p>
      </div>
      <ul className="divide-y divide-ink-800 overflow-hidden rounded-xl bg-ink-900/60 ring-1 ring-ink-800">
        {children}
      </ul>
    </div>
  )
}

function Row({
  descriptor,
  installed,
  disabled,
  pending,
  onRemove,
  onConfirm,
  onDismiss,
  onInstall,
}: {
  descriptor: ModelDescriptor
  installed: boolean
  disabled: boolean
  /** True while this row is asking whether it really should go. */
  pending: boolean
  onRemove(): void
  onConfirm(): void
  onDismiss(): void
  onInstall(): void
}) {
  const id = descriptor.id
  return (
    <li className="px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <span className="grid w-4 shrink-0 place-items-center">
          {installed ? (
            <IconCheck className="h-3.5 w-3.5 text-good-500" />
          ) : (
            <IconDownload className="h-3.5 w-3.5 text-ink-500" />
          )}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] text-ink-100">
            {MODEL_DISPLAY_NAME[id]}
          </span>
          <span className="block text-[11px] leading-relaxed text-ink-500">
            {MODEL_PURPOSE[id]}
          </span>
        </span>

        <span
          className={cx(
            'shrink-0 text-[11.5px] tabular-nums',
            installed ? 'text-ink-400' : 'text-ink-500',
          )}
        >
          {formatBytes(descriptor.bytes)}
        </span>

        {installed ? (
          <Button size="sm" variant="ghost" disabled={disabled} onClick={onRemove}>
            Remove
          </Button>
        ) : (
          <Button size="sm" disabled={disabled} onClick={onInstall}>
            Download
          </Button>
        )}
      </div>

      {pending ? (
        <Confirmation
          className="mt-2"
          message="Face swapping stops until this is downloaded again — the studio is replaced by the setup screen while it is missing."
          action={`Remove ${formatBytes(descriptor.bytes)}`}
          disabled={disabled}
          onConfirm={onConfirm}
          onDismiss={onDismiss}
        />
      ) : null}
    </li>
  )
}

/** The second press, and the sentence that earns it. */
function Confirmation({
  message,
  action,
  disabled,
  className,
  onConfirm,
  onDismiss,
}: {
  message: string
  action: string
  disabled: boolean
  className?: string
  onConfirm(): void
  onDismiss(): void
}) {
  return (
    <div
      className={cx(
        'rounded-lg bg-warn-500/10 p-2.5 ring-1 ring-warn-500/25',
        className,
      )}
    >
      <p className="flex items-start gap-2 text-[11.5px] leading-relaxed text-ink-200">
        <IconWarning className="mt-px h-3.5 w-3.5 shrink-0 text-warn-500" />
        <span className="min-w-0">{message}</span>
      </p>
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" disabled={disabled} onClick={onConfirm}>
          {action}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Keep it
        </Button>
      </div>
    </div>
  )
}
