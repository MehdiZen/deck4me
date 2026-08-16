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
// v4 : 8 blendshapes de plus. RÉGRESSION — voir v5.
// v5 : retrait de tongueOut, cheekSquint* et mouthDimple*, les trois que la v4
//      ajoutait « sous réserve de vérification ». La réserve était fondée.
//
//      Le calcul qui aurait dû être fait avant : la distance est une RMS sur n
//      dimensions, donc UNE seule clé qui oscille de 0,9 pendant qu'on ne bouge
//      pas ajoute √(0,81/31) ≈ 0,16 à toutes les distances — presque le triple
//      du plancher de seuil (0,06). Une dimension instable sur trente et une
//      suffit donc à dérégler l'application entière :
//        · le seuil auto vaut max(dispersion intra × 1,3, plancher) → il enfle,
//          et les poses difficiles se mettent à partir toutes seules ;
//        · la distance au runtime enfle aussi → les poses qui utilisaient la
//          clé instable ne matchent plus du tout ;
//        · l'échelle du graphe Live étant adaptative, la ligne de seuil se met
//          à bouger à l'écran alors que sa valeur ne change pas.
//      Les trois symptômes n'en font qu'un.
export const FEATURIZER_VERSION = 5

/**
 * Sous-ensemble des blendshapes ARKit (52 exposés par MediaPipe).
 *
 * ─── Pourquoi un sous-ensemble ──────────────────────────────────────────────
 * La distance est une RMS normalisée par le nombre de dimensions : chaque clé
 * ajoutée divise le signal des autres. Une clé qui ne bouge jamais coûte donc
 * de la dilution sans rien rapporter, et une clé qui bouge au hasard (ou
 * pendant qu'on parle) ajoute du bruit à TOUTES les comparaisons, pas seulement
 * à celles qui l'emploient. Le critère n'est pas « cette expression est utile »
 * mais « ce blendshape bouge-t-il de façon fiable ET indépendante des autres ».
 *
 * ─── Écartés, et pourquoi ───────────────────────────────────────────────────
 * · eyeLook* (×8) — du regard, pas de la pose ; et des lunettes le rendent
 *   bruité (réflexions, monture devant l'iris).
 * · mouthStretch* — part sur chaque « i », « è », « ê » : usine à faux positifs.
 * · mouthPress*, mouthRoll*, mouthClose — cinq dimensions quasi synonymes, de
 *   faible amplitude, très fréquentes entre deux mots.
 * · mouthShrug* — recouvre mouthPucker, déjà présent.
 * · mouthLowerDown* — en pratique inséparable de jawOpen, déjà présent.
 * · noseSneer* — doublon de mouthUpperUp, et l'arête du nez porte les lunettes.
 *
 * ─── Ordre ──────────────────────────────────────────────────────────────────
 * Les clés v1 restent EN TÊTE, dans leur ordre d'origine. Une baseline de
 * calibration écrite avant v4 est un tableau de 23 nombres : les 23 premiers
 * indices doivent garder exactement le même sens, sinon on soustrairait le
 * biais du sourcil gauche à la mâchoire. Ne jamais insérer au milieu —
 * uniquement ajouter à la fin. Un test verrouille ce préfixe.
 */
export const FACE_KEYS = [
  // --- v1 : ordre figé, ne pas réordonner ---
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

  // --- v4, conservées en v5 ---
  /** Mâchoire avancée. Complète la famille (Open/Left/Right déjà là) pour une
   *  seule dimension, sans recouvrir aucune autre. */
  'jawForward',
  /** Lèvre supérieure retroussée : le dégoût. Franchement distinct du sourire
   *  comme de la moue. */
  'mouthUpperUpLeft',
  'mouthUpperUpRight',

  // --- Retirées en v5, ne pas réintroduire sans mesure ---
  // 'tongueOut'       — oscille sans qu'on bouge : le modèle MediaPipe la
  //                     prédit mal. C'est elle qui a déréglé la v4.
  // 'cheekSquint*'    — la zone est sous la monture des lunettes.
  // 'mouthDimple*'    — dépend de la morphologie ; sans fossettes, du bruit.
  //
  // L'écran Debug affiche l'instabilité de chaque blendshape au repos
  // (« Stabilité des blendshapes »). C'est la mesure à faire AVANT d'ajouter
  // quoi que ce soit ici : une clé dont l'amplitude au repos dépasse ~0,05
  // coûte plus qu'elle ne rapporte, quelle que soit l'expression qu'elle
  // prétend capter.
] as const

/** Nombre de clés v1. Une baseline écrite avant v4 a exactement cette taille ;
 *  ses valeurs restent valides puisque le préfixe n'a pas bougé. */
export const FACE_KEYS_V1 = 23

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
