import { describe, expect, it } from 'vitest'
import {
  FACE_DIMS,
  FACE_KEYS,
  computeBaseline,
  featurize,
  featurizeFace,
  featurizeHand,
} from '../src/featurizer.js'
import { blockDistance } from '../src/distance.js'
import type { BlendshapeCategory, Landmark } from '../src/types.js'

// Main synthétique plausible : poignet en bas, doigts vers le haut, un peu de bruit déterministe
function syntheticHand(): Landmark[] {
  const pts: Landmark[] = []
  for (let i = 0; i < 21; i++) {
    pts.push({
      x: 0.5 + Math.sin(i * 1.7) * 0.08,
      y: 0.8 - i * 0.02,
      z: Math.cos(i) * 0.05,
    })
  }
  return pts
}

function transform(pts: Landmark[], opts: { dx?: number; dy?: number; s?: number; rot?: number }): Landmark[] {
  const { dx = 0, dy = 0, s = 1, rot = 0 } = opts
  const cx = pts[0]!.x
  const cy = pts[0]!.y
  return pts.map((p) => {
    const x = (p.x - cx) * s
    const y = (p.y - cy) * s
    return {
      x: cx + dx + x * Math.cos(rot) - y * Math.sin(rot),
      y: cy + dy + x * Math.sin(rot) + y * Math.cos(rot),
      z: p.z,
    }
  })
}

describe('featurizeHand — invariances', () => {
  const base = featurizeHand(syntheticHand())

  it('translation', () => {
    const moved = featurizeHand(transform(syntheticHand(), { dx: 0.3, dy: -0.2 }))
    expect(blockDistance(base, moved)).toBeLessThan(1e-6)
  })

  it('échelle (distance caméra)', () => {
    const scaled = featurizeHand(transform(syntheticHand(), { s: 2.4 }))
    expect(blockDistance(base, scaled)).toBeLessThan(1e-6)
  })

  it('rotation 2D', () => {
    const rotated = featurizeHand(transform(syntheticHand(), { rot: 0.7 }))
    expect(blockDistance(base, rotated)).toBeLessThan(1e-5)
  })

  it('le z est ignoré', () => {
    const zNoise = syntheticHand().map((p) => ({ ...p, z: p.z + 10 }))
    expect(blockDistance(base, featurizeHand(zNoise))).toBe(0)
  })

  it('une pose différente reste distinguable', () => {
    const fist = syntheticHand().map((p, i) => (i > 4 ? { ...p, y: p.y + 0.15 } : p))
    expect(blockDistance(base, featurizeHand(fist))).toBeGreaterThan(0.05)
  })
})

describe('featurize — visage et handedness', () => {
  const face: BlendshapeCategory[] = FACE_KEYS.map((k, i) => ({
    categoryName: k,
    score: (i % 5) / 10,
  }))

  it('eyeLook* est exclu du subset (lunettes, regard non volontaire)', () => {
    expect(FACE_KEYS.some((k) => k.startsWith('eyeLook'))).toBe(false)
  })

  it('la baseline neutre est soustraite', () => {
    const baseline = computeBaseline([{ face, hands: [] }])
    const centered = featurizeFace(face, baseline)
    expect(Math.max(...centered.map(Math.abs))).toBeLessThan(1e-6)
    expect(centered.length).toBe(FACE_DIMS)
  })

  it('les mains vont dans le slot de leur handedness', () => {
    const b = featurize(null, [{ handedness: 'Right', landmarks: syntheticHand() }])
    expect(b.hands[0]).toBeNull()
    expect(b.hands[1]).not.toBeNull()
  })

  it('blocs face et main sur des échelles comparables (pondération)', () => {
    const f = featurizeFace(face, null)
    const h = featurizeHand(syntheticHand())
    const rms = (v: Float32Array) => Math.sqrt(v.reduce((a, x) => a + x * x, 0) / v.length)
    const ratio = rms(h) / (rms(f) || 1)
    expect(ratio).toBeGreaterThan(0.3)
    expect(ratio).toBeLessThan(3)
  })
})
