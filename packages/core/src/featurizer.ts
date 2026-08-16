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
// v4 : 8 blendshapes ajoutés sur intuition. Régression signalée en usage.
// v5 : retrait de 5 d'entre eux, sur une hypothèse qui s'est révélée FAUSSE
//      (voir `tongueOut` plus bas). Correction bâtie sur un mauvais diagnostic.
// v6 : premier jeu établi sur MESURE. L'écran Debug (« Stabilité des
//      blendshapes ») donne l'amplitude de chacune des 52 sur 2 s ; au repos
//      elle mesure le bruit, pendant l'expression elle mesure le signal. Deux
//      relevés suffisent à décider, là où trois versions d'intuition avaient
//      échoué.
//
//      Le critère est le RAPPORT signal/bruit, jamais le bruit seul :
//      `mouthPucker` gigote de 0,10 au repos mais parcourt 0,65 entre repos et
//      grimace — elle reste largement gagnante. À l'inverse `jawForward` ne
//      bouge pas du tout : ne pas bouger n'est pas une qualité, c'est de la
//      dilution, puisque la distance est une RMS divisée par le nombre de
//      dimensions.
//
//      Ce jeu vaut pour CE visage, avec CES lunettes, sous CET éclairage. Voir
//      la piste « pondération par utilisateur » dans HANDOFF.md.
// v7 : nouveau repère de position, insensible à la rotation de la tête. Le
//      repère v2 partait du bout du nez et se mesurait à l'écart entre les
//      yeux — les deux pires choix possibles dès qu'on tourne la tête. Voir
//      featurizePosition. Conséquence assumée : les gestures « mains »
//      enregistrées avant perdent leur bloc position, faute de pouvoir le
//      recalculer.
export const FEATURIZER_VERSION = 7

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

  // --- v6 : retenues sur mesure, pas sur intuition ---
  /** Lèvre supérieure retroussée. Mesurée : 0,000 au repos → 0,39 / 0,37 en
   *  grimace. Signal franc, aucun bruit au repos. */
  'mouthUpperUpLeft',
  'mouthUpperUpRight',
  /** Lèvre inférieure tirée vers le bas. Mesurée : 0,000 au repos → 0,60 / 0,40
   *  en grimace, alors que `jawOpen` ne montait qu'à 0,11 sur la même frame —
   *  les deux ne sont donc PAS le même signal, contrairement à ce que je
   *  supposais en les écartant. La plus forte réponse de tout le jeu après le
   *  sourire. */
  'mouthLowerDownLeft',
  'mouthLowerDownRight',

  // --- Écartées, chacune sur une mesure ---
  // 'tongueOut'    — N'EXISTE PAS. MediaPipe sort `_neutral` + 51 blendshapes,
  //                  soit les 52 d'ARKit MOINS celle-ci. Tirer la langue n'est
  //                  pas détectable avec ce modèle, point.
  // 'jawForward'   — 0,003 au maximum en pleine grimace. Morte : de la dilution
  //                  pure. Ajoutée en v4 sur intuition, retirée en v6 sur mesure.
  // 'cheekSquint*' — 0,000 au repos ET en grimace. Morte.
  // 'noseSneer*'   — 0,000 dans les deux états. Morte.
  // 'mouthDimple*' — 0,03 au maximum. Négligeable.
  // 'mouthStretch*', 'mouthPress*', 'mouthRoll*', 'mouthClose',
  // 'mouthShrug*'  — mesurées sous 0,09, sans commune mesure avec les retenues.
  // 'eyeLook*'     — LE bruit du jeu : 0,55 d'amplitude en grimace, 0,16 au
  //                  repos. De loin les plus instables des 52. Exclusion
  //                  d'origine confirmée par la mesure.
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
/** La position est exprimée en tailles de visage (milieu des yeux → poignet,
 *  ÷ hauteur du visage × POS_RANGE pour rester ~[-1,1] sur les poses
 *  réalistes), puis pondérée pour peser comme les autres blocs dans la
 *  distance.
 *
 *  POS_SCALE arbitre entre « distinguer épaules vs derrière la tête » (il en
 *  faut assez) et « tolérer que la main ne soit jamais exactement au même
 *  endroit » (il n'en faut pas trop). À 0.35, un déplacement d'une largeur de
 *  tête reste très au-dessus d'un seuil typique, alors que le tremblement
 *  naturel de la main passe dessous.
 *
 *  POS_RANGE vaut 1.5 sur la hauteur du visage, contre 4 sur l'inter-oculaire
 *  en v2 : la hauteur front→menton fait environ 2,7 fois l'écart entre les
 *  yeux, donc les positions restent dans la MÊME plage numérique qu'avant. Ce
 *  n'est pas de la coquetterie — les seuils enregistrés vivent dans cette
 *  plage, la changer les décalerait tous en silence. */
export const POS_RANGE = 1.5
export const POS_SCALE = 0.35

/**
 * Position du poignet relative à la tête.
 *
 * Retourne `null` si l'ancre n'a pas le repère v7. C'est le cas des frames
 * enregistrées avant : elles ne contiennent que `nose` + `scale`, et les points
 * du visage qui auraient permis de recalculer le nouveau repère n'ont jamais
 * été persistés. Les convertir est donc IMPOSSIBLE, pas seulement coûteux.
 *
 * Plutôt que de comparer une position v2 à une position v7 — deux espaces
 * différents, ce qui produirait des distances absurdes sans rien signaler —
 * ces échantillons perdent simplement leur bloc position et ne sont plus jugés
 * que sur la forme de la main. `frameBlocks` gère déjà l'absence. Ré-enregistrer
 * la pose lui rend sa position.
 */
export function featurizePosition(wrist: Landmark, anchor: FaceAnchor): Float32Array | null {
  if (!anchor.eyes || !anchor.height) return null
  const s = anchor.height * POS_RANGE || 1e-6
  const out = new Float32Array(POS_DIMS)
  out[0] = ((wrist.x - anchor.eyes.x) / s) * POS_SCALE
  out[1] = ((wrist.y - anchor.eyes.y) / s) * POS_SCALE
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
      // handPos reste null si l'ancre est trop vieille : bloc position ignoré
      // des deux côtés, la gesture est jugée sur la forme seule.
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
