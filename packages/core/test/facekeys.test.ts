import { describe, expect, it } from 'vitest'
import { FACE_DIMS, FACE_KEYS, FACE_KEYS_V1, featurizeFace } from '../src/featurizer.js'
import type { BlendshapeCategory } from '../src/types.js'

/**
 * Le préfixe v1, figé. Une baseline de calibration est un simple tableau de
 * nombres indexé par position : si quelqu'un insère une clé au milieu de
 * FACE_KEYS, chaque baseline déjà enregistrée soustrait d'un coup le biais de
 * la mauvaise expression — sans erreur, sans message, et sans que personne ne
 * comprenne pourquoi les gestures se sont mises à mal déclencher.
 */
const V1_ORDER = [
  'browDownLeft',
  'browDownRight',
  'browInnerUp',
  'browOuterUpLeft',
  'browOuterUpRight',
  'eyeBlinkLeft',
  'eyeBlinkRight',
  'eyeSquintLeft',
  'eyeSquintRight',
  'eyeWideLeft',
  'eyeWideRight',
  'jawOpen',
  'jawLeft',
  'jawRight',
  'cheekPuff',
  'mouthSmileLeft',
  'mouthSmileRight',
  'mouthFrownLeft',
  'mouthFrownRight',
  'mouthPucker',
  'mouthFunnel',
  'mouthLeft',
  'mouthRight',
]

describe('FACE_KEYS', () => {
  it('conserve le préfixe v1 intact, dans le même ordre', () => {
    expect(FACE_KEYS.slice(0, FACE_KEYS_V1)).toEqual(V1_ORDER)
  })

  it('déclare la bonne taille de préfixe', () => {
    expect(FACE_KEYS_V1).toBe(V1_ORDER.length)
  })

  it("n'ajoute qu'à la fin", () => {
    expect(FACE_KEYS.length).toBeGreaterThanOrEqual(FACE_KEYS_V1)
  })

  it('ne contient aucun doublon — un doublon serait une dimension de dilution pure', () => {
    expect(new Set(FACE_KEYS).size).toBe(FACE_KEYS.length)
  })

  it('FACE_DIMS suit la liste', () => {
    expect(FACE_DIMS).toBe(FACE_KEYS.length)
  })

  it("n'inclut aucun eyeLook* — du regard, pas de la pose, et bruité par les lunettes", () => {
    expect(FACE_KEYS.filter((k) => k.startsWith('eyeLook'))).toEqual([])
  })

  /** Les clés écartées à la v4, avec la raison. Le test empêche qu'on les
   *  réintroduise par inadvertance en recopiant la liste ARKit complète. */
  it('exclut les clés jugées bruitées ou redondantes', () => {
    const rejected = [
      'mouthStretchLeft', // part sur chaque « i », « è », « ê »
      'mouthStretchRight',
      'mouthPressLeft', // quasi synonymes de Roll et Close, faible amplitude
      'mouthPressRight',
      'mouthRollLower',
      'mouthRollUpper',
      'mouthClose',
      'mouthShrugLower', // recouvre mouthPucker
      'mouthShrugUpper',
      'mouthLowerDownLeft', // inséparable de jawOpen en pratique
      'mouthLowerDownRight',
      'noseSneerLeft', // doublon de mouthUpperUp, nez sous la monture
      'noseSneerRight',
    ]
    for (const k of rejected) expect(FACE_KEYS, k).not.toContain(k)
  })
})

describe('featurizeFace avec une baseline plus courte', () => {
  const cats = (): BlendshapeCategory[] =>
    FACE_KEYS.map((categoryName) => ({ categoryName, score: 0.5 }))

  /** Une baseline écrite avant v4 fait 23 entrées. Les clés ajoutées depuis
   *  n'en ont pas : elles doivent simplement ne rien soustraire, jamais
   *  produire NaN — un NaN contaminerait toute la distance. */
  it('laisse les dimensions récentes intactes au lieu de produire NaN', () => {
    const old = new Float32Array(FACE_KEYS_V1).fill(0.2)
    const v = featurizeFace(cats(), old)
    expect(v).toHaveLength(FACE_DIMS)
    for (let i = 0; i < FACE_KEYS_V1; i++) expect(v[i]).toBeCloseTo(0.3, 5)
    for (let i = FACE_KEYS_V1; i < FACE_DIMS; i++) expect(v[i]).toBeCloseTo(0.5, 5)
    expect([...v].some(Number.isNaN)).toBe(false)
  })
})
