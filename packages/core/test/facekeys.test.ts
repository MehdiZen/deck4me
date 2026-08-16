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

  /** Les clés écartées, avec la raison. Le test empêche qu'on les réintroduise
   *  par inadvertance en recopiant la liste ARKit complète. */
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
      'noseSneerLeft', // mesurées à 0,000 dans les deux états
      'noseSneerRight',
      // `mouthLowerDown*` figurait ici, écartée au motif qu'elle serait
      // « inséparable de jawOpen ». La mesure dit le contraire : 0,60 / 0,40
      // en grimace quand jawOpen ne montait qu'à 0,11 sur la même frame. Elle
      // est retenue depuis la v6.
    ]
    for (const k of rejected) expect(FACE_KEYS, k).not.toContain(k)
  })

  /**
   * Clés écartées sur MESURE (écran Debug, amplitude au repos puis en grimace).
   * Une clé qui ne bouge dans aucun des deux états n'apporte rien et dilue le
   * signal des autres, la distance étant une RMS divisée par le nombre de
   * dimensions. Ne pas réintroduire sans un relevé qui les contredise.
   */
  it('exclut les clés mesurées mortes ou négligeables', () => {
    const dead = {
      tongueOut: "MediaPipe ne la produit pas du tout — 51 blendshapes + _neutral",
      jawForward: '0,003 au maximum en pleine grimace',
      cheekSquintLeft: '0,000 au repos comme en grimace',
      cheekSquintRight: '0,000 au repos comme en grimace',
      noseSneerLeft: '0,000 dans les deux états',
      noseSneerRight: '0,000 dans les deux états',
      mouthDimpleLeft: '0,03 au maximum',
      mouthDimpleRight: '0,03 au maximum',
    }
    for (const [k, why] of Object.entries(dead)) expect(FACE_KEYS, why).not.toContain(k)
  })

  /** Retenues sur mesure : réponse franche entre repos et expression. */
  it('retient les clés mesurées utiles', () => {
    for (const k of [
      'mouthUpperUpLeft', // 0,000 → 0,39
      'mouthUpperUpRight', // 0,000 → 0,37
      'mouthLowerDownLeft', // 0,000 → 0,40
      'mouthLowerDownRight', // 0,000 → 0,60, la plus forte après le sourire
    ]) {
      expect(FACE_KEYS, k).toContain(k)
    }
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
