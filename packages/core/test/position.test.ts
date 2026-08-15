import { describe, expect, it } from 'vitest'
import { featurize } from '../src/featurizer.js'
import { frameDistance } from '../src/distance.js'
import type { FaceAnchor, Landmark, RawHand } from '../src/types.js'

// Le cas réel qui a motivé le v2 : deux poses à mains ouvertes identiques,
// l'une aux épaules, l'autre derrière la tête → v1 les confondait.

function openHand(cx: number, cy: number): RawHand {
  const pts: Landmark[] = []
  for (let i = 0; i < 21; i++) {
    pts.push({ x: cx + Math.sin(i * 1.7) * 0.03, y: cy - i * 0.008, z: 0 })
  }
  return { handedness: 'Right', landmarks: pts }
}

const anchor: FaceAnchor = { nose: { x: 0.5, y: 0.3 }, scale: 0.08 }

describe('featurizer v2 — position des mains relative au visage', () => {
  it('même forme de main, positions différentes → distinguées', () => {
    const shoulders = featurize(null, [openHand(0.72, 0.55)], null, anchor)
    const behindHead = featurize(null, [openHand(0.58, 0.18)], null, anchor)
    const d = frameDistance(shoulders, behindHead, 'hand')
    expect(d).not.toBeNull()
    expect(d!).toBeGreaterThan(0.1) // largement au-dessus d'un seuil réaliste
  })

  it('un léger décalage de main ne tue PAS le match (tolérance de reproduction)', () => {
    const ref = featurize(null, [openHand(0.72, 0.55)], null, anchor)
    // ~3 cm de dérive : la main n'est jamais exactement au même endroit
    const drifted = featurize(null, [openHand(0.745, 0.575)], null, anchor)
    const d = frameDistance(ref, drifted, 'hand')!
    expect(d).toBeLessThan(0.06) // sous le plancher de seuil
  })

  it('même forme, même position → quasi identiques', () => {
    const a = featurize(null, [openHand(0.72, 0.55)], null, anchor)
    const b = featurize(null, [openHand(0.72, 0.55)], null, anchor)
    expect(frameDistance(a, b, 'hand')).toBeLessThan(1e-6)
  })

  it("invariant à la distance caméra (ancre + main plus proches/grosses ensemble)", () => {
    const far = featurize(null, [openHand(0.72, 0.55)], null, anchor)
    // 2× plus proche : tout est 2× plus grand autour du centre du nez
    const zoom = (p: number, c: number) => c + (p - c) * 2
    const nearHand = openHand(0, 0)
    nearHand.landmarks = openHand(0.72, 0.55).landmarks.map((p) => ({
      x: zoom(p.x, anchor.nose.x),
      y: zoom(p.y, anchor.nose.y),
      z: p.z,
    }))
    const nearAnchor: FaceAnchor = { nose: anchor.nose, scale: anchor.scale * 2 }
    const near = featurize(null, [nearHand], null, nearAnchor)
    expect(frameDistance(far, near, 'hand')!).toBeLessThan(0.02)
  })

  it('sample v1 (sans ancre) vs frame v2 : compat forme seule, comme avant', () => {
    const v1sample = featurize(null, [openHand(0.72, 0.55)], null, null)
    const v2frame = featurize(null, [openHand(0.2, 0.8)], null, anchor)
    // formes identiques, positions très différentes → v1 ne voit rien
    expect(frameDistance(v1sample, v2frame, 'hand')!).toBeLessThan(1e-5)
  })

  it('sample v2 : si la frame ne peut pas fournir la position (visage perdu) → pas de match', () => {
    const v2sample = featurize(null, [openHand(0.72, 0.55)], null, anchor)
    const blindFrame = featurize(null, [openHand(0.72, 0.55)], null, null)
    expect(frameDistance(v2sample, blindFrame, 'hand')).toBeNull()
  })
})
