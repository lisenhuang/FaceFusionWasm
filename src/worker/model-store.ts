/**
 * model-store.ts
 *
 * The on-device model library: what is installed, what is missing, and the
 * one-time download that closes the gap.
 *
 * Files live in the Origin Private File System. OPFS is the only browser storage
 * that takes a 340 MB write without holding it in memory first, and it is
 * origin-scoped, so the weights are as private as anything else the page owns.
 *
 * Downloads stream to a `.partial` file and resume with a Range request if they
 * are interrupted. Every byte is fed through SHA-256 *as it arrives*, so
 * verification costs no second pass and no second copy — which matters when the
 * device is a phone and the file is a third of a gigabyte. A model that fails
 * verification is discarded rather than installed.
 *
 * This is the only component in the app that touches the network at all. Once
 * these files are on disk, nothing else ever leaves the device.
 */

import { Sha256 } from '@/engine/sha256'
import type { ModelID } from '@/engine/types'
import type {
  ModelDescriptor,
  ModelInstallState,
  ModelLibraryStatus,
  ModelManifest,
} from './protocol'

const MODELS_DIRECTORY = 'models'

export class ModelStore {
  private manifest: ModelManifest | null = null
  private states = new Map<string, ModelInstallState>()
  private sessionReceived = 0
  private sessionTotal = 0
  private working = false
  private abort: AbortController | null = null
  private readonly onChange: (status: ModelLibraryStatus) => void

  constructor(onChange: (status: ModelLibraryStatus) => void) {
    this.onChange = onChange
  }

  // MARK: - Manifest

  async loadManifest(): Promise<ModelManifest> {
    if (this.manifest) return this.manifest
    const response = await fetch('/models.json', { cache: 'no-cache' })
    if (!response.ok) {
      throw new Error(`The model manifest could not be read (HTTP ${response.status}).`)
    }
    this.manifest = (await response.json()) as ModelManifest
    await this.refresh()
    return this.manifest
  }

  descriptors(): ModelDescriptor[] {
    return this.manifest?.models ?? []
  }

  descriptor(id: ModelID): ModelDescriptor | undefined {
    return this.manifest?.models.find((model) => model.id === id)
  }

  // MARK: - Status

  /**
   * Marks a model installed only when the file is present *and* its size
   * matches, so a truncated file is treated as missing rather than trusted.
   */
  async refresh(): Promise<ModelLibraryStatus> {
    const directory = await modelsDirectory()
    for (const descriptor of this.descriptors()) {
      // A download in flight owns its own state; re-deriving it from the file
      // on disk would flicker the row back to "missing" mid-progress.
      const current = this.states.get(descriptor.id)
      if (current?.kind === 'downloading' || current?.kind === 'verifying') continue

      let size = 0
      try {
        const handle = await directory.getFileHandle(fileName(descriptor.id))
        size = (await handle.getFile()).size
      } catch {
        size = 0
      }
      this.states.set(
        descriptor.id,
        size === descriptor.bytes ? { kind: 'installed' } : { kind: 'missing' },
      )
    }
    return this.emit()
  }

  status(): ModelLibraryStatus {
    const states: Record<string, ModelInstallState> = {}
    for (const [id, state] of this.states) states[id] = state
    return {
      states,
      sessionReceived: this.sessionReceived,
      sessionTotal: this.sessionTotal,
      isWorking: this.working,
      usageBytes: this.usageBytes,
      persisted: this.persisted,
    }
  }

  private usageBytes: number | null = null
  private persisted = false

  private emit(): ModelLibraryStatus {
    const status = this.status()
    this.onChange(status)
    return status
  }

  isInstalled(id: ModelID): boolean {
    return this.states.get(id)?.kind === 'installed'
  }

  installedIDs(): ModelID[] {
    return this.descriptors()
      .filter((descriptor) => this.isInstalled(descriptor.id))
      .map((descriptor) => descriptor.id)
  }

  /** True once every required model is present — the point at which the app works offline. */
  get isReady(): boolean {
    const required = this.descriptors().filter((descriptor) => descriptor.required)
    return required.length > 0 && required.every((descriptor) => this.isInstalled(descriptor.id))
  }

  // MARK: - Reading

  async read(id: ModelID): Promise<Uint8Array | null> {
    const directory = await modelsDirectory()
    try {
      const handle = await directory.getFileHandle(fileName(id))
      const file = await handle.getFile()
      return new Uint8Array(await file.arrayBuffer())
    } catch {
      return null
    }
  }

  // MARK: - Installing

  async install(ids: ModelID[]): Promise<ModelLibraryStatus> {
    if (this.working) return this.status()

    const pending = ids
      .map((id) => this.descriptor(id))
      .filter((descriptor): descriptor is ModelDescriptor => Boolean(descriptor))
      .filter((descriptor) => !this.isInstalled(descriptor.id))
    if (pending.length === 0) return this.status()

    // Asking for persistence before a 465 MB download is the difference between
    // storage the browser may evict under pressure and storage it may not.
    await this.requestPersistence()

    this.working = true
    this.sessionReceived = 0
    this.sessionTotal = pending.reduce((total, descriptor) => total + descriptor.bytes, 0)
    this.abort = new AbortController()
    this.emit()

    try {
      for (const descriptor of pending) {
        if (this.abort.signal.aborted) break
        const baseline = this.sessionReceived
        try {
          await this.download(descriptor, baseline)
          this.states.set(descriptor.id, { kind: 'installed' })
          this.sessionReceived = baseline + descriptor.bytes
        } catch (error) {
          if (this.abort.signal.aborted) {
            this.states.set(descriptor.id, { kind: 'missing' })
            break
          }
          this.states.set(descriptor.id, {
            kind: 'failed',
            message: error instanceof Error ? error.message : String(error),
          })
        }
        this.emit()
      }
    } finally {
      this.working = false
      this.abort = null
      await this.updateUsage()
      await this.refresh()
    }
    return this.status()
  }

  cancel(): ModelLibraryStatus {
    this.abort?.abort()
    this.working = false
    return this.emit()
  }

  async remove(id: ModelID): Promise<ModelLibraryStatus> {
    const directory = await modelsDirectory()
    await directory.removeEntry(fileName(id)).catch(() => {})
    await directory.removeEntry(partialName(id)).catch(() => {})
    this.states.set(id, { kind: 'missing' })
    await this.updateUsage()
    return this.emit()
  }

  // MARK: - Download

  private async download(descriptor: ModelDescriptor, baseline: number) {
    const directory = await modelsDirectory()
    const signal = this.abort?.signal

    const partial = await directory.getFileHandle(partialName(descriptor.id), {
      create: true,
    })

    // A partial file only helps if the server will serve the rest of it *and*
    // we can carry the hash forward. We cannot: SHA-256 state is not
    // reconstructible from a prefix without re-reading it, so a resume re-hashes
    // what is already on disk rather than re-downloading it. That trade is
    // strongly worth it — hashing 200 MB is a couple of seconds, fetching it
    // again is not.
    const existing = await partial.getFile()
    const hasher = new Sha256()
    let received = 0

    if (existing.size > 0 && existing.size < descriptor.bytes) {
      const stream = existing.stream()
      const reader = stream.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        hasher.update(value)
        received += value.length
      }
      this.report(descriptor, received, baseline)
    } else if (existing.size >= descriptor.bytes) {
      // Longer than expected means a previous run wrote something we cannot
      // reason about. Start over rather than try to salvage it.
      received = 0
    }

    const headers: HeadersInit = received > 0 ? { Range: `bytes=${received}-` } : {}
    const response = await fetch(descriptor.url, { headers, signal, mode: 'cors' })

    if (received > 0 && response.status !== 206) {
      // The server ignored the Range request, so the body is the whole file and
      // the bytes already hashed are meaningless.
      return this.downloadFresh(descriptor, baseline, partial, response)
    }
    if (!response.ok) {
      throw new Error(`Download failed (HTTP ${response.status}).`)
    }
    if (!response.body) throw new Error('The download returned no data.')

    // `keepExistingData` plus an explicit offset is what makes this a resume
    // rather than a truncate-and-rewrite.
    const writable = await partial.createWritable({ keepExistingData: received > 0 })
    if (received > 0) await writable.seek(received)

    await this.pump(response.body, writable, hasher, descriptor, baseline, received)
    await this.finish(descriptor, partial, hasher, directory)
  }

  private async downloadFresh(
    descriptor: ModelDescriptor,
    baseline: number,
    partial: FileSystemFileHandle,
    response: Response,
  ) {
    if (!response.ok) throw new Error(`Download failed (HTTP ${response.status}).`)
    if (!response.body) throw new Error('The download returned no data.')
    const hasher = new Sha256()
    const writable = await partial.createWritable({ keepExistingData: false })
    await this.pump(response.body, writable, hasher, descriptor, baseline, 0)
    await this.finish(descriptor, partial, hasher, await modelsDirectory())
  }

  private async pump(
    body: ReadableStream<Uint8Array>,
    writable: FileSystemWritableFileStream,
    hasher: Sha256,
    descriptor: ModelDescriptor,
    baseline: number,
    startAt: number,
  ) {
    const reader = body.getReader()
    let received = startAt
    let lastReport = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (this.abort?.signal.aborted) throw new DOMException('Aborted', 'AbortError')
        hasher.update(value)
        // A fetch body never yields shared memory, so narrowing the buffer type
        // here is safe; `FileSystemWriteChunkType` will not take the wider one.
        await writable.write(value as Uint8Array<ArrayBuffer>)
        received += value.length
        // Reporting every chunk would post thousands of messages a second for
        // no visible benefit.
        if (received - lastReport > 1_000_000) {
          lastReport = received
          this.report(descriptor, received, baseline)
        }
      }
      await writable.close()
    } catch (error) {
      await writable.close().catch(() => {})
      throw error
    }
    this.report(descriptor, received, baseline)
  }

  private async finish(
    descriptor: ModelDescriptor,
    partial: FileSystemFileHandle,
    hasher: Sha256,
    directory: FileSystemDirectoryHandle,
  ) {
    this.states.set(descriptor.id, { kind: 'verifying' })
    this.emit()

    const digest = hasher.digest()
    if (digest !== descriptor.sha256.toLowerCase()) {
      await directory.removeEntry(partialName(descriptor.id)).catch(() => {})
      throw new Error('The downloaded file did not match its checksum and was discarded.')
    }

    const size = (await partial.getFile()).size
    if (size !== descriptor.bytes) {
      await directory.removeEntry(partialName(descriptor.id)).catch(() => {})
      throw new Error(`The download is ${size} bytes, expected ${descriptor.bytes}.`)
    }

    // `move` is a rename: no bytes read, no bytes written. Where it is missing
    // the fallback streams the file into place, which for a 340 MB model is a
    // second full pass over the data — worth avoiding whenever the browser
    // lets us.
    const movable = partial as FileSystemFileHandle & {
      move?: (name: string) => Promise<void>
    }
    if (typeof movable.move === 'function') {
      await directory.removeEntry(fileName(descriptor.id)).catch(() => {})
      await movable.move(fileName(descriptor.id))
      return
    }

    const destination = await directory.getFileHandle(fileName(descriptor.id), {
      create: true,
    })
    const writable = await destination.createWritable({ keepExistingData: false })
    await (await partial.getFile()).stream().pipeTo(writable)
    await directory.removeEntry(partialName(descriptor.id)).catch(() => {})
  }

  private report(descriptor: ModelDescriptor, received: number, baseline: number) {
    this.states.set(descriptor.id, {
      kind: 'downloading',
      received,
      total: descriptor.bytes,
    })
    this.sessionReceived = baseline + received
    this.emit()
  }

  // MARK: - Storage

  private async requestPersistence() {
    try {
      this.persisted =
        (await navigator.storage?.persisted?.()) ||
        (await navigator.storage?.persist?.()) ||
        false
    } catch {
      this.persisted = false
    }
    await this.updateUsage()
  }

  private async updateUsage() {
    try {
      const estimate = await navigator.storage?.estimate?.()
      this.usageBytes = estimate?.usage ?? null
    } catch {
      this.usageBytes = null
    }
  }
}

// MARK: - OPFS helpers

async function modelsDirectory(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory()
  return root.getDirectoryHandle(MODELS_DIRECTORY, { create: true })
}

function fileName(id: string) {
  return `${id}.onnx`
}

function partialName(id: string) {
  return `${id}.onnx.partial`
}
