/**
 * protocol.ts
 *
 * The contract between the page and the engine worker.
 *
 * This is the web analogue of the macOS app's XPC boundary, and it exists for
 * the same reason: the models are most of a gigabyte and every frame is hundreds
 * of milliseconds of compute, so none of that can share a thread with the UI.
 *
 * Frames cross as `TransferableImage`, whose buffer is transferred rather than
 * copied — the browser's version of passing an `IOSurface` by reference. A
 * transferred buffer is detached on the sending side, so anything that still
 * needs its pixels must clone before sending.
 *
 * Two things deliberately do *not* cross this boundary:
 *   - model bytes, which the worker reads straight out of OPFS; and
 *   - video frames during an export, which never leave the worker at all.
 */

import type {
  AnalysisOptions,
  ComputePolicy,
  DetectedFace,
  EnginePreparation,
  FaceIdentity,
  ModelID,
  ReferenceFaceSet,
  SourceAnalysis,
  SwapOptions,
  SwapResult,
} from '@/engine/types'

/** An RGBA frame whose buffer is transferred, not copied. */
export interface TransferableImage {
  width: number
  height: number
  buffer: ArrayBuffer
}

// MARK: - Model library

// Deliberately no `vendor` or `license` field. The manifest is served from
// `public/`, so anything in it is a public statement about which models the app
// uses — and no user-facing surface names them. See the root CLAUDE.md.
export interface ModelDescriptor {
  id: ModelID
  url: string
  sha256: string
  bytes: number
  required: boolean
}

export interface ModelManifest {
  manifestVersion: number
  release: string
  note?: string
  models: ModelDescriptor[]
}

export type ModelInstallState =
  | { kind: 'missing' }
  | { kind: 'downloading'; received: number; total: number }
  | { kind: 'verifying' }
  | { kind: 'installed' }
  | { kind: 'failed'; message: string }

export interface ModelLibraryStatus {
  states: Record<string, ModelInstallState>
  /** Bytes moved during the current install, for the aggregate bar. */
  sessionReceived: number
  sessionTotal: number
  isWorking: boolean
  /** Bytes the origin is currently using, when the browser will say. */
  usageBytes: number | null
  persisted: boolean
}

// MARK: - Faces found in a target

/** One person found in the target, ready for the picker. */
export interface ScannedPerson {
  id: number
  identity: FaceIdentity
  /** The clearest look at them found so far. */
  thumbnail: TransferableImage | null
  appearances: number
  firstSeen: number
  lastSeen: number
  coverage: number
}

export interface ScanProgress {
  framesScanned: number
  totalFrames: number
  peopleFound: number
}

// MARK: - Target media

export interface VideoInfo {
  kind: 'video'
  /** Size after the track's rotation metadata is applied. */
  width: number
  height: number
  durationSeconds: number
  frameRate: number
  estimatedFrameCount: number
  hasAudio: boolean
  codecDescription: string
}

export interface ImageInfo {
  kind: 'image'
  width: number
  height: number
  format: string
}

export type TargetInfo = VideoInfo | ImageInfo

// MARK: - Export

export interface ExportProgress {
  framesWritten: number
  totalFrames: number
  framesPerSecond: number
  facesSwappedInLastFrame: number
}

export interface ExportRequest {
  options: SwapOptions
  /** HEVC keeps the file small; H.264 plays everywhere. */
  useHEVC: boolean
}

export interface ExportOutcome {
  blob: Blob
  framesWritten: number
  seconds: number
  /** Set when a request could not be honoured exactly, e.g. audio was dropped. */
  notes: string[]
}

// MARK: - Requests

export type EngineRequest =
  | { type: 'loadManifest' }
  | { type: 'installModels'; ids: ModelID[] }
  | { type: 'cancelInstall' }
  | { type: 'removeModel'; id: ModelID }
  | { type: 'refreshLibrary' }
  | { type: 'prepare'; compute: ComputePolicy }
  | { type: 'analyzeSource'; image: TransferableImage; refineLandmarks: boolean }
  | { type: 'clearSource' }
  | { type: 'detectFaces'; image: TransferableImage; detectorScore: number }
  | { type: 'analyzeFaces'; image: TransferableImage; options: AnalysisOptions }
  | { type: 'setReferenceFaces'; set: ReferenceFaceSet }
  | { type: 'swapFrame'; image: TransferableImage; options: SwapOptions }
  | { type: 'setTarget'; file: File | null }
  | { type: 'targetInfo' }
  | { type: 'frameAt'; seconds: number; maximumDimension?: number }
  | { type: 'scanTarget'; options: AnalysisOptions }
  | { type: 'exportVideo'; request: ExportRequest }
  | { type: 'exportImage'; options: SwapOptions }
  | { type: 'cancel'; id: number }

export type RequestType = EngineRequest['type']

/** What each request resolves to. */
export interface EngineResponses {
  loadManifest: ModelManifest
  installModels: ModelLibraryStatus
  cancelInstall: ModelLibraryStatus
  removeModel: ModelLibraryStatus
  refreshLibrary: ModelLibraryStatus
  prepare: EnginePreparation
  analyzeSource: SourceAnalysis
  clearSource: void
  detectFaces: { faces: DetectedFace[] }
  analyzeFaces: { faces: DetectedFace[]; identities: FaceIdentity[] }
  setReferenceFaces: void
  swapFrame: { image: TransferableImage; result: SwapResult }
  setTarget: TargetInfo | null
  targetInfo: TargetInfo | null
  frameAt: TransferableImage
  scanTarget: { people: ScannedPerson[] }
  exportVideo: ExportOutcome
  exportImage: { blob: Blob; facesSwapped: number }
  cancel: void
}

// MARK: - Events pushed from the worker

export type EngineEvent =
  | { kind: 'library'; status: ModelLibraryStatus }
  | { kind: 'scan'; progress: ScanProgress }
  | { kind: 'export'; progress: ExportProgress }
  | { kind: 'log'; message: string }

// MARK: - Envelopes

export interface RequestEnvelope {
  id: number
  request: EngineRequest
}

export type ResponseEnvelope =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: SerializedError }
  | { id: -1; event: EngineEvent }

export interface SerializedError {
  message: string
  code?: string
  detail?: string
}

export function isEventEnvelope(
  message: ResponseEnvelope,
): message is { id: -1; event: EngineEvent } {
  return message.id === -1
}
