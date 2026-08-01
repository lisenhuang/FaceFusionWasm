/**
 * types.ts
 *
 * The engine's vocabulary: what a face is, which ones to replace, and what the
 * caller gets back. Everything here crosses the worker boundary as a structured
 * clone, so it is all plain data.
 */

// MARK: - Model catalogue

/** The models the engine knows how to load. Ids match the FaceFusion asset file stems. */
export const MODEL_IDS = [
  'yoloface_8n',
  '2dfan4',
  'arcface_w600k_r50',
  'inswapper_128_fp16',
  'gfpgan_1.4',
] as const

export type ModelID = (typeof MODEL_IDS)[number]

export const ModelRole = {
  faceDetector: 'yoloface_8n',
  faceLandmarker: '2dfan4',
  faceRecognizer: 'arcface_w600k_r50',
  faceSwapper: 'inswapper_128_fp16',
  faceEnhancer: 'gfpgan_1.4',
} as const satisfies Record<string, ModelID>

/** Models without which no swap can run at all. */
export const REQUIRED_MODELS: ModelID[] = [
  ModelRole.faceDetector,
  ModelRole.faceRecognizer,
  ModelRole.faceSwapper,
]

export const MODEL_DISPLAY_NAME: Record<ModelID, string> = {
  yoloface_8n: 'Face Detector',
  '2dfan4': 'Landmark Refiner',
  arcface_w600k_r50: 'Identity Encoder',
  inswapper_128_fp16: 'Face Swapper',
  'gfpgan_1.4': 'Face Enhancer',
}

export const MODEL_PURPOSE: Record<ModelID, string> = {
  yoloface_8n: 'Finds faces and their five key points in every frame.',
  '2dfan4': 'Refines alignment with 68 landmarks for a steadier result.',
  arcface_w600k_r50: 'Encodes the identity of your source face.',
  inswapper_128_fp16: 'Performs the actual face replacement.',
  'gfpgan_1.4': 'Restores detail and sharpness in the swapped face.',
}

// MARK: - Compute

/**
 * Where inference runs. `webgpu` is the browser's analogue of Core ML here:
 * the graphs are convolutional generators, which is exactly what a GPU wants.
 */
export type ComputePolicy = 'auto' | 'webgpu' | 'wasm'

export interface EnginePreparation {
  loadedModels: ModelID[]
  /** True when WebGPU accepted the graphs; false means the WASM CPU backend. */
  usingGPU: boolean
  executionProvider: string
  warmupSeconds: number
  /** Non-fatal problems worth surfacing, e.g. an optional model that failed. */
  warnings: string[]
}

// MARK: - Faces

export interface FaceBox {
  x: number
  y: number
  width: number
  height: number
}

export interface DetectedFace {
  /** Stable within one frame: index in detection order (left to right). */
  index: number
  box: FaceBox
  score: number
  /** Five key points in image pixels: left eye, right eye, nose, mouth L, mouth R. */
  landmarks: [number, number][]
}

export interface FrameAnalysis {
  faces: DetectedFace[]
  /**
   * Parallel to `faces`, and empty unless the caller asked for identities.
   * The per-frame overlay does not need them; the "who is in this video" scan
   * does, and paying for them there only is the difference between one extra
   * model pass per face and none.
   */
  identities: FaceIdentity[]
}

/**
 * What `analyzeFaces` should do beyond detecting. Alignment has to match the
 * settings the swap will run with, or the identities compared at swap time are
 * not the ones the picker collected.
 */
export interface AnalysisOptions {
  detectorScore: number
  refineLandmarks: boolean
  /** Skips the recognizer when only boxes are wanted. */
  includeIdentities: boolean
}

export const defaultAnalysisOptions: AnalysisOptions = {
  detectorScore: 0.5,
  refineLandmarks: true,
  includeIdentities: true,
}

// MARK: - Identity

/**
 * An L2-normalised ArcFace vector — the same 512 numbers the swapper is
 * conditioned on, reused here for a different purpose: deciding whether two
 * faces in different frames are the same person.
 */
export interface FaceIdentity {
  vector: Float32Array
}

/**
 * Cosine distance: 0 for identical, 1 for unrelated, 2 for opposite. Both
 * operands are already unit length, so the dot product *is* the cosine and no
 * division is needed.
 *
 * For scale, with this model two photos of one person typically land between
 * 0.2 and 0.5, and two different people above 0.7.
 *
 * Vectors of different lengths came from different models, so they are reported
 * as unmatchable rather than compared over their common prefix — a truncated
 * dot product looks like a perfectly ordinary distance.
 */
export function identityDistance(a: FaceIdentity, b: FaceIdentity): number {
  if (a.vector.length === 0 || a.vector.length !== b.vector.length) {
    return Number.MAX_VALUE
  }
  let dot = 0
  for (let i = 0; i < a.vector.length; i += 1) dot += a.vector[i] * b.vector[i]
  return 1 - dot
}

/** Nearest distance to any of `others`, or infinity when there are none. */
export function nearestIdentityDistance(
  identity: FaceIdentity,
  others: readonly FaceIdentity[],
): number {
  let best = Number.MAX_VALUE
  for (const other of others) best = Math.min(best, identityDistance(identity, other))
  return best
}

/**
 * The identities of the faces the user checked.
 *
 * Sent to the engine once per change rather than riding in `SwapOptions`, which
 * is re-sent for every frame. `generation` rises on each send, and a swap naming
 * a generation the engine no longer holds is refused rather than quietly
 * swapping against a stale set.
 */
export interface ReferenceFaceSet {
  generation: number
  identities: FaceIdentity[]
}

export interface SourceAnalysis {
  face: DetectedFace | null
  faceCount: number
}

// MARK: - Swapping

/**
 * Which face(s) in the target frame get replaced.
 *
 * `reference` is the only selection that means the same thing throughout a
 * video. An index is left-to-right order within a single frame, so two people
 * crossing reassigns it; a fixed point stops naming anyone as soon as the
 * subject moves. An identity keeps pointing at the person.
 */
export type FaceSelection =
  | { kind: 'all' }
  | { kind: 'largest' }
  /** Nearest to a point in normalised (0…1) frame coordinates. */
  | { kind: 'nearestTo'; x: number; y: number }
  | { kind: 'reference'; generation: number; maxDistance: number }

/**
 * Default cosine distance for calling two faces the same person.
 *
 * Mirrors FaceFusion's `reference_face_distance`. Loose enough to hold a person
 * across a turn of the head or a change of lighting, tight enough to keep two
 * different people apart.
 */
export const defaultFaceMatchDistance = 0.6

export interface SwapOptions {
  selection: FaceSelection
  /**
   * 0 keeps more of the target's identity, 1 pushes fully to the source.
   * Mirrors FaceFusion's `face_swapper_weight`.
   */
  identityStrength: number
  enhanceFace: boolean
  /** 0…1, how much of the enhanced face is blended back in. */
  enhancementBlend: number
  /** Feathering of the paste-back mask. Mirrors `face_mask_blur`. */
  maskBlur: number
  /** Minimum detector confidence. */
  detectorScore: number
  /** Use the 68-point landmarker to refine alignment when available. */
  refineLandmarks: boolean
}

export const defaultSwapOptions: SwapOptions = {
  selection: { kind: 'all' },
  identityStrength: 0.5,
  enhanceFace: true,
  enhancementBlend: 0.8,
  maskBlur: 0.3,
  detectorScore: 0.5,
  refineLandmarks: true,
}

/** Per-stage cost of one frame, in seconds. */
export interface StageSeconds {
  detect: number
  landmarks: number
  /** Recognising which detections are the checked faces. Zero except for `reference`. */
  match: number
  swap: number
  paste: number
  enhance: number
  total: number
}

export function emptyStages(): StageSeconds {
  return { detect: 0, landmarks: 0, match: 0, swap: 0, paste: 0, enhance: 0, total: 0 }
}

export interface SwapResult {
  facesFound: number
  facesSwapped: number
  inferenceSeconds: number
  stages: StageSeconds
}

// MARK: - Errors

export type EngineErrorCode =
  | 'modelMissing'
  | 'modelLoadFailed'
  | 'noSourceFace'
  | 'inferenceFailed'
  | 'notPrepared'
  | 'cancelled'
  | 'referenceFacesStale'

const ENGINE_ERROR_MESSAGE: Record<EngineErrorCode, string> = {
  modelMissing: 'A required AI model is missing. Install the models again to continue.',
  modelLoadFailed: 'A model could not be loaded. The file may be incomplete.',
  noSourceFace:
    'No face was found in the source image. Try a clearer, front-facing photo.',
  inferenceFailed: 'The engine failed while processing a frame.',
  notPrepared: 'The engine has not finished loading its models.',
  cancelled: 'Cancelled.',
  referenceFacesStale:
    'The chosen faces are no longer loaded. Scan the target again and reselect them.',
}

export class EngineError extends Error {
  readonly code: EngineErrorCode
  readonly detail?: string

  constructor(code: EngineErrorCode, detail?: string) {
    super(ENGINE_ERROR_MESSAGE[code])
    this.name = 'EngineError'
    this.code = code
    this.detail = detail
  }
}

export function engineError(code: EngineErrorCode, detail?: string): EngineError {
  return new EngineError(code, detail)
}
