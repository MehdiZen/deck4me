import { describe, expect, it } from 'vitest'
import { FACE_DIMS } from '../src/featurizer.js'
import {
  NEIGHBOR_CAP,
  THRESHOLD_FLOOR,
  computeThreshold,
  filterOutliers,
} from '../src/threshold.js'
import type { FeatureBlocks } from '../src/types.js'

function fb(values: number[]): FeatureBlocks {
  const f = new Float32Array(FACE_DIMS)
  values.forEach((v, i) => (f[i] = v))
  return { face: f, hands: [null, null], handPos: [null, null] }
}

/** n samples autour d'un centre, avec un jitter déterministe d'amplitude eps. */
function cluster(center: number[], n: number, eps: number): FeatureBlocks[] {
  return Array.from({ length: n }, (_, k) =>
    fb(center.map((c, i) => c + Math.sin(k * 3.1 + i) * eps)),
  )
}

describe('filterOutliers', () => {
  it('écarte les samples aberrants, garde les cohérents', () => {
    const good = cluster([0.5, 0.2], 8, 0.01)
    const bad = [fb([0.9, 0.9]), fb([0, 0.9])]
    const kept = filterOutliers([...good, ...bad], 'face', 8)
    expect(kept).toHaveLength(8)
    for (const k of kept) expect(k.face![0]).toBeGreaterThan(0.4)
  })
})

describe('computeThreshold', () => {
  const samples = cluster([0.5, 0.2], 6, 0.02)

  it('cas nominal : seuil = maxIntra × 1.3, au-dessus du plancher', () => {
    const v = computeThreshold(samples, 'face', [], [])
    expect(v.verdict).toBe('ok')
    expect(v.threshold).toBeGreaterThanOrEqual(THRESHOLD_FLOOR)
    expect(v.threshold).toBeCloseTo(Math.max(v.maxIntra * 1.3, THRESHOLD_FLOOR), 5)
  })

  it('samples quasi identiques (prise unique) : le plancher évite un seuil impossible', () => {
    const tight = cluster([0.5, 0.2], 6, 0.0001)
    const v = computeThreshold(tight, 'face', [], [])
    expect(v.threshold).toBe(THRESHOLD_FLOOR)
  })

  it('voisin lointain : ok, et le seuil reste sous 0.6 × distance voisin', () => {
    // La distance RMS est normalisée par dimension : un écart de 1.0 sur une
    // seule dim ≈ 0.21 de distance. Cap = 0.125 > plancher → pas de refus.
    const other = cluster([0.5, 1.2], 6, 0.02)
    const v = computeThreshold(samples, 'face', [{ gestureId: 'o', samples: other, source: 'face' }], [])
    expect(v.verdict).toBe('ok')
    expect(v.nearestOther?.gestureId).toBe('o')
    expect(v.threshold).toBeLessThanOrEqual(v.nearestOther!.dist * NEIGHBOR_CAP + 1e-9)
  })

  it('collision : pose trop proche d\'une existante → refus qui NOMME la gesture', () => {
    const nearlySame = cluster([0.5, 0.21], 6, 0.02)
    const v = computeThreshold(samples, 'face', [{ gestureId: 'jumeau', samples: nearlySame, source: 'face' }], [])
    expect(v.verdict).toBe('collision')
    expect(v.collidesWith).toBe('jumeau')
  })

  it('source différente : pas de collision possible', () => {
    const handG = { gestureId: 'h', samples: cluster([0.5, 0.2], 3, 0.01), source: 'hand' as const }
    const v = computeThreshold(samples, 'face', [handG], [])
    expect(v.nearestOther).toBeNull()
  })

  it('faux positif : une frame de parole normale tombe sous le seuil → risque signalé', () => {
    const negatives = [fb([0.5, 0.21]), fb([0.1, 0.1])]
    const v = computeThreshold(samples, 'face', [], negatives)
    expect(v.verdict).toBe('false_positive_risk')
    expect(v.nearestNegative).not.toBeNull()
  })
})
