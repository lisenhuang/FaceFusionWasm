/**
 * engine.worker.ts
 *
 * The engine, off the main thread.
 *
 * This is the web counterpart of `FaceFusionEngine.xpc`: it owns the models,
 * performs every inference, and does all video decode and encode. The page owns
 * only the UI and the user's intent.
 *
 * The split earns two things the macOS app also wanted. Half a gigabyte of
 * weights and ~500 ms of compute per frame stay off the thread that has to keep
 * the interface responsive; and because the worker holds the target file
 * directly, an export never sends a frame back to the page.
 *
 * The one thing this worker cannot inherit from its macOS ancestor is a sandbox
 * that *enforces* offline operation. Instead it is confined by construction: the
 * only `fetch` in the worker is in `ModelStore`, and it can only be reached
 * through `installModels`. Nothing on the swap path has any way to send a byte
 * anywhere.
 */

import * as ort from 'onnxruntime-web'

import { FaceClusterer } from '@/engine/clustering'
import { RGBAImage } from '@/engine/image'
import { SwapPipeline } from '@/engine/pipeline'
import { Serializer, makeLoader, type ModelLoader, type OrtNamespace } from '@/engine/runtime'
import {
  type ComputePolicy,
  type EngineFootprint,
  type ModelID,
  REQUIRED_MODELS,
  type SwapOptions,
  EngineError,
} from '@/engine/types'

import { TargetMedia } from './media'
import { ModelStore } from './model-store'
import { REMOVAL_REFUSED } from './protocol'
import type {
  EngineEvent,
  EngineRequest,
  ExportProgress,
  ModelLibraryStatus,
  RequestEnvelope,
  RequestType,
  ResponseEnvelope,
  ScanProgress,
  ScannedPerson,
  TransferableImage,
} from './protocol'

// MARK: - Runtime configuration

// Served from our own origin rather than a CDN, so the page works offline and
// nothing about a session is observable to a third party.
ort.env.wasm.wasmPaths = '/ort/'
// Threads need SharedArrayBuffer, which needs cross-origin isolation. Where the
// headers are missing the runtime still works single-threaded, just slower — so
// this reads the capability rather than assuming it.
ort.env.wasm.numThreads = self.crossOriginIsolated
  ? Math.max(1, Math.min(navigator.hardwareConcurrency ?? 4, 8))
  : 1
ort.env.wasm.proxy = false
ort.env.logLevel = 'error'

// MARK: - State

const post = (message: ResponseEnvelope, transfer: Transferable[] = []) => {
  ;(self as unknown as Worker).postMessage(message, transfer)
}

const emit = (event: EngineEvent) => post({ id: -1, event })

const store = new ModelStore((status) => emit({ kind: 'library', status }))
const pipeline = new SwapPipeline()

let target: TargetMedia | null = null
let loader: ModelLoader | null = null
/** Cancellation, keyed by the request id the page used. */
const inFlight = new Map<number, AbortController>()

/**
 * Requests that are reading the loaded sessions right now.
 *
 * Messages are dispatched as they arrive, so a `removeModel` can land in the
 * middle of a preview swap. Releasing a session out from under a `run` that is
 * already queued behind the serializer is not something ONNX Runtime promises
 * anything about, so a removal waits for these to settle instead of finding out.
 * The long jobs are not in here — they are refused outright, since waiting a
 * whole export out is not waiting, it is hanging.
 */
const usingPipeline = new Set<Promise<unknown>>()

const PIPELINE_REQUESTS: ReadonlySet<RequestType> = new Set<RequestType>([
  'prepare',
  'analyzeSource',
  'detectFaces',
  'analyzeFaces',
  'swapFrame',
  'exportImage',
])

/**
 * Set while the sessions are being released and the files deleted.
 *
 * `usingPipeline` accounts for the work that was already running; this accounts
 * for the work that has not been asked for yet, and the two are not the same
 * problem. The page does stop dispatching on its own — every route into the
 * pipeline is behind an engine state it moves to `preparing` first — but a
 * caller's good behaviour is not a guarantee, and the window is real rather than
 * theoretical: `unloadAll` awaits `release()` on each session in turn, and for
 * the length of that loop the pipeline still reads as prepared while its
 * sessions are going away. A frame arriving in there would run against a session
 * that has already been released. Refusing is the honest answer, and it is one
 * the page already knows how to recover from.
 */
let sessionsLocked = false

// MARK: - Dispatch

self.onmessage = async (event: MessageEvent<RequestEnvelope>) => {
  const { id, request } = event.data
  const work = handle(id, request)
  if (PIPELINE_REQUESTS.has(request.type)) {
    // Tracked as a settled promise: a failed frame still finished with the
    // sessions, and a rejection nobody awaited here would be unhandled.
    const settled = work.then(
      () => undefined,
      () => undefined,
    )
    usingPipeline.add(settled)
    void settled.then(() => usingPipeline.delete(settled))
  }
  try {
    const { value, transfer } = await work
    post({ id, ok: true, value }, transfer ?? [])
  } catch (error) {
    post({ id, ok: false, error: serializeError(error) })
  } finally {
    inFlight.delete(id)
  }
}

async function handle(
  id: number,
  request: EngineRequest,
): Promise<{ value: unknown; transfer?: Transferable[] }> {
  if (sessionsLocked && PIPELINE_REQUESTS.has(request.type)) {
    throw new EngineError('notPrepared', 'the models are being removed')
  }

  switch (request.type) {
    case 'loadManifest':
      return { value: await store.loadManifest() }

    case 'installModels':
      return { value: await store.install(request.ids) }

    case 'cancelInstall':
      return { value: store.cancel() }

    case 'removeModel':
      return { value: await withSessionsReleased(() => store.remove(request.id)) }

    case 'removeAllModels':
      return { value: await withSessionsReleased(() => store.removeAll()) }

    case 'refreshLibrary':
      return { value: await store.refresh() }

    case 'prepare':
      return { value: await prepare(request.compute, request.footprint) }

    case 'analyzeSource':
      return {
        value: await pipeline.analyzeSource(fromTransferable(request.image), request.refineLandmarks),
      }

    case 'clearSource':
      pipeline.clearSource()
      return { value: undefined }

    case 'detectFaces': {
      const analysis = await pipeline.detectFaces(
        fromTransferable(request.image),
        request.detectorScore,
      )
      return { value: { faces: analysis.faces } }
    }

    case 'analyzeFaces': {
      const analysis = await pipeline.analyzeFaces(
        fromTransferable(request.image),
        request.options,
      )
      return { value: { faces: analysis.faces, identities: analysis.identities } }
    }

    case 'setReferenceFaces':
      pipeline.setReferenceFaces(request.set)
      return { value: undefined }

    case 'swapFrame': {
      const input = fromTransferable(request.image)
      // In place: the page keeps its own copy of the untouched frame for the
      // before/after toggle, so a second full-size buffer here would be waste.
      const result = await pipeline.swap(input, input, request.options)
      const image = toTransferable(input)
      return { value: { image, result }, transfer: [image.buffer] }
    }

    case 'setTarget': {
      target?.dispose()
      target = null
      if (!request.file) return { value: null }
      target = await TargetMedia.open(request.file)
      return { value: target.targetInfo }
    }

    case 'targetInfo':
      return { value: target?.targetInfo ?? null }

    case 'frameAt': {
      const media = requireTarget()
      const frame = await media.frame(request.seconds, request.maximumDimension)
      // `frame` may be the still target's own buffer, which must survive being
      // asked for again; a transfer would detach it.
      const image = toTransferable(media.isImage ? frame.clone() : frame)
      return { value: image, transfer: [image.buffer] }
    }

    case 'scanTarget': {
      const controller = new AbortController()
      inFlight.set(id, controller)
      const people = await scanTarget(request.options, controller.signal)
      return {
        value: { people },
        transfer: people
          .map((person) => person.thumbnail?.buffer)
          .filter((buffer): buffer is ArrayBuffer => Boolean(buffer)),
      }
    }

    case 'exportVideo': {
      const controller = new AbortController()
      inFlight.set(id, controller)
      return { value: await exportVideo(request.request, controller.signal) }
    }

    case 'exportImage':
      return { value: await exportImage(request.options) }

    case 'cancel':
      inFlight.get(request.id)?.abort()
      return { value: undefined }
  }
}

// MARK: - Removing models

/**
 * Deletes model files with no session left holding one.
 *
 * The macOS app does the same thing in the same order — `SettingsView` awaits
 * `engine.unloadModels()` before `manager.removeAll()`, on the grounds that a
 * live session has its graphs mapped and deleting the file underneath it leaves
 * it working from a file with no name. Here the sessions are built from a buffer
 * rather than mapped, so the file is not the hazard; what is, is the engine
 * carrying on afterwards with a model the library now says is gone. The optional
 * two are where that bites: the pipeline treats a missing enhancer as "do not
 * enhance", but a *deleted* one whose session is still loaded is not missing, so
 * the app would go on enhancing every frame of an export while the library, the
 * storage panel and the toggle all agreed it had been removed.
 *
 * So both problems get the same answer as macOS: release everything, then
 * delete. The page rebuilds the engine from what is left — which is also the
 * only way the *required* case can be correct, since there is no engine to
 * rebuild until those weights come back.
 */
async function withSessionsReleased(deletion: () => Promise<ModelLibraryStatus>) {
  refuseWhileBusy()
  // Nothing has been released or deleted at this point, so a caller that sees
  // this reject can go on using the engine it already had.
  await Promise.all([...usingPipeline])
  // Waiting is itself a window: a scan can be asked for while a preview swap is
  // being waited out, and that one would still be running when the sessions go.
  refuseWhileBusy()

  sessionsLocked = true
  try {
    await pipeline.unloadAll()
    loader = null
    return await deletion()
  } finally {
    sessionsLocked = false
  }
}

/**
 * The one place a removal is allowed to say no.
 *
 * Every reason lives here rather than being spread down the call, because *when*
 * the refusal happens is load-bearing: `RemovalRefused` promises the page that
 * nothing was released and nothing was deleted, and that promise only holds
 * while this runs ahead of `unloadAll`. `ModelStore` guards the directory again
 * on its own account, but that guard runs after the sessions are gone — a
 * refusal that has already torn the engine down is not a refusal, so the
 * download is caught here too.
 */
function refuseWhileBusy() {
  if (inFlight.size > 0) {
    throw new RemovalRefused(
      'Finish or cancel the job that is running before removing models.',
    )
  }
  if (store.isBusy) {
    throw new RemovalRefused('Finish or cancel the download before removing models.')
  }
}

class RemovalRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RemovalRefused'
  }
}

// MARK: - Preparation

/**
 * Shared session settings.
 *
 * `logSeverityLevel: 3` keeps ORT's native warnings out of the console. Two are
 * expected on every single run — the swapper's dangling `emap` initializer, and
 * shape ops the backend deliberately leaves on the CPU — and a console that
 * always contains errors is one nobody reads when a real error arrives.
 */
const BASE_SESSION_OPTIONS = {
  graphOptimizationLevel: 'all',
  logSeverityLevel: 3,
} as const

/**
 * What the runtime gives up when the last launch did not come back.
 *
 * Both of these trade memory for speed by holding on to what a run allocated:
 * the arena keeps freed blocks rather than returning them, and the pattern
 * planner pre-allocates the shapes a graph is expected to want. On a device that
 * has already failed to load the library at all, that is the wrong side of the
 * trade.
 */
const LEAN_SESSION_OPTIONS = {
  enableCpuMemArena: false,
  enableMemPattern: false,
} as const

async function prepare(compute: ComputePolicy, footprint: EngineFootprint) {
  await store.loadManifest()
  await store.refresh()

  const missing = REQUIRED_MODELS.filter((id) => !store.isInstalled(id))
  if (missing.length > 0) {
    throw new EngineError('modelMissing', `missing: ${missing.join(', ')}`)
  }

  const installed = new Set(store.installedIDs())
  // The two optional models are 438 MB of the 903 MB library, and preparation is
  // where a phone runs out of room. Leaving them on disk rather than in the
  // runtime's heap is the largest thing that can be given up while the app still
  // swaps a face.
  const wanted: Set<ModelID> =
    footprint === 'minimal' ? new Set(REQUIRED_MODELS) : installed

  loader = await makeBestLoader(compute, footprint)

  // Read one model at a time, straight from OPFS into the session builder. The
  // buffer goes out of scope as soon as the session exists, so the peak is one
  // model plus the runtime's copy of it rather than all five at once.
  return pipeline.prepare(loader, async (id) =>
    installed.has(id) && wanted.has(id) ? await store.read(id) : null,
  )
}

/**
 * WebGPU first, WASM as the floor.
 *
 * These graphs are convolutional generators — the same shape of work Core ML
 * places on the GPU on Apple silicon — so WebGPU is worth a real attempt before
 * settling for the CPU backend. A session that fails to build under WebGPU is
 * retried on WASM rather than surfaced, because "slower" is a far better outcome
 * than "does not run".
 */
async function makeBestLoader(
  compute: ComputePolicy,
  footprint: EngineFootprint,
): Promise<ModelLoader> {
  const namespace = ort as unknown as OrtNamespace
  // One queue for every session the app builds, whichever backend they land on:
  // they share a single runtime module, so the turn-taking has to be global.
  const serializer = new Serializer()

  const lean = footprint === 'minimal'
  const sessionOptions = lean
    ? { ...BASE_SESSION_OPTIONS, ...LEAN_SESSION_OPTIONS }
    : BASE_SESSION_OPTIONS

  const wasmLoader = makeLoader(
    namespace,
    { ...sessionOptions, executionProviders: ['wasm'] },
    {
      provider: `${
        (ort.env.wasm.numThreads ?? 1) > 1 ? 'WebAssembly (multi-threaded)' : 'WebAssembly'
      }${lean ? ' · reduced' : ''}`,
      usingGPU: false,
    },
    serializer,
  )
  // A launch that did not survive its last preparation does not get handed the
  // GPU on the way back, whatever it asked for. A weight buffer larger than the
  // adapter will allocate is one of the few things that can take a page down
  // without an error to catch, and the CPU backend is the floor every browser
  // running this app is guaranteed to have. The badge says "reduced" so this is
  // not a silent demotion.
  if (compute === 'wasm' || lean) return wasmLoader
  if (!(await hasWebGPU())) {
    if (compute === 'webgpu') throw new EngineError('modelLoadFailed', 'WebGPU is unavailable')
    return wasmLoader
  }

  const gpuLoader = makeLoader(
    namespace,
    { ...sessionOptions, executionProviders: ['webgpu'] },
    { provider: 'WebGPU', usingGPU: true },
    serializer,
  )

  if (compute === 'webgpu') return gpuLoader

  // 'auto': fall back per-load rather than per-run, so a single unsupported
  // graph does not force the whole pipeline onto the CPU.
  //
  // `provider` is a getter because what to call this is not known until every
  // model has been loaded. Saying "WebGPU" when one graph quietly landed on the
  // CPU would make the badge a worse explanation of a slow export than no badge
  // at all.
  const fellBack: ModelID[] = []
  return {
    get provider() {
      if (fellBack.length === 0) return 'WebGPU'
      return `WebGPU · ${fellBack.join(', ')} on WebAssembly`
    },
    usingGPU: true,
    async load(id, modelBytes, options) {
      try {
        return await gpuLoader.load(id, modelBytes, options)
      } catch {
        fellBack.push(id)
        return wasmLoader.load(id, modelBytes, options)
      }
    },
  }
}

async function hasWebGPU(): Promise<boolean> {
  // Typed structurally rather than against `@webgpu/types`: this is the only
  // WebGPU call the app makes directly — everything else goes through ORT — so a
  // types package for one method would not earn its place.
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
  if (!gpu) return false
  try {
    return (await gpu.requestAdapter()) !== null
  } catch {
    return false
  }
}

// MARK: - Scanning

/**
 * Finds the distinct people in the target so they can be checked off.
 *
 * Grouping is what makes the picker mean anything for a video. A checkbox bound
 * to "the second face in this frame" starts swapping someone else the moment two
 * people cross; a checkbox bound to an identity does not.
 */
async function scanTarget(
  options: Parameters<SwapPipeline['analyzeFaces']>[1],
  signal: AbortSignal,
): Promise<ScannedPerson[]> {
  const media = requireTarget()
  const clusterer = new FaceClusterer()
  const thumbnails = new Map<number, TransferableImage>()

  const totalFrames = media.isImage ? 1 : media.scanTimestamps().length
  let scanned = 0
  const report = (progress: ScanProgress) => emit({ kind: 'scan', progress })
  report({ framesScanned: 0, totalFrames, peopleFound: 0 })

  for await (const { image, seconds } of media.scanFrames(signal)) {
    if (signal.aborted) break
    const analysis = await pipeline.analyzeFaces(image, options)
    const frameArea = image.width * image.height

    if (analysis.identities.length === analysis.faces.length) {
      for (let index = 0; index < analysis.faces.length; index += 1) {
        const face = analysis.faces[index]
        const coverage = frameArea > 0 ? (face.box.width * face.box.height) / frameArea : 0
        const placement = clusterer.add(
          analysis.identities[index],
          seconds,
          face.score,
          coverage,
        )
        // Cutting a thumbnail is cheap, but only worth doing when this is a new
        // person or a better look at a known one — which, after the first few
        // samples, is almost never.
        if (!placement.isNew && !placement.isBestSoFar) continue
        const crop = image.croppedSquare(face.box)
        if (crop) thumbnails.set(placement.id, toTransferable(crop))
      }
    }

    scanned += 1
    report({ framesScanned: scanned, totalFrames, peopleFound: clusterer.count })
  }

  return clusterer.byProminence().map((person) => ({
    id: person.id,
    identity: person.identity,
    thumbnail: thumbnails.get(person.id) ?? null,
    appearances: person.appearances,
    firstSeen: person.firstSeen,
    lastSeen: person.lastSeen,
    coverage: person.largestCoverage,
  }))
}

// MARK: - Export

async function exportVideo(
  request: { options: SwapOptions; useHEVC: boolean },
  signal: AbortSignal,
) {
  const media = requireTarget()
  const started = performance.now()

  const outcome = await media.exportVideo({
    useHEVC: request.useHEVC,
    signal,
    onProgress: (progress: ExportProgress) => emit({ kind: 'export', progress }),
    transform: async (frame) => {
      const result = await pipeline.swap(frame, frame, request.options)
      return { image: frame, facesSwapped: result.facesSwapped }
    },
  })

  return {
    blob: outcome.blob,
    framesWritten: outcome.framesWritten,
    seconds: (performance.now() - started) / 1000,
    notes: outcome.notes,
  }
}

/**
 * The photo path. The frame is swapped again rather than reusing what the
 * preview produced, so the exported file always reflects the settings as they
 * stand now and is written at the image's own resolution.
 */
async function exportImage(options: SwapOptions) {
  const media = requireTarget()
  const frame = (await media.frame(0)).clone()
  const result = await pipeline.swap(frame, frame, options)

  const canvas = new OffscreenCanvas(frame.width, frame.height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('This browser would not provide a 2D canvas.')
  context.putImageData(new ImageData(frame.data, frame.width, frame.height), 0, 0)

  // PNG rather than the original format: a re-encoded JPEG would lose a second
  // generation of detail.
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return { blob, facesSwapped: result.facesSwapped }
}

// MARK: - Helpers

function requireTarget(): TargetMedia {
  if (!target) throw new Error('No target has been chosen.')
  return target
}

function fromTransferable(image: TransferableImage): RGBAImage {
  return new RGBAImage(image.width, image.height, new Uint8ClampedArray(image.buffer))
}

function toTransferable(image: RGBAImage): TransferableImage {
  // `data` may be a view onto a larger buffer, in which case the buffer alone is
  // not the image.
  const exact =
    image.data.byteOffset === 0 && image.data.byteLength === image.data.buffer.byteLength
      ? (image.data.buffer as ArrayBuffer)
      : (image.data.slice().buffer as ArrayBuffer)
  return { width: image.width, height: image.height, buffer: exact }
}

function serializeError(error: unknown) {
  if (error instanceof RemovalRefused) {
    return { message: error.message, code: REMOVAL_REFUSED }
  }
  if (error instanceof EngineError) {
    return { message: error.message, code: error.code, detail: error.detail }
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return { message: 'Cancelled.', code: 'cancelled' }
  }
  if (error instanceof Error) return { message: error.message }
  return { message: String(error) }
}
