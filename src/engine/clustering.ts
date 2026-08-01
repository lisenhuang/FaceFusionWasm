/**
 * clustering.ts
 *
 * Turning "faces seen in 40 sampled frames" into "the people in this video".
 *
 * Pure arithmetic over identity vectors, with no image or media types in sight.
 *
 * Single-pass and greedy: each identity joins the nearest existing person within
 * `threshold`, or starts a new one. Proper agglomerative clustering would be
 * tidier, but it needs the whole set up front, and this runs while frames are
 * still arriving so the picker can fill in as the scan proceeds.
 *
 * Each person keeps a running mean of every identity merged into it, which
 * settles onto something more representative than whichever frame happened to be
 * sampled first — a scan that catches someone mid-blink should not spend the
 * rest of the video matching against a blink.
 */

import { type FaceIdentity, identityDistance } from './types'

export interface ClusteredPerson {
  id: number
  /** Mean of every identity merged in so far, re-normalised. */
  identity: FaceIdentity
  /** How many sampled detections landed here. A stand-in for screen time. */
  appearances: number
  firstSeen: number
  lastSeen: number
  /** Best detector confidence seen, used to pick the representative crop. */
  bestScore: number
  /** Largest fraction of the frame this face has covered. */
  largestCoverage: number
}

/** The outcome of folding one detection into the set. */
export interface Placement {
  id: number
  /**
   * True when this detection started a new person — the only moment worth the
   * cost of cutting a thumbnail out of the frame.
   */
  isNew: boolean
  /**
   * True when this detection is the best look at that person so far, so an
   * existing thumbnail is worth replacing.
   */
  isBestSoFar: boolean
}

interface Entry extends ClusteredPerson {
  /**
   * Unnormalised sum of the merged identities. Kept so a merge is an addition
   * rather than a re-derivation from vectors already dropped.
   */
  accumulated: Float32Array
}

export class FaceClusterer {
  private entries: Entry[] = []
  private nextID = 0
  /**
   * Cosine distance below which two faces are the same person. Deliberately
   * tighter than the swap-time match: grouping errors here are permanent for the
   * session, whereas the swap threshold can be nudged afterwards.
   */
  private readonly threshold: number

  constructor(threshold = 0.5) {
    this.threshold = threshold
  }

  get count(): number {
    return this.entries.length
  }

  /**
   * Folds one detection in, returning where it landed.
   *
   * @param time seconds into the target, for the "appears from … to …" caption.
   * @param score detector confidence.
   * @param coverage face area as a fraction of the frame, for ordering.
   */
  add(identity: FaceIdentity, time: number, score: number, coverage: number): Placement {
    let bestIndex = -1
    let bestDistance = Number.MAX_VALUE
    for (let index = 0; index < this.entries.length; index += 1) {
      const distance = identityDistance(this.entries[index].identity, identity)
      if (distance < bestDistance) {
        bestDistance = distance
        bestIndex = index
      }
    }

    if (bestIndex < 0 || bestDistance > this.threshold) {
      const id = this.nextID
      this.nextID += 1
      this.entries.push({
        id,
        identity,
        appearances: 1,
        firstSeen: time,
        lastSeen: time,
        bestScore: score,
        largestCoverage: coverage,
        accumulated: Float32Array.from(identity.vector),
      })
      return { id, isNew: true, isBestSoFar: true }
    }

    const person = this.entries[bestIndex]
    // A better look at someone already known: bigger in frame wins, since that
    // is what makes a legible thumbnail and a clean embedding.
    const isBest = coverage > person.largestCoverage
    person.appearances += 1
    person.firstSeen = Math.min(person.firstSeen, time)
    person.lastSeen = Math.max(person.lastSeen, time)
    person.bestScore = Math.max(person.bestScore, score)
    person.largestCoverage = Math.max(person.largestCoverage, coverage)

    const count = Math.min(person.accumulated.length, identity.vector.length)
    for (let i = 0; i < count; i += 1) person.accumulated[i] += identity.vector[i]
    person.identity = { vector: normalized(person.accumulated) }

    return { id: person.id, isNew: false, isBestSoFar: isBest }
  }

  /**
   * People in the order the picker should show them: whoever is on screen most
   * and largest first, so the subject of the shot leads and a passer-by in one
   * frame trails.
   */
  byProminence(): ClusteredPerson[] {
    return [...this.entries].sort((a, b) => {
      const left = a.appearances * (0.25 + a.largestCoverage)
      const right = b.appearances * (0.25 + b.largestCoverage)
      if (left !== right) return right - left
      return a.id - b.id
    })
  }
}

function normalized(vector: Float32Array): Float32Array {
  let magnitude = 0
  for (const value of vector) magnitude += value * value
  magnitude = Math.sqrt(magnitude)
  if (!(magnitude > Number.EPSILON)) return Float32Array.from(vector)
  const out = new Float32Array(vector.length)
  for (let i = 0; i < vector.length; i += 1) out[i] = vector[i] / magnitude
  return out
}
