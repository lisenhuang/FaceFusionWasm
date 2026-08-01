/**
 * pipeline.ts
 *
 * Owns the loaded models and runs one frame end to end:
 *
 *     detect -> refine landmarks -> align -> swap -> feather -> paste
 *                                                            -> restore
 *
 * Deliberately free of any browser API. It is handed a `ModelLoader` and raw
 * model bytes, and works on `RGBAImage`, so the same code runs inside the worker
 * and inside the Node verification harness.
 */

import { type FaceObservation, FaceDetector } from './detector'
import { FaceEnhancer } from './enhancer'
import {
  type Point,
  fivePointsFrom68,
  rectArea,
  rectMidX,
  rectMidY,
} from './geometry'
import type { RGBAImage } from './image'
import { FaceLandmarker } from './landmarker'
import { boxMask } from './masker'
import { type FaceEmbedding, FaceRecognizer } from './recognizer'
import type { ModelLoader, ORTModel } from './runtime'
import { FaceSwapper, SWAPPER_INPUT_SIZE } from './swapper'
import {
  type AnalysisOptions,
  type DetectedFace,
  type EnginePreparation,
  type FaceSelection,
  type FrameAnalysis,
  type ModelID,
  ModelRole,
  REQUIRED_MODELS,
  type ReferenceFaceSet,
  type SourceAnalysis,
  type StageSeconds,
  type SwapOptions,
  type SwapResult,
  emptyStages,
  engineError,
  nearestIdentityDistance,
} from './types'

/**
 * Supplies a model's bytes on demand, or null when it is not installed.
 *
 * A function rather than a map so the caller can read one model at a time.
 * Holding all five at once costs ~900 MB of JS heap *on top of* the copy the
 * runtime makes as it builds each session, and on a phone that difference
 * decides whether the app starts at all.
 */
export type ModelSource = (id: ModelID) => Promise<Uint8Array | null>

/** Convenience for callers that already hold the bytes, such as the harness. */
export function modelSourceFrom(bytes: Partial<Record<ModelID, Uint8Array>>): ModelSource {
  return async (id) => bytes[id] ?? null
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

export class SwapPipeline {
  private loader: ModelLoader | null = null
  private sessions = new Map<ModelID, ORTModel>()

  private detector: FaceDetector | null = null
  private landmarker: FaceLandmarker | null = null
  private recognizer: FaceRecognizer | null = null
  private swapper: FaceSwapper | null = null
  private enhancer: FaceEnhancer | null = null

  /**
   * Identity of the user's chosen source face, projected into the swapper's
   * conditioning space once and reused for every frame.
   */
  private projectedSource: Float32Array | null = null

  /**
   * Identities of the faces the user checked in the picker. Set once per change,
   * read by every frame — see `setReferenceFaces`.
   */
  private referenceFaces: ReferenceFaceSet | null = null

  // MARK: - Lifecycle

  async prepare(loader: ModelLoader, source: ModelSource): Promise<EnginePreparation> {
    const started = now()
    const warnings: string[] = []

    await this.unloadAll()
    this.loader = loader

    // The swapper is the one model whose bytes are needed twice: once to build
    // the session, and once to read `emap` out of the file. It is also the
    // largest required model, so the projection is extracted immediately and the
    // buffer dropped rather than held for the rest of preparation.
    let swapper: FaceSwapper | null = null

    for (const id of REQUIRED_MODELS) {
      const bytes = await source(id)
      if (!bytes) throw engineError('modelMissing', `no bytes for ${id}`)
      const session = await loader.load(id, bytes, freeDimensionsFor(id))
      this.sessions.set(id, session)
      if (id === ModelRole.faceSwapper) swapper = FaceSwapper.create(session, bytes)
    }

    // Optional models: absence degrades quality, not correctness.
    for (const id of [ModelRole.faceLandmarker, ModelRole.faceEnhancer] as ModelID[]) {
      const bytes = await source(id)
      if (!bytes) continue
      try {
        this.sessions.set(id, await loader.load(id, bytes, freeDimensionsFor(id)))
      } catch (cause) {
        warnings.push(
          `${id} could not be loaded and was skipped: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        )
      }
    }

    const detectorModel = this.sessions.get(ModelRole.faceDetector)
    const recognizerModel = this.sessions.get(ModelRole.faceRecognizer)
    if (!detectorModel || !recognizerModel || !swapper) {
      throw engineError('modelLoadFailed', 'core models unavailable')
    }

    this.detector = new FaceDetector(detectorModel)
    this.recognizer = new FaceRecognizer(recognizerModel)
    this.swapper = swapper

    const landmarkerModel = this.sessions.get(ModelRole.faceLandmarker)
    this.landmarker = landmarkerModel ? new FaceLandmarker(landmarkerModel) : null
    const enhancerModel = this.sessions.get(ModelRole.faceEnhancer)
    this.enhancer = enhancerModel ? new FaceEnhancer(enhancerModel) : null

    return {
      loadedModels: [...this.sessions.keys()],
      usingGPU: loader.usingGPU,
      executionProvider: loader.provider,
      warmupSeconds: (now() - started) / 1000,
      warnings,
    }
  }

  async unloadAll(): Promise<void> {
    for (const session of this.sessions.values()) {
      try {
        await session.release()
      } catch {
        // A session that will not release is being torn down anyway.
      }
    }
    this.sessions.clear()
    this.detector = null
    this.landmarker = null
    this.recognizer = null
    this.swapper = null
    this.enhancer = null
    this.projectedSource = null
    // Reference identities came out of the old recognizer session; keeping them
    // would compare vectors from two different graphs.
    this.referenceFaces = null
    this.loader = null
  }

  get isPrepared(): boolean {
    return this.detector !== null && this.recognizer !== null && this.swapper !== null
  }

  get hasEnhancer(): boolean {
    return this.enhancer !== null
  }

  get hasSource(): boolean {
    return this.projectedSource !== null
  }

  // MARK: - Chosen faces

  /** Replaces the identities that `reference` selection matches against. */
  setReferenceFaces(set: ReferenceFaceSet): void {
    this.referenceFaces = set
  }

  // MARK: - Source

  /**
   * @param refineLandmarks must match the setting used for target frames —
   *   aligning the source and target differently shifts the identity vector away
   *   from what the swapper was trained on.
   */
  async analyzeSource(image: RGBAImage, refineLandmarks = true): Promise<SourceAnalysis> {
    const { detector, recognizer, swapper } = this.requireCore()

    const faces = await detector.detect(image, 0.5)
    const best = largest(faces)
    if (!best) {
      this.projectedSource = null
      throw engineError('noSourceFace')
    }

    const landmarks = await this.refinedLandmarks(best, image, refineLandmarks)
    const embedding = await recognizer.embedding(image, landmarks)

    this.projectedSource = swapper.projectSource(embedding)

    return { face: describe(best, 0, landmarks), faceCount: faces.length }
  }

  /** The projected source identity, exposed so tests can compare it to reference. */
  debugConditioningVector(): Float32Array | null {
    return this.projectedSource
  }

  clearSource(): void {
    this.projectedSource = null
  }

  // MARK: - Analysis

  async detectFaces(image: RGBAImage, scoreThreshold = 0.5): Promise<FrameAnalysis> {
    const { detector } = this.requireCore()
    const faces = (await detector.detect(image, scoreThreshold)).sort(
      (a, b) => a.box.x - b.box.x,
    )
    return {
      faces: faces.map((face, index) => describe(face, index, face.landmarks)),
      identities: [],
    }
  }

  /**
   * Detection plus an identity per face, for the scan that populates the face
   * picker.
   *
   * The alignment settings have to be the caller's swap settings: an identity
   * encoded from the detector's raw key points and one encoded from refined
   * landmarks are not the same vector, and comparing across the two would put a
   * floor under every distance.
   */
  async analyzeFaces(image: RGBAImage, options: AnalysisOptions): Promise<FrameAnalysis> {
    const { detector, recognizer } = this.requireCore()
    const faces = (await detector.detect(image, options.detectorScore)).sort(
      (a, b) => a.box.x - b.box.x,
    )

    const described: DetectedFace[] = []
    const identities: FrameAnalysis['identities'] = []

    for (const face of faces) {
      const landmarks = await this.refinedLandmarks(face, image, options.refineLandmarks)
      if (options.includeIdentities) {
        let embedding: FaceEmbedding
        try {
          embedding = await recognizer.embedding(image, landmarks)
        } catch {
          // A face the recognizer cannot encode is one the picker could never
          // match again, so leave it out entirely rather than offer a checkbox
          // that does nothing.
          continue
        }
        identities.push({ vector: embedding.normalized })
      }
      // Numbered over what survives, so `faces` and `identities` stay
      // index-for-index parallel for the caller.
      described.push(describe(face, described.length, landmarks))
    }

    return { faces: described, identities }
  }

  // MARK: - Swapping

  /**
   * Swaps every chosen face in `input`, writing into `output`.
   *
   * `output` may be the same object as `input`; when it is not, the frame is
   * copied first so untouched pixels carry through.
   */
  async swap(
    input: RGBAImage,
    output: RGBAImage,
    options: SwapOptions,
  ): Promise<SwapResult> {
    const { detector, recognizer, swapper } = this.requireCore()
    const projectedSource = this.projectedSource
    if (!projectedSource) throw engineError('noSourceFace')

    const started = now()
    if (output !== input) input.copyContentsInto(output)

    const timing = emptyStages()
    const detectStarted = now()
    const detected = (await detector.detect(input, options.detectorScore)).sort(
      (a, b) => a.box.x - b.box.x,
    )
    timing.detect = (now() - detectStarted) / 1000

    const chosen = await this.resolve(detected, input, options, timing)
    if (chosen.length === 0) {
      timing.total = (now() - started) / 1000
      return {
        facesFound: detected.length,
        facesSwapped: 0,
        inferenceSeconds: timing.total,
        stages: timing,
      }
    }

    const needsTarget = FaceSwapper.needsTargetEmbedding(options.identityStrength)
    const swappedLandmarks: Point[][] = []

    for (const candidate of chosen) {
      const { landmarks } = candidate

      // Only pay for the target identity pass when it will actually be mixed in
      // — and never twice, since matching by identity has already encoded this
      // face.
      let targetEmbedding: FaceEmbedding | null = null
      if (needsTarget) {
        targetEmbedding = candidate.identity
        if (!targetEmbedding) {
          try {
            targetEmbedding = await recognizer.embedding(input, landmarks)
          } catch {
            targetEmbedding = null
          }
        }
      }

      const conditioning = swapper.blend(
        projectedSource,
        targetEmbedding,
        options.identityStrength,
      )

      const swapStarted = now()
      const { crop, transform } = await swapper.swap(input, landmarks, conditioning)
      timing.swap += (now() - swapStarted) / 1000

      const pasteStarted = now()
      const mask = boxMask(SWAPPER_INPUT_SIZE, options.maskBlur)
      output.pasteBack(crop, mask, transform)
      timing.paste += (now() - pasteStarted) / 1000
      swappedLandmarks.push(landmarks)
    }

    // Restoration runs over the composited frame so it can smooth the seam as
    // well as sharpen the face.
    if (options.enhanceFace && this.enhancer) {
      const enhanceStarted = now()
      for (const landmarks of swappedLandmarks) {
        try {
          await this.enhancer.enhance(
            output,
            landmarks,
            options.maskBlur,
            options.enhancementBlend,
          )
        } catch {
          // A restoration that fails leaves a swapped-but-soft face, which is a
          // far better outcome than dropping the frame.
        }
      }
      timing.enhance = (now() - enhanceStarted) / 1000
    }

    timing.total = (now() - started) / 1000

    return {
      facesFound: detected.length,
      facesSwapped: chosen.length,
      inferenceSeconds: timing.total,
      stages: timing,
    }
  }

  // MARK: - Helpers

  private requireCore() {
    const { detector, recognizer, swapper } = this
    if (!detector || !recognizer || !swapper) throw engineError('notPrepared')
    return { detector, recognizer, swapper }
  }

  /**
   * Narrows the frame's detections to the faces that should be replaced.
   *
   * Split out from `swap` because `reference` is a different shape of decision
   * from the others: the geometric selections read boxes and are free, while
   * matching by identity has to align and encode every detection before it knows
   * which ones the user meant.
   */
  private async resolve(
    detected: readonly FaceObservation[],
    image: RGBAImage,
    options: SwapOptions,
    timing: StageSeconds,
  ): Promise<Candidate[]> {
    if (options.selection.kind !== 'reference') {
      const landmarkStarted = now()
      const selected = selectGeometrically(
        detected,
        options.selection,
        image.width,
        image.height,
      )
      const chosen: Candidate[] = []
      for (const face of selected) {
        chosen.push({
          face,
          landmarks: await this.refinedLandmarks(face, image, options.refineLandmarks),
          identity: null,
        })
      }
      timing.landmarks = (now() - landmarkStarted) / 1000
      return chosen
    }

    const { recognizer } = this.requireCore()
    const { generation, maxDistance } = options.selection

    // Refusing beats guessing. A generation the engine does not hold means the
    // app and the engine disagree about which faces were checked, and swapping
    // the wrong person is worse than failing the frame.
    const references = this.referenceFaces
    if (!references || references.generation !== generation) {
      throw engineError(
        'referenceFacesStale',
        `asked for generation ${generation}, holding ${references?.generation ?? 'none'}`,
      )
    }
    if (references.identities.length === 0) return []

    const chosen: Candidate[] = []
    for (const face of detected) {
      const landmarkStarted = now()
      const landmarks = await this.refinedLandmarks(face, image, options.refineLandmarks)
      timing.landmarks += (now() - landmarkStarted) / 1000

      const matchStarted = now()
      let embedding: FaceEmbedding | null = null
      try {
        embedding = await recognizer.embedding(image, landmarks)
      } catch {
        embedding = null
      }
      const distance = embedding
        ? nearestIdentityDistance({ vector: embedding.normalized }, references.identities)
        : Number.MAX_VALUE
      timing.match += (now() - matchStarted) / 1000

      if (distance > maxDistance) continue
      chosen.push({ face, landmarks, identity: embedding })
    }
    return chosen
  }

  /**
   * Upgrades the detector's five coarse points to the five derived from 68
   * landmarks, when the landmarker is loaded and confident.
   */
  private async refinedLandmarks(
    face: FaceObservation,
    image: RGBAImage,
    refine: boolean,
  ): Promise<Point[]> {
    if (!refine || !this.landmarker) return face.landmarks
    try {
      const result = await this.landmarker.landmarks(image, face.box)
      // Below this the 68-point fit is less trustworthy than the detector's own
      // key points.
      if (result.score < 0.5 || result.landmarks68.length < 68) return face.landmarks
      return fivePointsFrom68(result.landmarks68)
    } catch {
      return face.landmarks
    }
  }
}

/**
 * A face that is going to be swapped, with the work done to choose it carried
 * along so none of it is repeated.
 */
interface Candidate {
  face: FaceObservation
  landmarks: Point[]
  /**
   * Present only when this face was chosen by identity, in which case the
   * recognizer has already run over it.
   */
  identity: FaceEmbedding | null
}

function largest(faces: readonly FaceObservation[]): FaceObservation | null {
  let best: FaceObservation | null = null
  let bestArea = -Infinity
  for (const face of faces) {
    const area = rectArea(face.box)
    if (area > bestArea) {
      bestArea = area
      best = face
    }
  }
  return best
}

function selectGeometrically(
  faces: readonly FaceObservation[],
  selection: FaceSelection,
  frameWidth: number,
  frameHeight: number,
): FaceObservation[] {
  switch (selection.kind) {
    case 'all':
      return [...faces]
    case 'largest': {
      const best = largest(faces)
      return best ? [best] : []
    }
    case 'nearestTo': {
      const pointX = selection.x * frameWidth
      const pointY = selection.y * frameHeight
      let nearest: FaceObservation | null = null
      let bestDistance = Infinity
      for (const face of faces) {
        const distance = Math.hypot(
          rectMidX(face.box) - pointX,
          rectMidY(face.box) - pointY,
        )
        if (distance < bestDistance) {
          bestDistance = distance
          nearest = face
        }
      }
      return nearest ? [nearest] : []
    }
    case 'reference':
      // Answered by `resolve`, which has the recognizer and the pixels. Boxes
      // alone cannot say who anyone is, and quietly returning every face here
      // would replace the whole frame.
      return []
  }
}

function describe(
  face: FaceObservation,
  index: number,
  landmarks: readonly Point[],
): DetectedFace {
  return {
    index,
    box: { ...face.box },
    score: face.score,
    landmarks: landmarks.map((point) => [point.x, point.y] as [number, number]),
  }
}

function freeDimensionsFor(id: ModelID) {
  // ArcFace declares a symbolic batch dimension. Pinning it to one lets the
  // backend plan for a fixed shape instead of re-planning per call.
  if (id === ModelRole.faceRecognizer) {
    return { freeDimensionOverrides: { None: 1, batch: 1, batch_size: 1 } }
  }
  return undefined
}
