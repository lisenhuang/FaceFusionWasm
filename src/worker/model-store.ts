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
 * Storage is content-addressed: a model is stored as `<id>-<digest16>.onnx`, so
 * the name of a file states which bytes it is meant to hold. That is what makes
 * "is this installed?" answerable without re-hashing 900 MB at every launch, and
 * it is what keeps one release's weights from being mistaken for another's — the
 * failure the previous size-only check could not see and had no way to recover
 * from.
 *
 * Downloads stream to a `.partial` file and resume with a Range request if they
 * are interrupted. Every byte is fed through SHA-256 *as it arrives*, so
 * verification costs no second pass and no second copy — which matters when the
 * device is a phone and the file is a third of a gigabyte. A model that fails
 * verification is discarded rather than installed.
 *
 * This is the only component in the app that touches the network at all, and it
 * only does so for the weights themselves: the manifest is compiled into this
 * bundle rather than fetched, so the code and the catalogue it reads can never
 * be from two different deploys. Once these files are on disk, nothing else ever
 * leaves the device.
 */

import { Sha256 } from '@/engine/sha256'
import type { ModelID } from '@/engine/types'
import type {
  ModelDescriptor,
  ModelInstallState,
  ModelLibraryStatus,
  ModelManifest,
} from './protocol'

// The manifest is imported, not fetched. A web deploy is instant and reaches
// every client, including tabs that have been open for hours still running the
// previous bundle — and that bundle would then be reading a manifest written for
// code it is not. The worst case was not cosmetic: a manifest that drops an id
// the running bundle still requires leaves that id with no state at all, so the
// library never reads as ready and the user waits on onboarding for a download
// that cannot resolve. Baking the catalogue in removes the skew rather than
// narrowing the window for it. `public/models.json` remains the single copy of
// the data; it is imported from where it is served, not duplicated.
import manifestJSON from '../../public/models.json'

const MANIFEST = manifestJSON as ModelManifest

const MODELS_DIRECTORY = 'models'

/**
 * How much of the digest goes in the filename.
 *
 * Sixteen hex characters is 64 bits. The name is not doing cryptography — the
 * manifest holds the whole digest and every byte written is verified against it
 * — its job is only to tell one generation of a model apart from another, and
 * nothing this project will ever ship comes close to colliding there. Longer
 * names would make the directory unreadable for a person debugging it; shorter
 * ones start to feel like a coincidence waiting to happen.
 */
const DIGEST_PREFIX_LENGTH = 16

/**
 * Where an in-place adoption is recorded — see `adoptLegacyFiles`.
 *
 * Only written on browsers whose OPFS has no rename, which is the one case where
 * a file's own name cannot carry its digest.
 */
const ADOPTION_RECORD = 'adopted.json'

export class ModelStore {
  private manifest: ModelManifest | null = null
  private states = new Map<string, ModelInstallState>()
  private sessionReceived = 0
  private sessionTotal = 0
  private working = false
  /** Set while a deletion owns the directory — see `exclusively`. */
  private removing = false
  private abort: AbortController | null = null
  private readonly onChange: (status: ModelLibraryStatus) => void
  /** Full digest → the name a hash-verified file is kept under, when it is not the digest name. */
  private adopted = new Map<string, string>()
  /** Partial files being written to right now. The sweep must not touch these. */
  private inFlightPartials = new Set<string>()
  /**
   * Legacy files the adoption pass could not settle this session.
   *
   * Adoption deliberately leaves a file alone when it cannot read it or cannot
   * rename it, so that the next launch can try again. That decision is worth
   * nothing if the sweep — which runs seconds later, and by name — deletes it on
   * the grounds that the manifest does not claim that name. Sparing it turns
   * "try again" back into what it says.
   */
  private preserved = new Set<string>()
  /** The one-time open of the library, shared by everything that asks for the manifest. */
  private opening: Promise<ModelManifest> | null = null
  /** The legacy pass, so a refresh landing mid-flight waits for it instead of racing it. */
  private adoption: Promise<void> | null = null

  constructor(onChange: (status: ModelLibraryStatus) => void) {
    this.onChange = onChange
  }

  // MARK: - Manifest

  async loadManifest(): Promise<ModelManifest> {
    // Shared rather than re-entered, and the promise rather than the manifest
    // field: the manifest is known the instant this runs, so anything that
    // checked *that* would be told the library is open while the legacy pass is
    // still half way through renaming it.
    if (!this.opening) {
      this.opening = this.open()
      // A failure is not remembered. Replaying a stored rejection would leave
      // the app permanently unable to read a library that a reload, or the tab
      // that beat this one to a rename, has already put right.
      this.opening.catch(() => {
        this.opening = null
      })
    }
    return this.opening
  }

  /**
   * Everything that has to happen before an install state means anything.
   *
   * Order matters. Adoption has to finish before a single install state is
   * published, or an existing user is told for a few seconds that the 900 MB
   * they already have is missing — and onboarding is not a screen you want a
   * returning user to see even briefly, least of all with a Download button on
   * it.
   */
  private async open(): Promise<ModelManifest> {
    // Both assignments land before this function first suspends, so there is no
    // instant at which the manifest is readable and the pass that is still
    // rearranging the directory is not something a refresh can wait for.
    this.manifest = MANIFEST
    this.adoption = this.migrate()
    await this.adoption
    await this.refreshStates()
    await this.sweep()
    // Asked for here as well as after every install and removal, because the
    // storage panel shows this number to a returning user who has installed
    // nothing this session — and a `usageBytes` of null there would claim the
    // browser refused to answer when nothing had asked it.
    await this.updateUsage()
    return MANIFEST
  }

  /** Reading what was adopted last time, then adopting whatever is left. */
  private async migrate() {
    await this.loadAdoptionRecord()
    await this.adoptLegacyFiles()
  }

  descriptors(): ModelDescriptor[] {
    return this.manifest?.models ?? []
  }

  descriptor(id: ModelID): ModelDescriptor | undefined {
    return this.manifest?.models.find((model) => model.id === id)
  }

  /** The name a descriptor's weights are stored under, once they are installed. */
  private storedName(descriptor: ModelDescriptor): string {
    return this.adopted.get(descriptor.sha256.toLowerCase()) ?? digestName(descriptor)
  }

  // MARK: - Status

  /**
   * Marks a model installed only when the file is present *and* its size
   * matches, so a truncated file is treated as missing rather than trusted.
   *
   * Name plus size is the whole check, deliberately: nothing is ever written to
   * a digest-named path without having been hashed first, so the name is already
   * a statement about the bytes. Re-hashing every model here would add seconds
   * to every launch to re-learn what the directory listing already says.
   */
  async refresh(): Promise<ModelLibraryStatus> {
    // A refresh that lands while the legacy pass is still walking the directory
    // would read names that have not caught up yet and publish "missing" for
    // weights that are on disk under their old one — which is the single
    // outcome this whole change exists to prevent, arrived at by a different
    // road. The page sends this message on its own schedule, so waiting here is
    // the only place the ordering can be enforced.
    if (this.adoption) await this.adoption
    return this.refreshStates()
  }

  private async refreshStates(): Promise<ModelLibraryStatus> {
    const directory = await modelsDirectory()
    for (const descriptor of this.descriptors()) {
      // A download in flight owns its own state; re-deriving it from the file
      // on disk would flicker the row back to "missing" mid-progress.
      const current = this.states.get(descriptor.id)
      if (current?.kind === 'downloading' || current?.kind === 'verifying') continue

      const size = await sizeOf(directory, this.storedName(descriptor))
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

  /**
   * True while a download or a deletion owns the directory.
   *
   * Read by the worker so it can refuse a removal *before* it releases the
   * sessions. `exclusively` asks the same question, but by then the engine is
   * already down and the answer is too late to be a refusal.
   */
  get isBusy(): boolean {
    return this.working || this.removing
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
    const descriptor = this.descriptor(id)
    if (!descriptor) return null
    const directory = await modelsDirectory()
    try {
      const handle = await directory.getFileHandle(this.storedName(descriptor))
      const file = await handle.getFile()
      return new Uint8Array(await file.arrayBuffer())
    } catch {
      return null
    }
  }

  // MARK: - Legacy adoption

  /**
   * Takes ownership of weights stored under the old, digest-less naming scheme.
   *
   * Every user who installed before this scheme existed has roughly 900 MB on
   * disk under `<id>.onnx`. If the app simply started looking for digest-named
   * files, all of it would become invisible in an instant and every one of them
   * would be sent back through onboarding to download files they already have,
   * byte for byte. Preventing exactly that is why this pass exists, and it is the
   * part of this change that must not be skipped.
   *
   * A legacy file is hashed once and then either kept — under its new name, or
   * where it lies if the browser cannot rename — or deleted, which is the first
   * time this app has been able to tell a stale file from a current one at all.
   *
   * Idempotent: after the first pass there is nothing left under the old names,
   * so every later launch walks the manifest and finds nothing to do. It runs in
   * the worker, so the seconds of hashing never reach the page's thread.
   */
  private async adoptLegacyFiles() {
    const directory = await modelsDirectory()
    for (const descriptor of this.descriptors()) {
      const legacy = legacyName(descriptor.id)
      try {
        await this.adopt(directory, descriptor, legacy)
      } catch {
        // One model failing to migrate must not take the launch down with it.
        // The realistic cause is a second tab that got to the same file first,
        // in which case the handle this pass is holding refers to something that
        // no longer exists — a race whose loser has nothing to do but leave the
        // directory to the winner and read it again next time.
        this.preserved.add(legacy)
      }
    }
  }

  /** One descriptor's worth of adoption. Throws only where the caller should give up on it. */
  private async adopt(
    directory: FileSystemDirectoryHandle,
    descriptor: ModelDescriptor,
    legacy: string,
  ) {
    if ((await sizeOf(directory, this.storedName(descriptor))) === descriptor.bytes) return

    const size = await sizeOf(directory, legacy)
    if (size === null) return
    if (size !== descriptor.bytes) {
      // The size-only scheme this replaces would have called this missing too,
      // so nothing that was working stops working; the space is just reclaimed
      // now rather than never.
      await directory.removeEntry(legacy).catch(() => {})
      return
    }

    // Publishing a state here keeps a `refreshLibrary` arriving mid-pass from
    // deriving "missing" from a file whose name has not caught up yet.
    this.states.set(descriptor.id, { kind: 'verifying' })
    this.emit()
    let digest: string
    try {
      digest = await digestOfFile(await directory.getFileHandle(legacy))
    } catch {
      // The file could not be read through. That says nothing about whether it
      // is the right file, so it is left alone to be looked at again next
      // launch rather than deleted on a guess — and the sweep is told the same.
      this.preserved.add(legacy)
      return
    } finally {
      this.states.delete(descriptor.id)
    }

    if (digest !== descriptor.sha256.toLowerCase()) {
      // Right size, wrong bytes: the precise case the old check could not see,
      // and the reason it could serve superseded weights forever with no code
      // path able to discover it.
      await directory.removeEntry(legacy).catch(() => {})
      return
    }

    const handle = await directory.getFileHandle(legacy)
    const movable = handle as FileSystemFileHandle & {
      move?: (name: string) => Promise<void>
    }
    if (typeof movable.move === 'function') {
      // A rename on the same disk: no bytes read, no bytes written, no second
      // 340 MB of space needed to hold a copy while it is made.
      await directory.removeEntry(digestName(descriptor)).catch(() => {})
      await movable.move(digestName(descriptor))
      return
    }

    // No rename primitive in this browser's OPFS. Copying would mean reading
    // and writing 900 MB to end up with the same bytes under a different name,
    // which is the cost this whole pass exists to avoid — so the file stays
    // where it is and the record carries the digest its name cannot.
    this.adopted.set(descriptor.sha256.toLowerCase(), legacy)
    // Written per model rather than once at the end: hashing the next one takes
    // seconds, and a tab closed inside those seconds would otherwise discard the
    // record of everything already adopted and hash all of it again next launch.
    await this.saveAdoptionRecord(directory)
  }

  /**
   * Reads back the in-place adoptions, dropping any that no longer hold.
   *
   * An entry is only honoured when the manifest still asks for that digest and
   * the file is still the right length; anything else is a record of a file that
   * has been removed, replaced or superseded, and keeping it would let the sweep
   * spare bytes nothing needs.
   */
  private async loadAdoptionRecord() {
    const directory = await modelsDirectory()
    this.adopted.clear()
    let raw: string
    try {
      raw = await (await (await directory.getFileHandle(ADOPTION_RECORD)).getFile()).text()
    } catch {
      return
    }

    let entries: Record<string, unknown>
    try {
      entries = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }

    for (const descriptor of this.descriptors()) {
      const digest = descriptor.sha256.toLowerCase()
      const name = entries[digest]
      if (typeof name !== 'string') continue
      if ((await sizeOf(directory, name)) !== descriptor.bytes) continue
      this.adopted.set(digest, name)
    }
  }

  /**
   * Persists the in-place adoptions, and never throws.
   *
   * The record is a cache of work already done, not a source of truth: the map
   * in memory is what this session reads, and the worst a failed write can cost
   * is hashing those files once more on the next launch. Storage being full or
   * the tab losing its lock is not a reason to fail a launch, or a `remove`.
   */
  private async saveAdoptionRecord(directory: FileSystemDirectoryHandle) {
    const entries: Record<string, string> = {}
    for (const [digest, name] of this.adopted) entries[digest] = name
    try {
      const handle = await directory.getFileHandle(ADOPTION_RECORD, { create: true })
      const writable = await handle.createWritable({ keepExistingData: false })
      await writable.write(JSON.stringify(entries))
      await writable.close()
    } catch {
      // Nothing to do about it here, and nothing depends on it having worked.
    }
  }

  // MARK: - Installing

  async install(ids: ModelID[]): Promise<ModelLibraryStatus> {
    // A removal is walking the same directory and is about to publish "missing"
    // for the files it deletes. Downloading into that would have the two passes
    // racing over the same names, and the loser writes a state describing a file
    // the winner has already dealt with.
    if (this.working || this.removing) return this.status()

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
      // The moment a migration completes is the moment the previous generation
      // stops being anybody's only working copy, so this is where the space it
      // occupies is finally reclaimed.
      await this.sweep()
    }
    return this.status()
  }

  cancel(): ModelLibraryStatus {
    this.abort?.abort()
    this.working = false
    return this.emit()
  }

  /**
   * Deletes one model's bytes, in every name they could be under.
   *
   * All of them, not just the one `storedName` points at. A partial from an
   * interrupted download, the legacy file belonging to a user whose weights the
   * adoption pass could not settle, and the digest name — which is *not*
   * `storedName` once a file has been adopted in place, and which nothing else
   * will ever come back for, because the sweep gives up the moment the library
   * is incomplete. A "remove" that leaves 340 MB on disk under a name this pass
   * did not think of and reports it freed is worse than no button at all.
   */
  async remove(id: ModelID): Promise<ModelLibraryStatus> {
    return this.exclusively(async (directory) => {
      const descriptor = this.descriptor(id)
      if (descriptor) {
        await removeNames(directory, [this.storedName(descriptor), digestName(descriptor)])
        if (this.adopted.delete(descriptor.sha256.toLowerCase())) {
          await this.saveAdoptionRecord(directory)
        }
      }
      const legacy = legacyName(id)
      await removeNames(directory, [legacy])
      // Nothing is being kept for a later adoption attempt now that the user has
      // asked for it gone, and leaving the name here would have the sweep spare
      // a file that no longer exists.
      this.preserved.delete(legacy)
      this.states.set(id, { kind: 'missing' })
    })
  }

  /**
   * Empties the directory: every model, and everything else that accumulated
   * beside them.
   *
   * Named first, listed second, and that order is the point. Listing needs
   * `keys()`, which this file already treats as optional because not every OPFS
   * implementation has it — for the sweep its absence only means a directory
   * that grows, but here it would mean deleting *nothing at all* while
   * publishing the whole library as missing. The user would then be sent through
   * a 903 MB download for bytes that never left the disk, which is precisely the
   * lie this screen exists to avoid telling. The names the manifest implies need
   * no listing to be found.
   *
   * The listing is still worth walking afterwards, because it is the only thing
   * that finds what the manifest cannot name: weights from a superseded release,
   * a partial for an id that has since been dropped, the adoption record. Those
   * are exactly the bytes a user asking to reclaim *everything* means.
   */
  async removeAll(): Promise<ModelLibraryStatus> {
    return this.exclusively(async (directory) => {
      for (const descriptor of this.descriptors()) {
        await removeNames(directory, [
          this.storedName(descriptor),
          digestName(descriptor),
          legacyName(descriptor.id),
        ])
      }
      await directory.removeEntry(ADOPTION_RECORD).catch(() => {})

      for (const name of await entryNames(directory)) {
        await directory.removeEntry(name).catch(() => {})
      }

      this.adopted.clear()
      this.preserved.clear()
      for (const descriptor of this.descriptors()) {
        this.states.set(descriptor.id, { kind: 'missing' })
      }
    })
  }

  /**
   * Runs a deletion with the directory to itself.
   *
   * `install` checks the same flag, so the two can never be half way through
   * each other. Refusing rather than queueing is deliberate: a download that
   * finishes after the user asked for the file to be deleted has spent their
   * bandwidth on bytes they said they did not want.
   */
  private async exclusively(
    task: (directory: FileSystemDirectoryHandle) => Promise<void>,
  ): Promise<ModelLibraryStatus> {
    if (this.working) {
      throw new Error('A download is in progress. Cancel it before removing models.')
    }
    this.removing = true
    try {
      await task(await modelsDirectory())
    } finally {
      this.removing = false
    }
    await this.updateUsage()
    return this.emit()
  }

  // MARK: - Download

  private async download(descriptor: ModelDescriptor, baseline: number) {
    const directory = await modelsDirectory()
    const signal = this.abort?.signal

    // The digest is in the *partial's* name as well, and that is not decoration.
    // A partial left over from an older generation used to be indistinguishable
    // from one belonging to the file now being fetched, so the resume below would
    // splice the head of one release onto the tail of another — a download that
    // can only fail, and only after every byte of it has been paid for. With the
    // digest in the name there is nothing there to resume against.
    const staging = partialName(digestName(descriptor))
    const partial = await directory.getFileHandle(staging, { create: true })
    this.inFlightPartials.add(staging)

    try {
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
        await this.downloadFresh(descriptor, baseline, partial, response)
        return
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
    } finally {
      this.inFlightPartials.delete(staging)
    }
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

    const target = digestName(descriptor)
    const staging = partialName(target)

    const digest = hasher.digest()
    if (digest !== descriptor.sha256.toLowerCase()) {
      await directory.removeEntry(staging).catch(() => {})
      throw new Error('The downloaded file did not match its checksum and was discarded.')
    }

    const size = (await partial.getFile()).size
    if (size !== descriptor.bytes) {
      await directory.removeEntry(staging).catch(() => {})
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
      await directory.removeEntry(target).catch(() => {})
      await movable.move(target)
      return
    }

    const destination = await directory.getFileHandle(target, { create: true })
    const writable = await destination.createWritable({ keepExistingData: false })
    await (await partial.getFile()).stream().pipeTo(writable)
    await directory.removeEntry(staging).catch(() => {})
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

  // MARK: - Sweeping

  /**
   * Deletes everything in the models directory that the current manifest does
   * not claim: previous generations, ids that have been renamed or dropped, and
   * partials nothing is going to finish. Without it those bytes stay for the
   * life of the origin, because nothing else would ever look at them again.
   *
   * Two rules, and both of them are the reason this is safe to run at all:
   *
   *   a) a `.partial` belonging to a download in flight is never touched — it is
   *      being written to as the sweep walks past it;
   *   b) nothing is swept until every required model is present. Half way
   *      through a migration the previous generation is the user's only working
   *      copy, and reclaiming it there would leave them with an app that cannot
   *      run and a 900 MB download to sit through. Deferring the sweep costs
   *      disk for a while; sweeping early costs the user the app.
   *
   * Rule (b) is also most of what a future dual-generation install needs: two
   * generations can share this directory because their names cannot collide, and
   * the old one is not reclaimed until the new one actually works.
   *
   * A legacy file the adoption pass could not settle is spared as well. Adoption
   * leaving it for next launch and the sweep deleting it this launch cannot both
   * be the policy, and of the two only one of them ever costs a re-download.
   */
  private async sweep(): Promise<void> {
    if (!this.isReady) return

    const directory = await modelsDirectory()
    const keep = new Set<string>([ADOPTION_RECORD])
    for (const descriptor of this.descriptors()) {
      keep.add(this.storedName(descriptor))
      // A partial for a model the manifest still asks for is progress, not
      // litter: keeping it is what lets an interrupted optional download pick up
      // where it stopped instead of starting again.
      keep.add(partialName(digestName(descriptor)))
    }

    let removed = false
    for (const name of await entryNames(directory)) {
      if (keep.has(name) || this.inFlightPartials.has(name) || this.preserved.has(name)) continue
      await directory.removeEntry(name).catch(() => {})
      removed = true
    }
    if (removed) await this.updateUsage()
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

/** The name a descriptor's weights live under: the id, its digest, and `.onnx`. */
function digestName(descriptor: ModelDescriptor) {
  return `${descriptor.id}-${descriptor.sha256.toLowerCase().slice(0, DIGEST_PREFIX_LENGTH)}.onnx`
}

function partialName(name: string) {
  return `${name}.partial`
}

/** What a model was called before the name carried its digest. */
function legacyName(id: string) {
  return `${id}.onnx`
}

/**
 * Deletes each name and the partial beside it, and never throws.
 *
 * A name that is not there is the normal case — most of these are alternatives
 * to one another — so "no such file" is not a failure, and one name failing must
 * not leave the rest of a model's bytes on disk.
 */
async function removeNames(directory: FileSystemDirectoryHandle, names: string[]) {
  for (const name of names) {
    await directory.removeEntry(name).catch(() => {})
    await directory.removeEntry(partialName(name)).catch(() => {})
  }
}

/** The size of a file in the directory, or `null` when there is no such file. */
async function sizeOf(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<number | null> {
  try {
    return (await (await directory.getFileHandle(name)).getFile()).size
  } catch {
    return null
  }
}

/**
 * SHA-256 of a stored file, read as a stream.
 *
 * Streamed rather than buffered for the same reason downloads are: a 340 MB
 * `arrayBuffer()` is an allocation a phone will refuse, and the point of the
 * whole adoption pass is that it costs the user nothing.
 */
async function digestOfFile(handle: FileSystemFileHandle): Promise<string> {
  const hasher = new Sha256()
  const reader = (await handle.getFile()).stream().getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    hasher.update(value)
  }
  return hasher.digest()
}

/**
 * Everything in the directory, by name.
 *
 * `keys()` is part of the File System Access API but not of TypeScript's DOM
 * library, and an implementation that lacks it simply cannot be swept — which is
 * a directory that grows, not a broken app, so it is read defensively.
 */
async function entryNames(directory: FileSystemDirectoryHandle): Promise<string[]> {
  const iterable = directory as unknown as { keys?: () => AsyncIterable<string> }
  if (typeof iterable.keys !== 'function') return []
  const names: string[] = []
  for await (const name of iterable.keys()) names.push(name)
  return names
}
