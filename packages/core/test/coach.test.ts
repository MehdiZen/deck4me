import { describe, expect, it } from 'vitest'
import { FACE_DIMS, FACE_KEYS, HAND_DIMS, HAND_SCALE, POS_RANGE, POS_SCALE } from '../src/featurizer.js'
import { advise } from '../src/coach.js'
import type { FeatureBlocks } from '../src/types.js'

function empty(): FeatureBlocks {
  return { face: null, hands: [null, null], handPos: [null, null] }
}

function face(set: Record<string, number>): FeatureBlocks {
  const v = new Float32Array(FACE_DIMS)
  for (const [k, val] of Object.entries(set)) v[FACE_KEYS.indexOf(k)] = val
  return { ...empty(), face: v }
}

/** Main canonique : tous les points au même endroit, puis on déplace ce qu'il
 *  faut. Le repère est déjà normalisé, on écrit donc directement dedans. */
function hand(points: Record<number, [number, number]>): FeatureBlocks {
  const v = new Float32Array(HAND_DIMS)
  for (const [id, [x, y]] of Object.entries(points)) {
    v[Number(id) * 2] = x * HAND_SCALE
    v[Number(id) * 2 + 1] = y * HAND_SCALE
  }
  return { ...empty(), hands: [v, null] }
}

function pos(x: number, y: number): FeatureBlocks {
  const v = new Float32Array(2)
  v[0] = (x / POS_RANGE) * POS_SCALE
  v[1] = (y / POS_RANGE) * POS_SCALE
  return { ...empty(), hands: [new Float32Array(HAND_DIMS), null], handPos: [v, null] }
}

describe('coach', () => {
  it('traduit un blendshape en consigne, dans le bon sens', () => {
    // Enregistré bouche ouverte, mesuré bouche fermée → il faut l'ouvrir.
    const a = advise(face({ jawOpen: 0.8 }), face({ jawOpen: 0.1 }), 'face')
    expect(a[0]!.text).toBe('ouvre davantage la bouche')
    // Et l'inverse doit dire l'inverse, pas une négation de la même phrase.
    const b = advise(face({ jawOpen: 0.1 }), face({ jawOpen: 0.8 }), 'face')
    expect(b[0]!.text).toBe('ferme davantage la bouche')
  })

  it('ne dit rien quand l’écart est du bruit', () => {
    expect(advise(face({ jawOpen: 0.5 }), face({ jawOpen: 0.49 }), 'face')).toEqual([])
  })

  it('ne répète pas un libellé partagé par la paire gauche/droite', () => {
    // Les deux sourires s'écartent ensemble : une seule phrase, pas deux.
    const a = advise(
      face({ mouthSmileLeft: 0.9, mouthSmileRight: 0.9 }),
      face({ mouthSmileLeft: 0, mouthSmileRight: 0 }),
      'face',
    )
    expect(a.filter((x) => x.text === 'souris davantage')).toHaveLength(1)
  })

  it('nomme le doigt et le sens de son extension', () => {
    // Index tendu à l'enregistrement, replié à la mesure.
    const rec = hand({ 5: [0.2, -0.3], 6: [0.2, -0.6], 7: [0.2, -0.9], 8: [0.2, -1.2] })
    const live = hand({ 5: [0.2, -0.3], 6: [0.2, -0.35], 7: [0.2, -0.4], 8: [0.2, -0.45] })
    const a = advise(rec, live, 'hand')
    expect(a[0]!.text).toBe('tends davantage ton index')
  })

  it('oriente la position dans le repère de la personne, pas de l’image', () => {
    // Le flux n'est pas mirroré : un x enregistré PLUS GRAND est plus à droite
    // dans l'image, donc du côté gauche de la personne.
    const droite = advise(pos(0.9, 0), pos(0.2, 0), 'hand')
    expect(droite.some((x) => x.text === 'déplace ta main vers ta gauche')).toBe(true)
    // y croît vers le bas de l'image.
    const bas = advise(pos(0, 0.9), pos(0, 0.2), 'hand')
    expect(bas.some((x) => x.text === 'descends ta main')).toBe(true)
  })

  it('ne rend jamais plus de consignes que demandé, les plus grosses d’abord', () => {
    const a = advise(
      face({ jawOpen: 0.9, mouthPucker: 0.8, cheekPuff: 0.7, browInnerUp: 0.6 }),
      face({}),
      'face',
      2,
    )
    expect(a).toHaveLength(2)
    expect(a[0]!.gap).toBeGreaterThanOrEqual(a[1]!.gap)
  })
})
