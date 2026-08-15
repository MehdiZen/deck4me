import type {
  BlendshapeCategory,
  FaceAnchor,
  FeatureBlocks,
  Handedness,
  Landmark,
  RawFrame,
  RawHand,
} from './types.js'

// v2 : ajout du bloc handPos (position du poignet relative au visage).
// v3 : POS_SCALE abaissé — en v2 la position écrasait la forme, un petit
//      décalage de main suffisait à empêcher le match.
// Les raws v1 sans faceAnchor restent featurisables : bloc position absent.
export const FEATURIZER_VERSION = 3

/**
 * Sous-ensemble v1 des blendshapes ARKit. Choix délibérés :
 * - PAS de eyeLook* : c'est du regard, pas de la pose volontaire, et les
 *   lunettes le rendent bruité (réflexions, monture devant l'iris).
 * - Les squint/blink restent : utiles pour les grimaces, la baseline neutre
 *   absorbe le biais constant lunettes/morphologie.
 */
export const FACE_KEYS = [
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
] as const

export const FACE_DIMS = FACE_KEYS.length
export const HAND_DIMS = 42 // 21 points × (x, y), z volontairement absent

/** Facteur ramenant le bloc main (coords ≈ ±1.5 après normalisation) sur une
 *  échelle comparable au bloc visage (scores 0–1). Sans ça, la main écrase le
 *  visage dans la distance des gestures 'both'. */
export const HAND_SCALE = 0.5

/** Baseline visage neutre de l'utilisateur (moyenne de la calibration),
 *  soustraite pour absorber le biais morphologique (ex. browInnerUp 0.3 au repos). */
export type FaceBaseline = Float32Array // FACE_DIMS

export function faceVector(face: BlendshapeCategory[]): Float32Array {
  const byName = new Map(face.map((c) => [c.categoryName, c.score]))
  const out = new Float32Array(FACE_DIMS)
  for (let i = 0; i < FACE_KEYS.length; i++) out[i] = byName.get(FACE_KEYS[i]!) ?? 0
  return out
}

export function featurizeFace(
  face: BlendshapeCategory[],
  baseline: FaceBaseline | null,
): Float32Array {
  const v = faceVector(face)
  if (baseline) for (let i = 0; i < v.length; i++) v[i]! -= baseline[i] ?? 0
  return v
}

/**
 * Normalisation main :
 *  - translation : origine au poignet (p0)
 *  - échelle : ÷ ‖p0→p9‖ (poignet → base du majeur)
 *  - rotation 2D : aligne p0→p9 sur -Y (le « haut » écran)
 *  - drop z (bruité), flatten [x0, y0, x1, y1, …], × HAND_SCALE
 */
export function featurizeHand(landmarks: Landmark[]): Float32Array {
  const w = landmarks[0]!
  const m = landmarks[9]!
  const dx = m.x - w.x
  const dy = m.y - w.y
  const norm = Math.hypot(dx, dy) || 1e-6
  // Angle actuel de p0→p9 ; on veut le ramener sur -Y (angle cible -π/2)
  const rot = -Math.PI / 2 - Math.atan2(dy, dx)
  const cos = Math.cos(rot)
  const sin = Math.sin(rot)
  const out = new Float32Array(HAND_DIMS)
  for (let i = 0; i < 21; i++) {
    const p = landmarks[i]!
    const x = (p.x - w.x) / norm
    const y = (p.y - w.y) / norm
    out[i * 2] = (x * cos - y * sin) * HAND_SCALE
    out[i * 2 + 1] = (x * sin + y * cos) * HAND_SCALE
  }
  return out
}

const SLOT: Record<Handedness, 0 | 1> = { Left: 0, Right: 1 }

export const POS_DIMS = 2
/** La position est exprimée en largeurs de visage (nez → poignet, ÷ échelle
 *  inter-oculaire ×4 pour rester ~[-1,1] sur les poses réalistes), puis
 *  pondérée pour peser comme les autres blocs dans la distance.
 *
 *  POS_SCALE arbitre entre « distinguer épaules vs derrière la tête » (il en
 *  faut assez) et « tolérer que la main ne soit jamais exactement au même
 *  endroit » (il n'en faut pas trop). À 0.35, un déplacement d'une largeur de
 *  tête reste très au-dessus d'un seuil typique, alors que le tremblement
 *  naturel de la main passe dessous. */
export const POS_RANGE = 4
export const POS_SCALE = 0.35

export function featurizePosition(wrist: Landmark, anchor: FaceAnchor): Float32Array {
  const s = anchor.scale * POS_RANGE || 1e-6
  const out = new Float32Array(POS_DIMS)
  out[0] = ((wrist.x - anchor.nose.x) / s) * POS_SCALE
  out[1] = ((wrist.y - anchor.nose.y) / s) * POS_SCALE
  return out
}

/**
 * LA fonction. Même code à l'enregistrement et au runtime, aucune duplication.
 * Les mains sont rangées par handedness MediaPipe (flux non mirroré).
 */
export function featurize(
  face: BlendshapeCategory[] | null,
  hands: RawHand[],
  baseline: FaceBaseline | null = null,
  anchor: FaceAnchor | null = null,
): FeatureBlocks {
  const out: FeatureBlocks = { face: null, hands: [null, null], handPos: [null, null] }
  if (face && face.length) out.face = featurizeFace(face, baseline)
  for (const h of hands) {
    if (h.landmarks.length === 21) {
      const slot = SLOT[h.handedness]
      out.hands[slot] = featurizeHand(h.landmarks)
      if (anchor) out.handPos[slot] = featurizePosition(h.landmarks[0]!, anchor)
    }
  }
  return out
}

export function featurizeRaw(raw: RawFrame, baseline: FaceBaseline | null = null): FeatureBlocks {
  return featurize(raw.face, raw.hands, baseline, raw.faceAnchor ?? null)
}

/** Baseline = moyenne des frames visage de la calibration neutre. */
export function computeBaseline(frames: RawFrame[]): FaceBaseline {
  const acc = new Float32Array(FACE_DIMS)
  let n = 0
  for (const f of frames) {
    if (!f.face) continue
    const v = faceVector(f.face)
    for (let i = 0; i < FACE_DIMS; i++) acc[i]! += v[i]!
    n++
  }
  if (n > 0) for (let i = 0; i < FACE_DIMS; i++) acc[i]! /= n
  return acc
}
