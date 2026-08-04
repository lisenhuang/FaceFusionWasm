/**
 * store.ts
 *
 * Application state and the actions the UI can take.
 *
 * A direct descendant of the macOS app's `AppModel`: the same three face modes,
 * the same generation-guarded reference set, the same rule that a photo is the
 * video path with one frame. What changed is where the work happens — every
 * action here is a message to the worker rather than a call into an XPC service.
 */

'use client'

import { create } from 'zustand'

import {
  type AnalysisOptions,
  type DetectedFace,
  type EngineFootprint,
  type EnginePreparation,
  type FaceIdentity,
  type FaceSelection,
  type ModelID,
  type SwapOptions,
  defaultFaceMatchDistance,
  identityDistance,
  nearestIdentityDistance,
} from '@/engine/types'
import {
  EngineClient,
  EngineRequestError,
  fromTransferableImage,
  toTransferableImage,
} from './engine-client'
import { REMOVAL_REFUSED } from '@/worker/protocol'
import type {
  EnginePrepareProgress,
  ExportProgress,
  ModelLibraryStatus,
  ModelManifest,
  ScanProgress,
  ScannedPerson,
  TargetInfo,
} from '@/worker/protocol'

/**
 * Long edge the preview is swapped at.
 *
 * The preview exists to judge settings, and on a 4K clip a full-resolution
 * round trip costs seconds per scrub. The export always runs at the file's own
 * resolution, so this bounds the feedback loop and nothing else.
 */
const PREVIEW_DIMENSION = 1920

/**
 * Whether a removal declined to start, as opposed to starting and failing.
 *
 * The difference decides whether the engine the page was holding is still real.
 */
const wasRefused = (error: unknown) =>
  error instanceof EngineRequestError && error.code === REMOVAL_REFUSED

/**
 * Where the last preparation attempt is written down.
 *
 * Loading the library is the one thing this app does that can take the page down
 * with it rather than throw. Hundreds of megabytes of weights land in the
 * runtime's heap over a few seconds, and a browser that will not give up that
 * much memory kills the tab instead of failing a call — there is no rejected
 * promise, no `error` event, nothing to catch, and on iOS the whole studio is
 * replaced by the browser's own "Can't open this page". What the user does next
 * is open it again, which does exactly the same thing.
 *
 * So the attempt is recorded before it starts and cleared when it comes back,
 * whether it succeeded or threw — a thrown error means the page is alive to
 * report it, which is not this. A marker still sitting there at the next launch
 * is a launch that never returned, and the one after it asks for less. A second
 * failure stops asking.
 *
 * `localStorage` for two reasons: it is synchronous, so the write is on disk
 * before the work that might kill the process begins, and it outlives the
 * renderer that wrote it.
 */
const ATTEMPT_KEY = 'morphiqo.engine-attempt'

function lastAttempt(): EngineFootprint | null {
  try {
    const value = localStorage.getItem(ATTEMPT_KEY)
    return value === 'full' || value === 'minimal' ? value : null
  } catch {
    // Storage disabled or partitioned away. Losing the guard means losing the
    // recovery, not the app: without it every launch is simply a full one.
    return null
  }
}

function markAttempt(footprint: EngineFootprint | null) {
  try {
    if (footprint) localStorage.setItem(ATTEMPT_KEY, footprint)
    else localStorage.removeItem(ATTEMPT_KEY)
  } catch {
    // As above.
  }
}

/**
 * What the page says when neither the full library nor the smallest one it can
 * run on survived being loaded.
 *
 * Deliberately about what to do rather than what went wrong: the quality extras
 * are 438 MB of the 903 MB library and removing them is the one lever the user
 * has left.
 */
const OUT_OF_MEMORY_MESSAGE =
  'This device ran out of memory loading the models — twice, the second time with ' +
  'only the essentials. Removing the quality extras in Storage frees the most, but ' +
  'this browser may not have the memory to run the studio at all.'

const ENGINE_STALLED_MESSAGE =
  'The engine stopped responding while loading the models, which is what running ' +
  'out of memory looks like from here. Removing the quality extras in Storage is ' +
  'the largest thing that can be freed.'

/**
 * How long preparation may say nothing before it is presumed dead.
 *
 * Measured between signals, not from the start: every model reports twice, so a
 * phone that needs four minutes for the library still resets this eight times.
 * What it is really waiting out is the longest single session build, because
 * that is the one stretch with nothing to report — hence a threshold generous
 * enough to be embarrassing on a fast machine and still finite on a dead one.
 *
 * The alternative, pinging the worker, does not work here: a worker busy inside
 * a synchronous stretch of WebAssembly does not answer, and cannot be told apart
 * from one the browser has already shut down.
 */
const PREPARE_SILENCE_MS = 120_000

class EngineStalled extends Error {
  constructor() {
    super(ENGINE_STALLED_MESSAGE)
    this.name = 'EngineStalled'
  }
}

export type FaceMode = 'everyFace' | 'oneFace' | 'chosen'

export type EngineState =
  | { kind: 'idle' }
  | { kind: 'preparing'; progress: EnginePrepareProgress | null }
  | { kind: 'ready'; preparation: EnginePreparation }
  | { kind: 'failed'; message: string }

export type Phase =
  | { kind: 'choosingMedia' }
  | { kind: 'ready' }
  | { kind: 'rendering' }
  | { kind: 'finished'; url: string; name: string; notes: string[] }
  | { kind: 'failed'; message: string }

export interface Person extends Omit<ScannedPerson, 'thumbnail'> {
  /** An object URL, so the picker can render it with a plain `<img>`. */
  thumbnailURL: string | null
}

interface State {
  // Models
  manifest: ModelManifest | null
  library: ModelLibraryStatus | null
  modelsReady: boolean
  /** A deletion is in flight. Separate from `library.isWorking`, which is a download. */
  libraryBusy: boolean
  /**
   * The install now running began with the library already complete — so it is a
   * model being added back, not a first run. Recorded when the download starts
   * rather than derived while it runs, because `modelsReady` flips as soon as
   * the required models land and the screen must not change under a download
   * that began before that.
   */
  topUpInstall: boolean

  // Engine
  engine: EngineState

  // Source
  sourceName: string | null
  sourcePreviewURL: string | null
  sourceFace: DetectedFace | null
  sourceFaceCount: number
  sourceBusy: boolean

  // Target
  targetName: string | null
  target: TargetInfo | null
  previewFrame: ImageData | null
  previewResult: ImageData | null
  previewFaces: DetectedFace[]
  previewIdentities: FaceIdentity[]
  previewTime: number
  isPreviewing: boolean
  showsOriginal: boolean

  // Options
  enhanceFace: boolean
  identityStrength: number
  maskBlur: number
  useHEVC: boolean
  faceSelection: FaceSelection
  matchDistance: number

  // Choosing faces
  people: Person[]
  checkedPeople: number[]
  scanProgress: ScanProgress | null
  hasScanned: boolean

  // Job
  phase: Phase
  progress: ExportProgress | null
  statusMessage: string | null
}

interface Actions {
  boot(): Promise<void>
  installModels(ids: ModelID[]): Promise<void>
  cancelInstall(): void
  removeModel(id: ModelID): Promise<void>
  removeModels(ids: ModelID[]): Promise<void>
  removeAllModels(): Promise<void>
  startEngine(): Promise<void>

  chooseSource(file: File): Promise<void>
  clearSource(): void
  chooseTarget(file: File): Promise<void>
  clearTarget(): void
  handleDrop(file: File): Promise<void>

  setPreviewTime(seconds: number): void
  refreshPreview(): Promise<void>
  toggleOriginal(): void
  selectFaceAt(point: { x: number; y: number }): void

  setFaceMode(mode: FaceMode): void
  setIdentityStrength(value: number): void
  setMaskBlur(value: number): void
  setEnhanceFace(value: boolean): void
  setUseHEVC(value: boolean): void
  setMatchDistance(value: number): void
  applyMatchDistance(): Promise<void>

  scanTarget(): void
  cancelScan(): void
  togglePerson(id: number): void
  checkEveryPerson(): void
  uncheckEveryPerson(): void

  exportResult(): Promise<void>
  cancelExport(): void
  dismissResult(): void
}

export type Store = State & Actions

const client = new EngineClient()

// Values that are plumbing rather than state: changing them must never repaint.
let referenceGeneration = 0
/** When preparation last proved it was alive. See `PREPARE_SILENCE_MS`. */
let lastEngineSignal = 0
let previewToken = 0
let previewTimer: ReturnType<typeof setTimeout> | null = null
let scanRequestID: number | null = null
let exportRequestID: number | null = null
let targetIsImage = false

export const useStore = create<Store>()((set, get) => {
  // ---------------------------------------------------------------- helpers

  const swapOptions = (): SwapOptions => {
    const state = get()
    return {
      selection: state.faceSelection,
      identityStrength: state.identityStrength,
      enhanceFace: state.enhanceFace && isUsable(state, 'gfpgan_1.4'),
      enhancementBlend: 0.8,
      maskBlur: state.maskBlur,
      detectorScore: 0.5,
      // Kept on for both source and target. The source identity is encoded once
      // at selection time, so flipping this per job would align the two
      // differently and weaken the match.
      refineLandmarks: true,
    }
  }

  /**
   * Analysis has to align faces exactly the way the swap will. An identity
   * encoded from the detector's raw key points and one encoded from refined
   * landmarks are different vectors, and mixing the two would put a floor under
   * every distance the matcher computes.
   */
  const analysisOptions = (): AnalysisOptions => {
    const options = swapOptions()
    return {
      detectorScore: options.detectorScore,
      refineLandmarks: options.refineLandmarks,
      includeIdentities: true,
    }
  }

  const engineReady = () => get().engine.kind === 'ready'

  const fail = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    set({ statusMessage: message })
  }

  const invalidatePreviewResult = () => set({ previewResult: null, showsOriginal: false })

  const releasePeople = (people: Person[]) => {
    for (const person of people) {
      if (person.thumbnailURL) URL.revokeObjectURL(person.thumbnailURL)
    }
  }

  /**
   * Identities are only meaningful against the target they were collected from,
   * so a new target starts over.
   *
   * Starting over means an empty set under a *new* generation, not leaving the
   * mode. Dropping back to one-face here would mean a new target silently
   * changed what the app is about to do — and since *Choose* is the default, it
   * would be impossible to keep.
   */
  const resetPeople = () => {
    if (scanRequestID !== null) {
      client.cancel(scanRequestID)
      scanRequestID = null
    }
    releasePeople(get().people)
    set({
      people: [],
      checkedPeople: [],
      previewIdentities: [],
      scanProgress: null,
      hasScanned: false,
    })
  }

  /**
   * Sends the checked identities to the engine and points the selection at them.
   *
   * Every push takes a new generation, so a swap that names an older one is
   * refused by the engine rather than run against a set that has moved on.
   */
  const applyCheckedFaces = async () => {
    referenceGeneration += 1
    const generation = referenceGeneration
    const state = get()
    // The mode takes effect even while the engine is still starting, so the
    // segmented control does not silently snap back.
    set({
      faceSelection: {
        kind: 'reference',
        generation,
        maxDistance: state.matchDistance,
      },
    })
    if (!engineReady()) return

    const identities = state.people
      .filter((person) => state.checkedPeople.includes(person.id))
      .map((person) => person.identity)

    try {
      await client.send({ type: 'setReferenceFaces', set: { generation, identities } })
      invalidatePreviewResult()
      await detectPreviewFaces()
      await get().refreshPreview()
    } catch (error) {
      fail(error)
    }
  }

  const detectPreviewFaces = async () => {
    const state = get()
    if (!state.previewFrame || !engineReady()) return
    try {
      // `toTransferableImage` already made a private copy, so handing the
      // buffer over transfers rather than clones it — one copy per call
      // instead of two, which on a 1080p frame is eight megabytes saved.
      const image = toTransferableImage(state.previewFrame)
      if (state.faceSelection.kind === 'reference') {
        const analysis = await client.send(
          { type: 'analyzeFaces', image, options: analysisOptions() },
          [image.buffer],
        )
        set({ previewFaces: analysis.faces, previewIdentities: analysis.identities })
      } else {
        // The overlay only needs boxes here, and the recognizer is a model pass
        // per face — not worth paying on every scrub.
        const analysis = await client.send(
          { type: 'detectFaces', image, detectorScore: 0.5 },
          [image.buffer],
        )
        set({ previewFaces: analysis.faces, previewIdentities: [] })
      }
    } catch {
      set({ previewFaces: [], previewIdentities: [] })
    }
  }

  const loadPreviewFrame = async () => {
    // A photo target has no timeline: its single frame is decoded once, when it
    // is chosen.
    if (!get().target || targetIsImage) return
    try {
      const image = await client.send({
        type: 'frameAt',
        seconds: get().previewTime,
        maximumDimension: PREVIEW_DIMENSION,
      })
      set({ previewFrame: fromTransferableImage(image) })
      invalidatePreviewResult()
      await detectPreviewFaces()
      await get().refreshPreview()
    } catch (error) {
      fail(error)
    }
  }

  const analyzeSource = async () => {
    const state = get()
    if (!state.sourceName || !engineReady()) return
    const pixels = sourcePixels
    if (!pixels) return
    set({ sourceBusy: true })
    try {
      const image = toTransferableImage(pixels)
      const analysis = await client.send(
        { type: 'analyzeSource', image, refineLandmarks: true },
        [image.buffer],
      )
      set({
        sourceFace: analysis.face,
        sourceFaceCount: analysis.faceCount,
        statusMessage: null,
      })
      await get().refreshPreview()
    } catch (error) {
      set({ sourceFace: null, sourceFaceCount: 0 })
      fail(error)
    } finally {
      set({ sourceBusy: false })
    }
  }

  /** Kept outside the store: it is a full-size bitmap, and nothing renders it. */
  let sourcePixels: ImageData | null = null

  /**
   * Rebuilds the engine so its sessions match what is actually on disk.
   *
   * Clearing `sourceFace` first is the whole point, and the macOS app learned it
   * the hard way: new sessions hold no projected source identity, and
   * `startEngine` only re-encodes the portrait when there is no face — so left
   * set, the engine comes back with no source while the sidebar still says "Face
   * ready" and Export is still enabled. The first frame of the next render then
   * fails with "no face was found in the source image", and nothing short of
   * removing and re-adding the photo recovers it.
   */
  /**
   * One preparation attempt, watched for signs of life.
   *
   * The worker is where the weights actually land, and a browser under memory
   * pressure will shut a worker down on its own — without an `error` at the
   * page, which is a `postMessage` whose reply never comes. The page cannot
   * distinguish that from a slow phone by waiting, because waiting is what both
   * look like; it can only distinguish them by what arrives while it waits.
   *
   * So preparation reports per model, and a stretch of silence longer than any
   * single model's build is taken as the worker being gone. The response is to
   * drop it and ask for less, in this session rather than after a reload the
   * user has no reason to think would help.
   */
  const prepareEngine = async (footprint: EngineFootprint): Promise<EnginePreparation> => {
    set({ engine: { kind: 'preparing', progress: null } })
    markAttempt(footprint)
    lastEngineSignal = Date.now()

    let watchdog: ReturnType<typeof setInterval> | null = null
    const stalled = new Promise<never>((_, reject) => {
      watchdog = setInterval(() => {
        if (Date.now() - lastEngineSignal >= PREPARE_SILENCE_MS) reject(new EngineStalled())
      }, 5_000)
    })

    try {
      return await Promise.race([
        client.send({ type: 'prepare', compute: 'auto', footprint }),
        stalled,
      ])
    } catch (error) {
      if (!(error instanceof EngineStalled)) throw error
      // Nothing is coming back from that worker, and it may still be holding
      // most of a gigabyte. Dropping it also rejects the request it was serving,
      // which is what stops the studio waiting for the rest of the session.
      client.terminate(ENGINE_STALLED_MESSAGE)
      if (footprint === 'minimal') throw error
      return prepareEngine('minimal')
    } finally {
      if (watchdog) clearInterval(watchdog)
    }
  }

  const restartEngine = async () => {
    // The library just changed, so what preparation is about to attempt is not
    // what failed last time. Whatever it was told to give up, it gets back — and
    // this is the way out of a refusal: remove the extras, and the engine tries
    // again with the set that is actually left.
    markAttempt(null)
    set({ engine: { kind: 'idle' }, sourceFace: null, sourceFaceCount: 0 })
    invalidatePreviewResult()
    await get().startEngine()
  }

  /**
   * The shared shape of every deletion: stop using the engine, delete, then put
   * the engine back in whatever state the remaining files justify.
   *
   * The worker releases its sessions before it deletes a byte, so from the
   * moment this is sent there is no engine — and the page has to stop asking for
   * work first, or a preview swap dispatched in the meantime meets a pipeline
   * that has been torn down. `preparing` is what does that: every path into the
   * worker's pipeline is behind `engineReady()`, and a cleared source face
   * closes the export.
   *
   * A *refusal* is thrown before the worker releases anything, so the engine it
   * holds is still exactly the one this state described and restoring it costs
   * nothing. Any other failure arrives with the sessions already gone, and there
   * the same restore would be a lie: the badge would read "ready", Export would
   * stay enabled, and every frame would fail against a pipeline that is not
   * there. Only the worker knows which of the two happened, so it says so.
   */
  const deleteModels = async (send: () => Promise<ModelLibraryStatus>) => {
    if (get().libraryBusy || get().library?.isWorking) return
    const previousEngine = get().engine
    const hadSourceFace = Boolean(get().sourceFace)
    set({
      libraryBusy: true,
      engine: { kind: 'preparing', progress: null },
      sourceFace: null,
      sourceFaceCount: 0,
      statusMessage: null,
    })
    invalidatePreviewResult()

    try {
      const library = await send()
      const manifest = get().manifest
      set({ library, modelsReady: requiredInstalled(manifest, library) })
      if (requiredInstalled(manifest, library)) {
        // As in `restartEngine`: a smaller library earns a fresh attempt at it.
        markAttempt(null)
        set({ engine: { kind: 'idle' } })
        await get().startEngine()
      } else {
        // Nothing to rebuild: swapping is off until the missing weights come
        // back, and saying "idle" is the honest version of that. `modelsReady`
        // has already sent the page to the download screen.
        set({ engine: { kind: 'idle' } })
      }
    } catch (error) {
      fail(error)
      if (wasRefused(error)) {
        set({ engine: previousEngine })
        if (hadSourceFace) await analyzeSource()
      } else {
        // The sessions went before this failed, so what is left has to be read
        // off the disk and rebuilt rather than assumed. Whatever the deletion
        // managed before it stopped, this leaves the library saying what is
        // actually there and the engine matching it.
        set({ engine: { kind: 'idle' } })
        try {
          const library = await client.send({ type: 'refreshLibrary' })
          const manifest = get().manifest
          set({ library, modelsReady: requiredInstalled(manifest, library) })
          if (requiredInstalled(manifest, library)) await get().startEngine()
        } catch {
          // Nothing further to try from the page; the message above is what the
          // user has to go on, and `idle` is the honest engine state for it.
        }
      }
    } finally {
      set({ libraryBusy: false })
    }
  }

  // ------------------------------------------------------------- events

  client.subscribe((event) => {
    switch (event.kind) {
      case 'library':
        set({
          library: event.status,
          modelsReady: requiredInstalled(get().manifest, event.status),
        })
        break
      case 'engine':
        // Proof of life first, repaint second: the watchdog is reset even when
        // the page has moved on and there is no `preparing` state to update.
        lastEngineSignal = Date.now()
        if (get().engine.kind === 'preparing') {
          set({ engine: { kind: 'preparing', progress: event.progress } })
        }
        break
      case 'scan':
        set({ scanProgress: event.progress })
        break
      case 'export':
        set({ progress: event.progress })
        break
      case 'log':
        break
    }
  })

  // ------------------------------------------------------------- initial

  return {
    manifest: null,
    library: null,
    modelsReady: false,
    libraryBusy: false,
    topUpInstall: false,
    engine: { kind: 'idle' },

    sourceName: null,
    sourcePreviewURL: null,
    sourceFace: null,
    sourceFaceCount: 0,
    sourceBusy: false,

    targetName: null,
    target: null,
    previewFrame: null,
    previewResult: null,
    previewFaces: [],
    previewIdentities: [],
    previewTime: 0,
    isPreviewing: false,
    showsOriginal: false,

    enhanceFace: true,
    identityStrength: 0.5,
    maskBlur: 0.3,
    useHEVC: true,
    /**
     * *Choose* by default: it is the only mode that names a **person** rather
     * than a position, and so the only one that survives a cut, a crossing, or
     * the subject walking across frame.
     *
     * Generation 0 is deliberately one nobody has pushed, so a swap cannot run
     * against it by accident.
     */
    faceSelection: { kind: 'reference', generation: 0, maxDistance: defaultFaceMatchDistance },
    matchDistance: defaultFaceMatchDistance,

    people: [],
    checkedPeople: [],
    scanProgress: null,
    hasScanned: false,

    phase: { kind: 'choosingMedia' },
    progress: null,
    statusMessage: null,

    // ------------------------------------------------------------- actions

    async boot() {
      try {
        const manifest = await client.send({ type: 'loadManifest' })
        const library = await client.send({ type: 'refreshLibrary' })
        set({ manifest, library, modelsReady: requiredInstalled(manifest, library) })
        // Deliberately not awaited. Loading ~900 MB of weights takes tens of
        // seconds, and waiting for it here would hold the whole app on a
        // splash screen with nothing to look at. The studio is useful before
        // the engine is: media can be chosen, and the badge says what the
        // engine is doing.
        if (requiredInstalled(manifest, library)) void get().startEngine()
      } catch (error) {
        fail(error)
      }
    },

    async installModels(ids) {
      if (get().libraryBusy) return
      set({ topUpInstall: requiredInstalled(get().manifest, get().library) })
      try {
        const library = await client.send({ type: 'installModels', ids })
        const manifest = get().manifest
        set({ library, modelsReady: requiredInstalled(manifest, library), topUpInstall: false })
        // Restarted rather than started, because this is no longer only a
        // first-run path. Re-downloading a model the user removed while the
        // studio is open finds the engine already `ready`, and `startEngine`
        // would return without ever building a session for it — the enhancer
        // toggle would come back enabled over a pipeline that has no enhancer.
        if (requiredInstalled(manifest, library)) await restartEngine()
      } catch (error) {
        set({ topUpInstall: false })
        fail(error)
      }
    },

    cancelInstall() {
      client.send({ type: 'cancelInstall' }).catch(() => {})
    },

    async removeModel(id) {
      await get().removeModels([id])
    },

    /**
     * One deletion for the whole set, so removing the two quality extras costs a
     * single teardown and a single reload rather than one of each per model.
     */
    async removeModels(ids) {
      await deleteModels(async () => {
        let library = get().library
        for (const id of ids) {
          library = await client.send({ type: 'removeModel', id })
        }
        // Only reachable with an empty list, which is not a deletion at all.
        return library ?? (await client.send({ type: 'refreshLibrary' }))
      })
    },

    async removeAllModels() {
      await deleteModels(() => client.send({ type: 'removeAllModels' }))
    },

    async startEngine() {
      if (get().engine.kind === 'preparing' || get().engine.kind === 'ready') return

      // Whatever the previous launch was doing when it disappeared, it was this.
      const previous = lastAttempt()
      if (previous === 'minimal') {
        set({ engine: { kind: 'failed', message: OUT_OF_MEMORY_MESSAGE } })
        return
      }
      const first: EngineFootprint = previous === 'full' ? 'minimal' : 'full'

      try {
        const preparation = await prepareEngine(first)
        markAttempt(null)
        set({ engine: { kind: 'ready', preparation }, statusMessage: null })
        // A source chosen before the engine was up still needs encoding, and a
        // fresh engine holds no reference identities — it dropped them along
        // with the sessions that produced them.
        if (sourcePixels && !get().sourceFace) await analyzeSource()
        if (get().faceSelection.kind === 'reference') await applyCheckedFaces()
        else await detectPreviewFaces()
      } catch (error) {
        if (error instanceof EngineStalled) {
          // The marker is deliberately left where it is. A launch that had to be
          // given up on is not one to repeat at the same size, and this is the
          // same conclusion the localStorage guard reaches after a renderer that
          // never came back — reached here without needing the user to reload.
          set({ engine: { kind: 'failed', message: error.message } })
          return
        }
        // A rejection is not a crash: the page is still here to report it, so the
        // next launch starts from a clean slate rather than inheriting a downgrade
        // for something that had nothing to do with memory.
        markAttempt(null)
        const message = error instanceof Error ? error.message : String(error)
        set({ engine: { kind: 'failed', message } })
      }
    },

    // ----------------------------------------------------------- source

    async chooseSource(file) {
      try {
        const bitmap = await createImageBitmap(file)
        // The source only ever feeds a 112px crop, so a 2048px cap costs
        // nothing and keeps a 48-megapixel photo from being decoded whole.
        const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height))
        const width = Math.max(1, Math.round(bitmap.width * scale))
        const height = Math.max(1, Math.round(bitmap.height * scale))
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (!context) throw new Error('This browser would not provide a 2D canvas.')
        context.drawImage(bitmap, 0, 0, width, height)
        bitmap.close()

        sourcePixels = context.getImageData(0, 0, width, height)

        const previous = get().sourcePreviewURL
        if (previous) URL.revokeObjectURL(previous)

        set({
          sourceName: file.name,
          sourcePreviewURL: URL.createObjectURL(file),
          sourceFace: null,
          sourceFaceCount: 0,
          statusMessage: null,
        })
        invalidatePreviewResult()
        await analyzeSource()
      } catch (error) {
        fail(error)
      }
    },

    clearSource() {
      const previous = get().sourcePreviewURL
      if (previous) URL.revokeObjectURL(previous)
      sourcePixels = null
      set({
        sourceName: null,
        sourcePreviewURL: null,
        sourceFace: null,
        sourceFaceCount: 0,
      })
      invalidatePreviewResult()
      client.send({ type: 'clearSource' }).catch(() => {})
    },

    // ----------------------------------------------------------- target

    async chooseTarget(file) {
      try {
        resetPeople()
        const info = await client.send({ type: 'setTarget', file })
        if (!info) throw new Error('That file could not be read.')

        targetIsImage = info.kind === 'image'
        set({
          targetName: file.name,
          target: info,
          statusMessage: null,
          phase: { kind: 'choosingMedia' },
          previewTime: info.kind === 'video' ? Math.min(1, info.durationSeconds / 4) : 0,
        })

        const image = await client.send({
          type: 'frameAt',
          seconds: get().previewTime,
          maximumDimension: PREVIEW_DIMENSION,
        })
        set({ previewFrame: fromTransferableImage(image) })
        invalidatePreviewResult()

        // A new target means a new (empty) reference set under a new
        // generation, which is what stops the old identities being matched
        // against people who are not in this video.
        if (get().faceSelection.kind === 'reference') {
          await applyCheckedFaces()
          // A photo is one frame, so finding its people is instant and asking
          // for a button press would be ceremony. A video stays deliberate.
          if (targetIsImage) get().scanTarget()
        } else {
          await detectPreviewFaces()
          await get().refreshPreview()
        }
      } catch (error) {
        fail(error)
      }
    },

    clearTarget() {
      resetPeople()
      targetIsImage = false
      set({
        targetName: null,
        target: null,
        previewFrame: null,
        previewFaces: [],
        phase: { kind: 'choosingMedia' },
      })
      invalidatePreviewResult()
      client.send({ type: 'setTarget', file: null }).catch(() => {})
    },

    /**
     * A drop onto the window as a whole, where the file has to speak for itself.
     * Videos are unambiguous; a photo could be either role, so it fills the
     * empty slot and otherwise replaces the face — swapping in a different face
     * is the far more common second move.
     */
    async handleDrop(file) {
      const isImage = file.type.startsWith('image/')
      const isVideo = file.type.startsWith('video/')
      if (isVideo) {
        await get().chooseTarget(file)
      } else if (isImage) {
        if (get().sourceName && !get().target) await get().chooseTarget(file)
        else await get().chooseSource(file)
      } else {
        set({ statusMessage: 'That file type is not supported.' })
      }
    },

    // ---------------------------------------------------------- preview

    /** Debounced so dragging the slider does not queue a decode per pixel of travel. */
    setPreviewTime(seconds) {
      set({ previewTime: seconds })
      if (previewTimer) clearTimeout(previewTimer)
      previewTimer = setTimeout(() => {
        previewTimer = null
        void loadPreviewFrame()
      }, 120)
    },

    /**
     * Runs the swap on just the visible frame. This is the fast feedback loop:
     * it takes about as long as one frame of an export, so settings can be
     * judged before committing to a full render.
     */
    async refreshPreview() {
      const state = get()
      if (!state.sourceFace || !state.previewFrame) return
      if (state.phase.kind === 'rendering' || !engineReady()) return

      previewToken += 1
      const token = previewToken
      set({ isPreviewing: true })
      try {
        const image = toTransferableImage(state.previewFrame)
        const response = await client.send(
          { type: 'swapFrame', image, options: swapOptions() },
          [image.buffer],
        )
        // Superseded by a newer preview: the result is for a frame or a setting
        // the user has already moved past.
        if (token !== previewToken) return
        set({ previewResult: fromTransferableImage(response.image) })
        // Read the phase now rather than from the snapshot taken before the
        // await — an export may have started in the meantime, and writing a
        // stale phase back would erase it.
        if (get().phase.kind === 'choosingMedia') set({ phase: { kind: 'ready' } })
      } catch (error) {
        if (token === previewToken) fail(error)
      } finally {
        if (token === previewToken) set({ isPreviewing: false })
      }
    },

    toggleOriginal() {
      set({ showsOriginal: !get().showsOriginal })
    },

    /**
     * Picks whichever detected face is nearest the click, in normalised
     * coordinates so it survives the canvas being resized.
     *
     * While choosing faces this checks or unchecks whoever was clicked — the
     * same gesture as ticking their thumbnail. A face that matches nobody found
     * so far is added rather than rejected: the scan samples the video, so it
     * can miss someone who is only briefly on screen, and pointing at them is
     * the obvious repair.
     */
    selectFaceAt(point) {
      const state = get()
      if (state.faceSelection.kind !== 'reference') {
        set({ faceSelection: { kind: 'nearestTo', x: point.x, y: point.y } })
        void get().refreshPreview()
        return
      }

      const frame = state.previewFrame
      if (!frame || state.previewIdentities.length !== state.previewFaces.length) return
      if (state.previewFaces.length === 0) return

      const index = nearestFaceIndex(state.previewFaces, {
        x: point.x * frame.width,
        y: point.y * frame.height,
      })
      if (index < 0) return
      const identity = state.previewIdentities[index]

      let nearest: Person | null = null
      let nearestDistance = Number.MAX_VALUE
      for (const person of state.people) {
        const distance = identityDistance(person.identity, identity)
        if (distance < nearestDistance) {
          nearestDistance = distance
          nearest = person
        }
      }

      if (nearest && nearestDistance <= state.matchDistance) {
        get().togglePerson(nearest.id)
        return
      }

      const face = state.previewFaces[index]
      const frameArea = frame.width * frame.height
      const id = state.people.reduce((max, person) => Math.max(max, person.id), -1) + 1
      const thumbnail = cropThumbnail(frame, face.box)

      set({
        people: [
          ...state.people,
          {
            id,
            identity,
            thumbnailURL: thumbnail,
            appearances: 1,
            firstSeen: state.previewTime,
            lastSeen: state.previewTime,
            coverage: frameArea > 0 ? (face.box.width * face.box.height) / frameArea : 0,
          },
        ],
        checkedPeople: [...state.checkedPeople, id],
        hasScanned: true,
      })
      void applyCheckedFaces()
    },

    // ---------------------------------------------------------- options

    setFaceMode(mode) {
      if (mode === 'everyFace') {
        set({ faceSelection: { kind: 'all' }, previewIdentities: [] })
        void detectPreviewFaces().then(() => get().refreshPreview())
      } else if (mode === 'oneFace') {
        // Defaults to the largest face, which is almost always the subject,
        // until the user clicks a different one.
        set({ faceSelection: { kind: 'largest' }, previewIdentities: [] })
        void detectPreviewFaces().then(() => get().refreshPreview())
      } else {
        void (async () => {
          // Entering the mode first, with whatever is checked (nothing, at the
          // start), so the picker appears immediately and can explain itself
          // rather than the segment silently not taking.
          await applyCheckedFaces()
          if (!get().hasScanned && targetIsImage) get().scanTarget()
        })()
      }
    },

    setIdentityStrength(value) {
      set({ identityStrength: value })
    },

    setMaskBlur(value) {
      set({ maskBlur: value })
    },

    setEnhanceFace(value) {
      set({ enhanceFace: value })
      void get().refreshPreview()
    },

    setUseHEVC(value) {
      set({ useHEVC: value })
    },

    setMatchDistance(value) {
      set({ matchDistance: value })
    },

    /**
     * Re-runs the preview against a changed match threshold. Cheap: the
     * identities are already computed, only the comparison changes.
     */
    async applyMatchDistance() {
      const state = get()
      if (state.faceSelection.kind !== 'reference') return
      set({
        faceSelection: { ...state.faceSelection, maxDistance: state.matchDistance },
      })
      await get().refreshPreview()
    },

    // ------------------------------------------------------ choosing faces

    scanTarget() {
      if (!engineReady()) {
        set({ statusMessage: 'The engine is still starting.' })
        return
      }
      if (!get().target || scanRequestID !== null) return

      set({
        statusMessage: null,
        scanProgress: { framesScanned: 0, totalFrames: 1, peopleFound: 0 },
      })

      const { id, done } = client.start({ type: 'scanTarget', options: analysisOptions() })
      scanRequestID = id

      void done
        .then(async ({ people }) => {
          releasePeople(get().people)
          const mapped: Person[] = people.map((person) => ({
            id: person.id,
            identity: person.identity,
            thumbnailURL: person.thumbnail ? imageToObjectURL(person.thumbnail) : null,
            appearances: person.appearances,
            firstSeen: person.firstSeen,
            lastSeen: person.lastSeen,
            coverage: person.coverage,
          }))
          // Nothing checked reads as "replace nobody", which is a baffling
          // thing to land on after a scan. The most prominent person is who a
          // single-face swap would have picked anyway.
          set({
            people: mapped,
            hasScanned: true,
            checkedPeople: mapped.length > 0 ? [mapped[0].id] : [],
            // Cleared here rather than in `finally`: `applyCheckedFaces` waits
            // on a preview swap, and leaving the scanning bar up through it
            // would report the wrong work for a couple of seconds.
            scanProgress: null,
          })
          await applyCheckedFaces()
        })
        .catch((error) => {
          if ((error as { code?: string }).code !== 'cancelled') fail(error)
        })
        .finally(() => {
          scanRequestID = null
          set({ scanProgress: null })
        })
    },

    cancelScan() {
      if (scanRequestID === null) return
      client.cancel(scanRequestID)
      scanRequestID = null
      set({ scanProgress: null })
    },

    togglePerson(id) {
      const checked = get().checkedPeople
      set({
        checkedPeople: checked.includes(id)
          ? checked.filter((other) => other !== id)
          : [...checked, id],
      })
      void applyCheckedFaces()
    },

    checkEveryPerson() {
      set({ checkedPeople: get().people.map((person) => person.id) })
      void applyCheckedFaces()
    },

    uncheckEveryPerson() {
      set({ checkedPeople: [] })
      void applyCheckedFaces()
    },

    // ----------------------------------------------------------- export

    async exportResult() {
      const state = get()
      if (!state.target || !state.sourceFace) return

      const stem = (state.targetName ?? 'export').replace(/\.[^.]+$/, '')
      const isImage = targetIsImage
      const name = `${stem}-faceswap.${isImage ? 'png' : 'mp4'}`

      set({
        phase: { kind: 'rendering' },
        statusMessage: null,
        progress: {
          framesWritten: 0,
          totalFrames: isImage
            ? 1
            : state.target.kind === 'video'
              ? state.target.estimatedFrameCount
              : 1,
          framesPerSecond: 0,
          facesSwappedInLastFrame: 0,
        },
      })

      try {
        if (isImage) {
          const { blob } = await client.send({ type: 'exportImage', options: swapOptions() })
          finishExport(blob, name, [])
        } else {
          const { id, done } = client.start({
            type: 'exportVideo',
            request: { options: swapOptions(), useHEVC: state.useHEVC },
          })
          exportRequestID = id
          const outcome = await done
          finishExport(outcome.blob, name, outcome.notes)
        }
      } catch (error) {
        if ((error as { code?: string }).code === 'cancelled') {
          set({ phase: { kind: 'ready' }, statusMessage: 'Export cancelled.', progress: null })
        } else {
          set({
            phase: {
              kind: 'failed',
              message: error instanceof Error ? error.message : String(error),
            },
          })
        }
      } finally {
        exportRequestID = null
      }

      function finishExport(blob: Blob, fileName: string, notes: string[]) {
        const previous = get().phase
        if (previous.kind === 'finished') URL.revokeObjectURL(previous.url)
        set({
          phase: { kind: 'finished', url: URL.createObjectURL(blob), name: fileName, notes },
        })
      }
    },

    cancelExport() {
      if (exportRequestID === null) return
      client.cancel(exportRequestID)
    },

    dismissResult() {
      const phase = get().phase
      if (phase.kind === 'finished') URL.revokeObjectURL(phase.url)
      set({ phase: { kind: 'ready' }, progress: null })
    },
  }
})

// MARK: - Derived selectors

export function faceMode(selection: FaceSelection): FaceMode {
  switch (selection.kind) {
    case 'all':
      return 'everyFace'
    case 'largest':
    case 'nearestTo':
      return 'oneFace'
    case 'reference':
      return 'chosen'
  }
}

/**
 * Which of `previewFaces` the current settings would replace.
 *
 * The canvas reads this rather than re-deriving the rule, which is the only way
 * the highlight can agree with the swap for `reference` — that case is a question
 * about identity, and a box says nothing about who anyone is.
 *
 * Deliberately *not* usable as a store selector: it returns a fresh `Set` every
 * call, and a selector whose result never compares equal re-renders forever.
 * Callers pass the slices they already subscribe to and memoise the result.
 */
export type SelectionInput = Pick<
  State,
  'faceSelection' | 'previewFaces' | 'previewIdentities' | 'previewFrame' | 'people' | 'checkedPeople'
>

export function selectedFaceIndices(state: SelectionInput): Set<number> {
  const { faceSelection, previewFaces, previewIdentities, previewFrame } = state
  switch (faceSelection.kind) {
    case 'all':
      return new Set(previewFaces.map((face) => face.index))

    case 'largest': {
      let best: DetectedFace | null = null
      for (const face of previewFaces) {
        if (!best || face.box.width * face.box.height > best.box.width * best.box.height) {
          best = face
        }
      }
      return best ? new Set([best.index]) : new Set()
    }

    case 'nearestTo': {
      if (!previewFrame) return new Set()
      const index = nearestFaceIndex(previewFaces, {
        x: faceSelection.x * previewFrame.width,
        y: faceSelection.y * previewFrame.height,
      })
      return index >= 0 ? new Set([previewFaces[index].index]) : new Set()
    }

    case 'reference': {
      if (previewIdentities.length !== previewFaces.length) return new Set()
      const references = state.people
        .filter((person) => state.checkedPeople.includes(person.id))
        .map((person) => person.identity)
      if (references.length === 0) return new Set()

      const matched = new Set<number>()
      for (let index = 0; index < previewFaces.length; index += 1) {
        if (
          nearestIdentityDistance(previewIdentities[index], references) <=
          faceSelection.maxDistance
        ) {
          matched.add(previewFaces[index].index)
        }
      }
      return matched
    }
  }
}

export function isInstalled(state: Pick<Store, 'library'>, id: ModelID): boolean {
  return state.library?.states[id]?.kind === 'installed'
}

/**
 * Whether the engine can actually use a model, as opposed to owning the file.
 *
 * The two came apart when preparation grew a reduced footprint: after a launch
 * that ran out of memory, the optional models stay on disk and are deliberately
 * not loaded. A control gated on the library alone would sit there enabled over
 * a pipeline that has no such session — which is the enhancer toggle claiming to
 * enhance and quietly doing nothing.
 *
 * Before the engine is ready there is nothing better than the library to go on,
 * and saying "installed" there is right: it is what the next preparation will
 * try to load.
 */
export function isUsable(state: Pick<Store, 'library' | 'engine'>, id: ModelID): boolean {
  if (state.engine.kind === 'ready') return state.engine.preparation.loadedModels.includes(id)
  return isInstalled(state, id)
}

/**
 * What the installed models occupy, from the manifest's own byte counts.
 *
 * Exact rather than approximate: a model only reads as installed once the file
 * on disk is that many bytes long, so this is the size of the files themselves —
 * not an estimate, and not the same quantity as the browser's origin-wide
 * `usageBytes`, which counts everything the site stores and rounds as it likes.
 */
export function installedBytes(state: Pick<Store, 'manifest' | 'library'>): number {
  if (!state.manifest) return 0
  return state.manifest.models.reduce(
    (total, model) =>
      state.library?.states[model.id]?.kind === 'installed' ? total + model.bytes : total,
    0,
  )
}

export function canRender(state: Store): boolean {
  if (!state.sourceFace || !state.target || !state.modelsReady) return false
  if (state.phase.kind === 'rendering') return false
  // Rendering a whole video that changes nothing is never what was meant, and
  // the mistake is expensive enough to be worth blocking.
  if (state.faceSelection.kind === 'reference' && state.checkedPeople.length === 0) return false
  return true
}

// MARK: - Small helpers

function requiredInstalled(
  manifest: ModelManifest | null,
  library: ModelLibraryStatus | null,
): boolean {
  if (!manifest || !library) return false
  const required = manifest.models.filter((model) => model.required)
  return (
    required.length > 0 &&
    required.every((model) => library.states[model.id]?.kind === 'installed')
  )
}

/** Index into `faces` of the face whose centre is closest to a point in frame pixels. */
function nearestFaceIndex(
  faces: readonly DetectedFace[],
  point: { x: number; y: number },
): number {
  let best = -1
  let bestDistance = Number.MAX_VALUE
  faces.forEach((face, index) => {
    const distance = Math.hypot(
      face.box.x + face.box.width / 2 - point.x,
      face.box.y + face.box.height / 2 - point.y,
    )
    if (distance < bestDistance) {
      bestDistance = distance
      best = index
    }
  })
  return best
}

function imageToObjectURL(image: {
  width: number
  height: number
  buffer: ArrayBuffer
}): string | null {
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const context = canvas.getContext('2d')
  if (!context) return null
  context.putImageData(
    new ImageData(new Uint8ClampedArray(image.buffer), image.width, image.height),
    0,
    0,
  )
  return canvas.toDataURL('image/png')
}

/**
 * A padded square around a face, for a person added by clicking the preview.
 *
 * Square because a grid of detector boxes — taller than they are wide, by
 * varying amounts — reads as a mess; padded because a face cropped at the jaw is
 * hard to recognise.
 */
function cropThumbnail(
  frame: ImageData,
  box: { x: number; y: number; width: number; height: number },
): string | null {
  const padding = 0.3
  const centerX = box.x + box.width / 2
  const centerY = box.y + box.height / 2
  const side = Math.max(box.width, box.height) * (1 + padding * 2)

  const x1 = Math.max(0, Math.round(centerX - side / 2))
  const y1 = Math.max(0, Math.round(centerY - side / 2))
  const x2 = Math.min(frame.width, Math.round(centerX + side / 2))
  const y2 = Math.min(frame.height, Math.round(centerY + side / 2))
  if (x2 - x1 < 16 || y2 - y1 < 16) return null

  const source = document.createElement('canvas')
  source.width = frame.width
  source.height = frame.height
  const sourceContext = source.getContext('2d')
  if (!sourceContext) return null
  sourceContext.putImageData(frame, 0, 0)

  const canvas = document.createElement('canvas')
  canvas.width = x2 - x1
  canvas.height = y2 - y1
  const context = canvas.getContext('2d')
  if (!context) return null
  context.drawImage(source, x1, y1, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/png')
}
