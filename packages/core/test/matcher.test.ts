import { describe, expect, it } from 'vitest'
import { FACE_DIMS } from '../src/featurizer.js'
import { Matcher } from '../src/matcher.js'
import type { FeatureBlocks, GestureDef } from '../src/types.js'

/** Bloc visage synthétique : vecteur constant `v` + un pic sur la dim `hot`. */
function faceBlocks(v: number, hot = 0): FeatureBlocks {
  const f = new Float32Array(FACE_DIMS).fill(v)
  f[hot] = 0.8
  return { face: f, hands: [null, null], handPos: [null, null] }
}

function gesture(id: string, hot: number, over: Partial<GestureDef> = {}): GestureDef {
  return {
    id,
    profileId: 'p1',
    name: id,
    enabled: true,
    source: 'face',
    samples: [faceBlocks(0.1, hot)],
    rawSamples: [],
    threshold: 0.1,
    framesToTrigger: 3,
    cooldownMs: 1000,
    holdMode: 'while_held',
    featurizerVersion: 1,
    ...over,
  }
}

describe('Matcher', () => {
  it('fire sur la bonne gesture, snapshots pour toutes', () => {
    const m = new Matcher()
    m.setGestures([gesture('smile', 2), gesture('shock', 9)])
    const frame = faceBlocks(0.1, 2) // = smile
    let events = m.step(frame, 0).events
    events = m.step(frame, 33).events
    const r = m.step(frame, 66)
    expect(r.events).toEqual([{ type: 'fire', gestureId: 'smile', dist: expect.any(Number) }])
    expect(r.snapshots).toHaveLength(2)
    expect(r.snapshots.find((s) => s.gestureId === 'shock')!.state).toBe('IDLE')
  })

  it("exclusivité : deux gestures proches, seule l'argmin progresse", () => {
    const m = new Matcher()
    // deux gestures quasi identiques (la détection de collision du wizard
    // empêche ça normalement, mais le matcher doit rester sain)
    const a = gesture('a', 3)
    const b = gesture('b', 3)
    b.samples = [faceBlocks(0.11, 3)]
    m.setGestures([a, b])
    const frame = faceBlocks(0.1, 3)
    const fires: string[] = []
    for (let i = 0; i < 10; i++)
      for (const e of m.step(frame, i * 33).events) if (e.type === 'fire') fires.push(e.gestureId)
    expect(fires).toEqual(['a'])
  })

  it('gesture désactivée : ignorée', () => {
    const m = new Matcher()
    m.setGestures([gesture('off', 2, { enabled: false })])
    const r = m.step(faceBlocks(0.1, 2), 0)
    expect(r.snapshots).toHaveLength(0)
  })

  it('panic relâche les actives et reset tout', () => {
    const m = new Matcher()
    m.setGestures([gesture('g', 2)])
    const frame = faceBlocks(0.1, 2)
    for (let i = 0; i < 5; i++) m.step(frame, i * 33)
    const released = m.panic()
    expect(released).toEqual([{ type: 'release', gestureId: 'g', dist: null }])
    // après panic : repartir de zéro (CANDIDATE, pas ACTIVE)
    const r = m.step(frame, 1000)
    expect(r.snapshots[0]!.state).toBe('CANDIDATE')
  })

  it('source hand : main absente → aucune progression', () => {
    const m = new Matcher()
    const g = gesture('h', 0, { source: 'hand' })
    g.samples = [
      { face: null, hands: [new Float32Array(42).fill(0.1), null], handPos: [null, null] },
    ]
    m.setGestures([g])
    const r = m.step(faceBlocks(0.1), 0) // frame sans main
    expect(r.snapshots[0]!.dist).toBeNull()
    expect(r.snapshots[0]!.state).toBe('IDLE')
  })
})
