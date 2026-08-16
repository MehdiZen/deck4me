import { describe, expect, it } from 'vitest'
import { frameBlocks, gestureBest } from '../src/distance.js'
import { featurize } from '../src/featurizer.js'
import type { FaceAnchor, Landmark, RawHand } from '../src/types.js'

function hand(cx: number, cy: number, handedness: 'Left' | 'Right' = 'Right'): RawHand {
  const pts: Landmark[] = []
  for (let i = 0; i < 21; i++) pts.push({ x: cx + Math.sin(i) * 0.02, y: cy - i * 0.008, z: 0 })
  return { handedness, landmarks: pts }
}
// Repère v7 : ce sont `eyes` + `height` qui servent. `nose`/`scale` restent
// dans le type pour les enregistrements d'avant, mais plus rien ne les lit.
const anchor: FaceAnchor = {
  nose: { x: 0.5, y: 0.34 },
  scale: 0.08,
  eyes: { x: 0.5, y: 0.3 },
  height: 0.22,
}

describe('diagnostics par bloc (« pourquoi ça ne déclenche pas »)', () => {
  it('décompose forme et position pour chaque main enregistrée', () => {
    const sample = featurize(null, [hand(0.7, 0.5)], null, anchor)
    const frame = featurize(null, [hand(0.7, 0.5)], null, anchor)
    const blocks = frameBlocks(sample, frame, 'hand')!
    expect(blocks.map((b) => b.kind)).toEqual(['hand', 'position'])
    expect(blocks.every((b) => b.dist !== null && b.dist < 1e-6)).toBe(true)
  })

  it('main enregistrée absente de la frame → bloc à null, pas une distance énorme', () => {
    const sample = featurize(null, [hand(0.7, 0.5, 'Right')], null, anchor)
    const frame = featurize(null, [hand(0.3, 0.5, 'Left')], null, anchor) // autre main
    const blocks = frameBlocks(sample, frame, 'hand')!
    expect(blocks.every((b) => b.dist === null)).toBe(true)
  })

  it('isole la position comme fautive quand la forme est bonne', () => {
    const sample = featurize(null, [hand(0.7, 0.5)], null, anchor)
    const frame = featurize(null, [hand(0.7, 0.1)], null, anchor) // même forme, plus haut
    const blocks = frameBlocks(sample, frame, 'hand')!
    const shape = blocks.find((b) => b.kind === 'hand')!
    const pos = blocks.find((b) => b.kind === 'position')!
    expect(shape.dist!).toBeLessThan(1e-6)
    expect(pos.dist!).toBeGreaterThan(0.2)
  })

  it('gestureBest expose la décomposition du meilleur sample', () => {
    const samples = [
      featurize(null, [hand(0.7, 0.5)], null, anchor),
      featurize(null, [hand(0.2, 0.9)], null, anchor),
    ]
    const frame = featurize(null, [hand(0.7, 0.5)], null, anchor)
    const r = gestureBest(samples, frame, 'hand')
    expect(r.dist!).toBeLessThan(1e-6)
    expect(r.blocks!.every((b) => b.dist !== null && b.dist < 1e-6)).toBe(true)
  })

  it("quand aucun sample n'est comparable, la décomposition explique quand même", () => {
    const samples = [featurize(null, [hand(0.7, 0.5, 'Right')], null, anchor)]
    const frame = featurize(null, [], null, anchor) // aucune main
    const r = gestureBest(samples, frame, 'hand')
    expect(r.dist).toBeNull()
    expect(r.blocks).not.toBeNull()
    expect(r.blocks!.some((b) => b.kind === 'hand' && b.dist === null)).toBe(true)
  })
})
