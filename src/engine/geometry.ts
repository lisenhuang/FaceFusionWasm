/**
 * geometry.ts
 *
 * Face alignment maths.
 *
 * Every model in the pipeline expects a face cropped and rotated into a
 * canonical pose. The canonical poses are five key points ("warp templates")
 * expressed in units of the crop size, and the mapping onto them is a
 * similarity transform: uniform scale, rotation and translation, no shear.
 */

export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The same six numbers `CGAffineTransform` carries, in the same order:
 *
 *     x' = a·x + c·y + tx
 *     y' = b·x + d·y + ty
 */
export interface AffineTransform {
  a: number
  b: number
  c: number
  d: number
  tx: number
  ty: number
}

/**
 * Canonical five-point layouts, normalised to the crop size. Values are the
 * templates used by FaceFusion, which in turn inherits them from InsightFace's
 * alignment conventions.
 */
export const WarpTemplate = {
  /** Used by ArcFace when encoding identity, at 112×112. */
  arcface112v2: [
    { x: 0.34191607, y: 0.46157411 },
    { x: 0.65653393, y: 0.45983393 },
    { x: 0.500225, y: 0.64050536 },
    { x: 0.37097589, y: 0.82469196 },
    { x: 0.63151696, y: 0.82325089 },
  ] as Point[],

  /** Used by inswapper, at 128×128. Note this is not a rescaled 112 template. */
  arcface128: [
    { x: 0.36167656, y: 0.40387734 },
    { x: 0.63696719, y: 0.40235469 },
    { x: 0.50019687, y: 0.56044219 },
    { x: 0.38710391, y: 0.72160547 },
    { x: 0.61507734, y: 0.72034453 },
  ] as Point[],

  /** Used by GFPGAN and other restorers, at 512×512. */
  ffhq512: [
    { x: 0.37691676, y: 0.46864664 },
    { x: 0.62285697, y: 0.46912813 },
    { x: 0.50123859, y: 0.61331904 },
    { x: 0.39308822, y: 0.725411 },
    { x: 0.61150205, y: 0.72490465 },
  ] as Point[],
}

export function scaledTemplate(template: readonly Point[], size: number): Point[] {
  return template.map((point) => ({ x: point.x * size, y: point.y * size }))
}

export const identityTransform: AffineTransform = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }

/**
 * Least-squares similarity transform mapping `source` onto `target`.
 *
 * This is the closed form of the 2-D Procrustes problem, and is what OpenCV's
 * `estimateAffinePartial2D` converges to. The reference pipeline calls it with a
 * RANSAC reprojection threshold of 100px across only five points, which never
 * rejects an inlier, so the plain least-squares solution matches it while
 * staying deterministic.
 *
 * Solving for `[[a, -b], [b, a]]` plus a translation:
 *     a = Σ(xᵢuᵢ + yᵢvᵢ) / Σ(xᵢ² + yᵢ²)
 *     b = Σ(xᵢvᵢ − yᵢuᵢ) / Σ(xᵢ² + yᵢ²)
 * over points centred on their respective means.
 */
export function similarityTransform(
  source: readonly Point[],
  target: readonly Point[],
): AffineTransform {
  if (source.length !== target.length || source.length === 0) {
    throw new Error('similarityTransform needs matching, non-empty point sets')
  }
  const n = source.length

  let srcMeanX = 0
  let srcMeanY = 0
  let dstMeanX = 0
  let dstMeanY = 0
  for (let i = 0; i < n; i += 1) {
    srcMeanX += source[i].x / n
    srcMeanY += source[i].y / n
    dstMeanX += target[i].x / n
    dstMeanY += target[i].y / n
  }

  let numeratorA = 0 // Σ(xu + yv)
  let numeratorB = 0 // Σ(xv − yu)
  let denominator = 0 // Σ(x² + y²)

  for (let i = 0; i < n; i += 1) {
    const x = source[i].x - srcMeanX
    const y = source[i].y - srcMeanY
    const u = target[i].x - dstMeanX
    const v = target[i].y - dstMeanY
    numeratorA += x * u + y * v
    numeratorB += x * v - y * u
    denominator += x * x + y * y
  }

  if (denominator <= Number.EPSILON) {
    return { a: 1, b: 0, c: 0, d: 1, tx: dstMeanX - srcMeanX, ty: dstMeanY - srcMeanY }
  }

  const a = numeratorA / denominator
  const b = numeratorB / denominator
  return {
    a,
    b,
    c: -b,
    d: a,
    tx: dstMeanX - (a * srcMeanX - b * srcMeanY),
    ty: dstMeanY - (b * srcMeanX + a * srcMeanY),
  }
}

/** The transform taking a face in image space onto a canonical template. */
export function alignmentTransform(
  landmarks: readonly Point[],
  template: readonly Point[],
  cropSize: number,
): AffineTransform {
  return similarityTransform(landmarks, scaledTemplate(template, cropSize))
}

/** A pure scale-and-translate transform, as used by the 68-point landmarker. */
export function translationTransform(scale: number, translation: Point): AffineTransform {
  return { a: scale, b: 0, c: 0, d: scale, tx: translation.x, ty: translation.y }
}

export function invert(t: AffineTransform): AffineTransform {
  const determinant = t.a * t.d - t.b * t.c
  if (Math.abs(determinant) < Number.EPSILON) return identityTransform
  const inverse = 1 / determinant
  const a = t.d * inverse
  const b = -t.b * inverse
  const c = -t.c * inverse
  const d = t.a * inverse
  return {
    a,
    b,
    c,
    d,
    tx: -(a * t.tx + c * t.ty),
    ty: -(b * t.tx + d * t.ty),
  }
}

/** `first` then `second`, matching `CGAffineTransform.concatenating`. */
export function concatenate(
  first: AffineTransform,
  second: AffineTransform,
): AffineTransform {
  return {
    a: first.a * second.a + first.b * second.c,
    b: first.a * second.b + first.b * second.d,
    c: first.c * second.a + first.d * second.c,
    d: first.c * second.b + first.d * second.d,
    tx: first.tx * second.a + first.ty * second.c + second.tx,
    ty: first.tx * second.b + first.ty * second.d + second.ty,
  }
}

export function applyTransform(t: AffineTransform, point: Point): Point {
  return {
    x: t.a * point.x + t.c * point.y + t.tx,
    y: t.b * point.x + t.d * point.y + t.ty,
  }
}

/** Axis-aligned bounds of a rectangle after transformation. */
export function transformedBounds(
  width: number,
  height: number,
  t: AffineTransform,
): Rect {
  const corners = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ].map((corner) => applyTransform(t, corner))

  const xs = corners.map((corner) => corner.x)
  const ys = corners.map((corner) => corner.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/**
 * Reduces the 68-point constellation to the five points the swapper wants: the
 * two eye centroids, the nose tip, and the mouth corners.
 */
export function fivePointsFrom68(landmarks: readonly Point[]): Point[] {
  if (landmarks.length < 68) throw new Error('expected 68 landmarks')
  const centroid = (from: number, to: number): Point => {
    let x = 0
    let y = 0
    for (let i = from; i < to; i += 1) {
      x += landmarks[i].x
      y += landmarks[i].y
    }
    const count = to - from
    return { x: x / count, y: y / count }
  }
  return [
    centroid(36, 42), // left eye
    centroid(42, 48), // right eye
    landmarks[30], // nose tip
    landmarks[48], // left mouth corner
    landmarks[54], // right mouth corner
  ]
}

export function rectArea(box: Rect): number {
  return box.width * box.height
}

export function rectMidX(box: Rect): number {
  return box.x + box.width / 2
}

export function rectMidY(box: Rect): number {
  return box.y + box.height / 2
}
