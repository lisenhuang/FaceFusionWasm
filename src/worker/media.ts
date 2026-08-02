/**
 * media.ts
 *
 * Video decode, per-frame processing and encode — the browser's answer to the
 * macOS app's AVFoundation layer, and to FFmpeg before it.
 *
 * Everything here runs inside the worker, on top of WebCodecs. That placement is
 * the important part: during an export a frame is decoded, swapped and encoded
 * without ever crossing back to the page, so a 1080p export moves no pixels
 * through `postMessage` at all.
 *
 * Rotation is baked into the pixels on the way in, exactly as the macOS app
 * does, and the output track is then written with no transform of its own —
 * setting one there would rotate the result twice.
 */

import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  Input,
  type InputAudioTrack,
  type InputVideoTrack,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  VideoSample,
  VideoSampleSink,
  VideoSampleSource,
  type VideoCodec,
  canEncodeVideo,
} from 'mediabunny'

import { RGBAImage } from '@/engine/image'
import type { ExportProgress, TargetInfo, VideoInfo } from './protocol'

/** Long edge the scan decodes to. */
const SCAN_DIMENSION = 1280

/**
 * Roughly one sample a second, capped so a feature-length file costs no more
 * than a short one.
 *
 * The cap is a real limit, not a formality: someone on screen for less than the
 * gap between samples can be missed entirely. That is the price of a scan that
 * finishes, and it is why the picker also offers whoever is in the frame on
 * screen right now.
 */
const MAXIMUM_SCAN_SAMPLES = 48
const MINIMUM_SCAN_INTERVAL = 1

export class TargetMedia {
  readonly file: File
  private input: Input | null = null
  private videoTrack: InputVideoTrack | null = null
  private audioTrack: InputAudioTrack | null = null
  private info: TargetInfo | null = null
  /** A still target is decoded once and held; there is no timeline to seek. */
  private still: RGBAImage | null = null

  private constructor(file: File) {
    this.file = file
  }

  static async open(file: File): Promise<TargetMedia> {
    const media = new TargetMedia(file)
    if (isImageFile(file)) {
      await media.openImage()
    } else {
      await media.openVideo()
    }
    return media
  }

  get targetInfo(): TargetInfo | null {
    return this.info
  }

  get isImage(): boolean {
    return this.info?.kind === 'image'
  }

  get videoInfo(): VideoInfo | null {
    return this.info?.kind === 'video' ? this.info : null
  }

  dispose() {
    this.input?.dispose()
    this.input = null
    this.videoTrack = null
    this.audioTrack = null
    this.still = null
  }

  // MARK: - Opening

  private async openImage() {
    // Full resolution: unlike the source portrait — which only ever feeds a
    // 112px crop — this is what gets written back out, so shrinking it would
    // quietly downgrade the export.
    const bitmap = await createImageBitmap(this.file)
    this.still = drawToImage(bitmap, bitmap.width, bitmap.height)
    bitmap.close()
    this.info = {
      kind: 'image',
      width: this.still.width,
      height: this.still.height,
      format: (this.file.name.split('.').pop() ?? '').toUpperCase() || 'Photo',
    }
  }

  private async openVideo() {
    const input = new Input({ source: new BlobSource(this.file), formats: ALL_FORMATS })
    const videoTrack = await input.getPrimaryVideoTrack()
    if (!videoTrack) {
      input.dispose()
      throw new Error('That file has no video track this browser can read.')
    }
    if (!(await videoTrack.canDecode())) {
      const codec = (await videoTrack.getCodec()) ?? 'unknown'
      input.dispose()
      throw new Error(`This browser cannot decode ${codec.toUpperCase()} video.`)
    }

    this.input = input
    this.videoTrack = videoTrack
    this.audioTrack = await input.getPrimaryAudioTrack()

    const duration = await input.computeDuration()
    const stats = await videoTrack.computePacketStats(60).catch(() => null)
    const frameRate = stats?.averagePacketRate ?? 30
    const codec = (await videoTrack.getCodec()) ?? 'video'

    this.info = {
      kind: 'video',
      width: await videoTrack.getDisplayWidth(),
      height: await videoTrack.getDisplayHeight(),
      durationSeconds: duration,
      frameRate,
      estimatedFrameCount: Math.max(1, Math.round(duration * frameRate)),
      hasAudio: this.audioTrack !== null,
      codecDescription: describeCodec(codec),
    }
  }

  // MARK: - Frames

  /** One upright frame, for the preview canvas. */
  async frame(seconds: number, maximumDimension?: number): Promise<RGBAImage> {
    if (this.still) {
      return maximumDimension ? this.still.restricted(maximumDimension).image : this.still
    }
    const track = this.requireVideo()
    const sink = new VideoSampleSink(track)
    const sample = await sink.getSample(Math.max(0, seconds))
    if (!sample) throw new Error('That moment could not be decoded.')
    try {
      return sampleToImage(sample, maximumDimension)
    } finally {
      sample.close()
    }
  }

  /**
   * Sample points across the duration, offset by half an interval so the scan
   * does not open on a fade-in or a title card.
   */
  scanTimestamps(): number[] {
    const info = this.videoInfo
    if (!info || info.durationSeconds <= 0) return [0]
    const interval = Math.max(info.durationSeconds / MAXIMUM_SCAN_SAMPLES, MINIMUM_SCAN_INTERVAL)
    const times: number[] = []
    let seconds = Math.min(interval / 2, info.durationSeconds / 2)
    while (seconds < info.durationSeconds && times.length < MAXIMUM_SCAN_SAMPLES) {
      times.push(seconds)
      seconds += interval
    }
    return times.length > 0 ? times : [0]
  }

  /**
   * Walks the scan samples. Uses one decoder pass over ordered timestamps rather
   * than a seek per sample, which is most of the difference between a scan that
   * takes seconds and one that takes minutes.
   */
  async *scanFrames(
    signal: AbortSignal,
  ): AsyncGenerator<{ image: RGBAImage; seconds: number }> {
    if (this.still) {
      yield { image: this.still, seconds: 0 }
      return
    }
    const track = this.requireVideo()
    const sink = new VideoSampleSink(track)
    const timestamps = this.scanTimestamps()

    for await (const sample of sink.samplesAtTimestamps(timestamps)) {
      if (signal.aborted) return
      // A seek that fails is one sample lost, not a failed scan — a truncated
      // final GOP should not cost the user everything found in the minutes
      // before it.
      if (!sample) continue
      try {
        yield { image: sampleToImage(sample, SCAN_DIMENSION), seconds: sample.timestamp }
      } finally {
        sample.close()
      }
    }
  }

  // MARK: - Export

  /**
   * Reads every frame, hands it to `transform`, and writes the result.
   *
   * @param transform given an upright frame, returns the frame to encode. It may
   *   return the same object it was handed.
   */
  async exportVideo(options: {
    useHEVC: boolean
    signal: AbortSignal
    transform: (frame: RGBAImage, seconds: number) => Promise<{ image: RGBAImage; facesSwapped: number }>
    onProgress: (progress: ExportProgress) => void
  }): Promise<{ blob: Blob; framesWritten: number; notes: string[] }> {
    const track = this.requireVideo()
    const info = this.videoInfo
    if (!info) throw new Error('The target is not a video.')

    const notes: string[] = []
    const width = evenise(info.width)
    const height = evenise(info.height)

    /**
     * How far the source's timeline starts before zero.
     *
     * AAC carries encoder priming, and MP4 expresses it as a first audio packet
     * with a negative timestamp — a muxer will not accept that. Clamping the
     * audio to zero would fix the error and silently shift the track ~100 ms out
     * of sync with the picture, so the whole timeline is shifted instead and the
     * relationship between the two is preserved.
     */
    const timelineOffset = Math.max(0, -(await this.requireInput().getFirstTimestamp()))

    const codec = await pickVideoCodec(options.useHEVC, width, height, notes)

    // An export must not say what made it, so `setMetadataTags` is never
    // called: mediabunny writes no `udta`/`ilst` unless asked, which leaves the
    // file without a title, an author or a "created with" tag. Adding tags here
    // would put the product's name on a file that travels to people who did not
    // make it.
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target: new BufferTarget(),
    })

    const videoSource = new VideoSampleSource({
      codec,
      quality: QUALITY_HIGH,
      // Roughly two seconds between key frames: scrubbing the result stays
      // responsive without spending the bitrate on constant key frames.
      keyFrameInterval: 2,
      sizeChangeBehavior: 'passThrough',
    })
    // Rotation is already baked into the pixels below, so the track carries no
    // transform of its own.
    output.addVideoTrack(videoSource, { rotation: 0, frameRate: info.frameRate })

    const audio = await this.attachAudioPassthrough(output, notes)

    await output.start()

    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('This browser would not provide a 2D canvas.')

    let framesWritten = 0
    let lastReport = performance.now()
    let framesSinceReport = 0
    let throughput = 0
    let facesInLastFrame = 0
    const started = performance.now()

    // The audio is copied alongside the frames rather than after them. It is
    // pure remuxing, so it costs almost nothing and finishes long before the
    // video does — but leaving it until the end would mean a failure there
    // surfaces only after minutes of work.
    //
    // The rejection is captured rather than left on the promise: if the frame
    // loop throws first, an unhandled audio rejection would land afterwards
    // and be reported instead of the real cause.
    let audioError: unknown = null
    const audioTask = (
      audio ? this.copyAudio(audio, options.signal, timelineOffset) : Promise.resolve()
    ).catch((error: unknown) => {
      audioError = error
    })

    try {
      const sink = new VideoSampleSink(track)
      for await (const sample of sink.samples()) {
        if (options.signal.aborted) throw new DOMException('Aborted', 'AbortError')

        const timestamp = sample.timestamp
        const duration = sample.duration
        let frame: RGBAImage
        try {
          // Drawn into a canvas of the output's exact dimensions. `fill` plus
          // the sample's own rotation gives upright pixels at the size the
          // encoder was configured for, which also absorbs the half-pixel a
          // codec's even-dimension requirement can cost.
          context.clearRect(0, 0, width, height)
          sample.drawWithFit(context, { fit: 'fill', rotation: sample.rotation })
          const data = context.getImageData(0, 0, width, height)
          frame = new RGBAImage(width, height, data.data)
        } finally {
          sample.close()
        }

        const { image, facesSwapped } = await options.transform(frame, timestamp)
        facesInLastFrame = facesSwapped

        // Built straight from the pixel buffer rather than from the canvas: a
        // canvas-backed sample is a live reference, so reusing one canvas for
        // every frame would risk the encoder reading a frame that has already
        // been overwritten.
        const encoded = new VideoSample(image.data, {
          format: 'RGBA',
          codedWidth: image.width,
          codedHeight: image.height,
          timestamp: timestamp + timelineOffset,
          duration: duration > 0 ? duration : 1 / Math.max(info.frameRate, 1),
        })
        try {
          await videoSource.add(encoded)
        } finally {
          encoded.close()
        }

        framesWritten += 1
        framesSinceReport += 1

        const elapsed = (performance.now() - lastReport) / 1000
        if (elapsed >= 0.4) {
          const instantaneous = framesSinceReport / elapsed
          // Smooth the rate so the estimate does not jitter per frame.
          throughput = throughput === 0 ? instantaneous : throughput * 0.7 + instantaneous * 0.3
          lastReport = performance.now()
          framesSinceReport = 0
          options.onProgress({
            framesWritten,
            totalFrames: Math.max(info.estimatedFrameCount, framesWritten),
            framesPerSecond: throughput,
            facesSwappedInLastFrame: facesInLastFrame,
          })
        }
      }

      videoSource.close()
      await audioTask
      if (audioError) throw audioError
      await output.finalize()
    } catch (error) {
      await audioTask
      await output.cancel().catch(() => {})
      throw error
    }

    const buffer = (output.target as BufferTarget).buffer
    if (!buffer) throw new Error('The encoder produced no file.')

    options.onProgress({
      framesWritten,
      totalFrames: Math.max(info.estimatedFrameCount, framesWritten),
      framesPerSecond: framesWritten / Math.max((performance.now() - started) / 1000, 0.001),
      facesSwappedInLastFrame: facesInLastFrame,
    })

    return { blob: new Blob([buffer], { type: 'video/mp4' }), framesWritten, notes }
  }

  /**
   * Carries the original audio track across untouched — no decode, no re-encode,
   * so it costs almost nothing and loses nothing.
   *
   * Returns null when the source has no audio, or when it has audio MP4 cannot
   * hold, which is worth saying out loud rather than discovering on playback.
   */
  private async attachAudioPassthrough(output: Output, notes: string[]) {
    const track = this.audioTrack
    if (!track) return null

    const codec = await track.getCodec()
    if (!codec) {
      notes.push('The audio track was in a format that could not be identified, so it was dropped.')
      return null
    }
    if (!output.format.getSupportedCodecs().includes(codec)) {
      notes.push(`This video's ${codec.toUpperCase()} audio cannot be stored in an MP4, so it was dropped.`)
      return null
    }

    const source = new EncodedAudioPacketSource(codec)
    output.addAudioTrack(source)
    const decoderConfig = await track.getDecoderConfig()
    return { track, source, decoderConfig }
  }

  private async copyAudio(
    audio: NonNullable<Awaited<ReturnType<TargetMedia['attachAudioPassthrough']>>>,
    signal: AbortSignal,
    timelineOffset: number,
  ) {
    const sink = new EncodedPacketSink(audio.track)
    let first = true
    for await (const packet of sink.packets()) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      // Re-timed, not re-encoded: `clone` keeps the same compressed bytes.
      const shifted =
        timelineOffset === 0
          ? packet
          : packet.clone({ timestamp: packet.timestamp + timelineOffset })
      await audio.source.add(
        shifted,
        first && audio.decoderConfig ? { decoderConfig: audio.decoderConfig } : undefined,
      )
      first = false
    }
    audio.source.close()
  }

  private requireVideo(): InputVideoTrack {
    if (!this.videoTrack) throw new Error('The target is not a video.')
    return this.videoTrack
  }

  private requireInput(): Input {
    if (!this.input) throw new Error('The target is not a video.')
    return this.input
  }
}

// MARK: - Codec choice

/**
 * HEVC is not encodable everywhere — Chrome on Windows and most of Linux have no
 * hardware encoder exposed to WebCodecs — so the request is treated as a
 * preference and the fallback is stated rather than silent.
 */
async function pickVideoCodec(
  useHEVC: boolean,
  width: number,
  height: number,
  notes: string[],
): Promise<VideoCodec> {
  const order: VideoCodec[] = useHEVC ? ['hevc', 'avc'] : ['avc', 'hevc']
  for (const codec of order) {
    if (await canEncodeVideo(codec, { width, height })) {
      if (useHEVC && codec !== 'hevc') {
        notes.push('This browser cannot encode HEVC, so the export uses H.264.')
      }
      return codec
    }
  }
  // VP9 in an MP4 is unusual but valid, and beats failing outright.
  if (await canEncodeVideo('vp9', { width, height })) {
    notes.push('This browser encodes neither H.264 nor HEVC, so the export uses VP9.')
    return 'vp9'
  }
  throw new Error('This browser cannot encode video.')
}

// MARK: - Pixels

function sampleToImage(sample: VideoSample, maximumDimension?: number): RGBAImage {
  // `displayWidth`/`displayHeight` are post-rotation, and `drawWithFit` applies
  // the sample's own rotation, so what lands on the canvas is upright.
  const fullWidth = sample.displayWidth
  const fullHeight = sample.displayHeight

  let width = fullWidth
  let height = fullHeight
  if (maximumDimension && (width > maximumDimension || height > maximumDimension)) {
    const scale = Math.min(maximumDimension / width, maximumDimension / height)
    width = Math.max(1, Math.round(width * scale))
    height = Math.max(1, Math.round(height * scale))
  }

  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('This browser would not provide a 2D canvas.')

  sample.drawWithFit(context, { fit: 'fill', rotation: sample.rotation })
  const data = context.getImageData(0, 0, width, height)
  return new RGBAImage(width, height, data.data)
}

function drawToImage(bitmap: ImageBitmap, width: number, height: number): RGBAImage {
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('This browser would not provide a 2D canvas.')
  context.drawImage(bitmap, 0, 0, width, height)
  const data = context.getImageData(0, 0, width, height)
  return new RGBAImage(width, height, data.data)
}

/** H.264 and HEVC both require even dimensions. */
function evenise(value: number): number {
  const rounded = Math.round(value)
  return rounded % 2 === 0 ? rounded : rounded - 1
}

export function isImageFile(file: File): boolean {
  if (file.type) return file.type.startsWith('image/')
  return /\.(png|jpe?g|webp|gif|bmp|avif|heic|heif)$/i.test(file.name)
}

function describeCodec(codec: string): string {
  switch (codec) {
    case 'avc':
      return 'H.264'
    case 'hevc':
      return 'HEVC'
    case 'vp9':
      return 'VP9'
    case 'av1':
      return 'AV1'
    case 'vp8':
      return 'VP8'
    default:
      return codec.toUpperCase()
  }
}
