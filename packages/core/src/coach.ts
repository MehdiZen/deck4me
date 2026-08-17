import { FACE_KEYS, HAND_SCALE, POS_RANGE, POS_SCALE } from './featurizer.js'
import type { FeatureBlocks, GestureSource } from './types.js'

/**
 * Traduire un écart de vecteurs en consigne.
 *
 * ─── Pourquoi ce module existe ──────────────────────────────────────────────
 * Dire « le bloc main D coûte 0,091 pour un budget de 0,062 » est exact et
 * inutilisable : ça nomme un coupable sans dire quoi faire du corps. Ici on
 * regarde QUELLES dimensions s'écartent, et on les rend en français.
 *
 * ─── Ce qui est traduisible, et ce qui ne l'est pas ─────────────────────────
 * L'honnêteté du module tient dans cette liste, parce qu'une consigne inventée
 * envoie chercher au mauvais endroit :
 *
 *  · Le VISAGE se traduit parfaitement. Chaque dimension est un blendshape
 *    nommé — `jawOpen`, `mouthSmileLeft` — et son écart a un signe. « Ouvre
 *    davantage la bouche » se lit directement dans le vecteur.
 *  · La POSITION de la main se traduit parfaitement. Deux dimensions, un
 *    décalage horizontal et vertical exprimés en hauteurs de visage.
 *  · La FORME de la main se traduit partiellement : on sait dire QUEL doigt
 *    s'écarte, et s'il est plus replié ou plus tendu que l'enregistrement. On
 *    ne sait pas dire mieux sans inventer.
 *  · La ROTATION de la main NE SE TRADUIT PAS, et il ne faut surtout pas
 *    essayer : `featurizeHand` l'efface avant toute comparaison. Conseiller de
 *    tourner la main serait envoyer corriger une chose qui n'entre pas dans le
 *    calcul.
 *  · L'INCLINAISON DE LA TÊTE non plus : elle n'est nulle part dans les
 *    features. Ni dans les blendshapes, ni dans la position — qui est mesurée
 *    depuis les yeux justement pour y être insensible.
 */

export interface Advice {
  /** La consigne, telle qu'on la lit. */
  text: string
  /** Ce qui l'a produite — sert à grouper et à ne pas répéter un même bloc. */
  kind: 'face' | 'hand' | 'position'
  /** Amplitude de l'écart, dans l'unité du bloc. Sert au tri. */
  gap: number
}

/**
 * Nom lisible et sens de chaque blendshape retenu.
 *
 * `more` = ce qu'il faut faire quand la valeur enregistrée est PLUS HAUTE que
 * la valeur mesurée, `less` quand elle est plus basse. Les deux sont écrits, et
 * pas déduits par une négation : « ouvre moins la bouche » et « ferme la
 * bouche » ne se valent pas à l'oreille, et c'est cette phrase-là que
 * quelqu'un va essayer de suivre devant sa webcam.
 *
 * Les paires gauche/droite partagent leur libellé : personne ne pense « mon
 * sourcil externe droit ». Le dédoublonnage se fait à la sortie.
 */
const FACE_HINTS: Record<string, { label: string; more: string; less: string }> = {
  browDownLeft: { label: 'sourcils', more: 'fronce davantage les sourcils', less: 'fronce moins les sourcils' },
  browDownRight: { label: 'sourcils', more: 'fronce davantage les sourcils', less: 'fronce moins les sourcils' },
  browInnerUp: { label: 'sourcils', more: 'relève davantage l’intérieur des sourcils', less: 'relâche l’intérieur des sourcils' },
  browOuterUpLeft: { label: 'sourcils', more: 'relève davantage les sourcils', less: 'relève moins les sourcils' },
  browOuterUpRight: { label: 'sourcils', more: 'relève davantage les sourcils', less: 'relève moins les sourcils' },
  eyeBlinkLeft: { label: 'yeux', more: 'ferme davantage les yeux', less: 'ouvre davantage les yeux' },
  eyeBlinkRight: { label: 'yeux', more: 'ferme davantage les yeux', less: 'ouvre davantage les yeux' },
  eyeSquintLeft: { label: 'yeux', more: 'plisse davantage les yeux', less: 'plisse moins les yeux' },
  eyeSquintRight: { label: 'yeux', more: 'plisse davantage les yeux', less: 'plisse moins les yeux' },
  eyeWideLeft: { label: 'yeux', more: 'écarquille davantage les yeux', less: 'écarquille moins les yeux' },
  eyeWideRight: { label: 'yeux', more: 'écarquille davantage les yeux', less: 'écarquille moins les yeux' },
  jawOpen: { label: 'mâchoire', more: 'ouvre davantage la bouche', less: 'ferme davantage la bouche' },
  jawLeft: { label: 'mâchoire', more: 'décale la mâchoire vers ta gauche', less: 'ramène la mâchoire au centre' },
  jawRight: { label: 'mâchoire', more: 'décale la mâchoire vers ta droite', less: 'ramène la mâchoire au centre' },
  cheekPuff: { label: 'joues', more: 'gonfle davantage les joues', less: 'gonfle moins les joues' },
  mouthSmileLeft: { label: 'sourire', more: 'souris davantage', less: 'souris moins' },
  mouthSmileRight: { label: 'sourire', more: 'souris davantage', less: 'souris moins' },
  mouthFrownLeft: { label: 'bouche', more: 'baisse davantage les coins de la bouche', less: 'relâche les coins de la bouche' },
  mouthFrownRight: { label: 'bouche', more: 'baisse davantage les coins de la bouche', less: 'relâche les coins de la bouche' },
  mouthPucker: { label: 'bouche', more: 'fais davantage le bec', less: 'fais moins le bec' },
  mouthFunnel: { label: 'bouche', more: 'arrondis davantage la bouche', less: 'arrondis moins la bouche' },
  mouthLeft: { label: 'bouche', more: 'décale la bouche vers ta gauche', less: 'ramène la bouche au centre' },
  mouthRight: { label: 'bouche', more: 'décale la bouche vers ta droite', less: 'ramène la bouche au centre' },
  mouthUpperUpLeft: { label: 'lèvre haute', more: 'retrousse davantage la lèvre du haut', less: 'retrousse moins la lèvre du haut' },
  mouthUpperUpRight: { label: 'lèvre haute', more: 'retrousse davantage la lèvre du haut', less: 'retrousse moins la lèvre du haut' },
  mouthLowerDownLeft: { label: 'lèvre basse', more: 'tire davantage la lèvre du bas vers le bas', less: 'relâche la lèvre du bas' },
  mouthLowerDownRight: { label: 'lèvre basse', more: 'tire davantage la lèvre du bas vers le bas', less: 'relâche la lèvre du bas' },
}

/** Les 21 points de MediaPipe, groupés par doigt. Le point 0 est le poignet :
 *  il est l'origine du repère, son écart est nul par construction. */
const FINGERS: { name: string; tip: number; ids: number[] }[] = [
  { name: 'pouce', tip: 4, ids: [1, 2, 3, 4] },
  { name: 'index', tip: 8, ids: [5, 6, 7, 8] },
  { name: 'majeur', tip: 12, ids: [9, 10, 11, 12] },
  { name: 'annulaire', tip: 16, ids: [13, 14, 15, 16] },
  { name: 'auriculaire', tip: 20, ids: [17, 18, 19, 20] },
]

/** En dessous, l'écart est du bruit de reproduction et non une consigne. */
const FACE_FLOOR = 0.06
const FINGER_FLOOR = 0.02
const POS_FLOOR = 0.12

/**
 * Compare une frame vivante au sample le plus proche, et rend des consignes.
 *
 * `sample` doit être le sample le PLUS PROCHE, pas une moyenne : la moyenne de
 * plusieurs prises d'une même pose n'est pas forcément une pose réalisable, et
 * on enverrait alors corriger vers une cible qui n'existe pas.
 */
export function advise(
  sample: FeatureBlocks,
  frame: FeatureBlocks,
  source: GestureSource,
  max = 3,
): Advice[] {
  const out: Advice[] = []

  if ((source === 'face' || source === 'both') && sample.face && frame.face) {
    // Un libellé une seule fois : les paires gauche/droite bougent ensemble et
    // produiraient deux fois la même phrase.
    const seen = new Set<string>()
    const scored = FACE_KEYS.map((key, i) => ({
      key,
      delta: (sample.face![i] ?? 0) - (frame.face![i] ?? 0),
    }))
      .filter((d) => Math.abs(d.delta) >= FACE_FLOOR && FACE_HINTS[d.key])
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    for (const d of scored) {
      const hint = FACE_HINTS[d.key]!
      if (seen.has(hint.label)) continue
      seen.add(hint.label)
      out.push({
        text: d.delta > 0 ? hint.more : hint.less,
        kind: 'face',
        gap: Math.abs(d.delta),
      })
    }
  }

  if (source === 'hand' || source === 'both') {
    for (const slot of [0, 1] as const) {
      const s = sample.hands[slot]
      const f = frame.hands[slot]
      if (s && f) out.push(...adviseHand(s, f))
      const sp = sample.handPos[slot]
      const fp = frame.handPos[slot]
      if (sp && fp) out.push(...advisePosition(sp, fp))
    }
  }

  return out.sort((a, b) => b.gap - a.gap).slice(0, max)
}

/**
 * Quel doigt s'écarte, et dans quel sens.
 *
 * Le repère est canonique — poignet à l'origine, segment poignet→base du majeur
 * vers le haut, échelle rapportée à ce même segment. La distance d'un bout de
 * doigt au poignet y a donc un sens stable : plus grande veut dire plus tendu,
 * plus petite veut dire plus replié. C'est la seule lecture de forme qu'on
 * puisse faire sans inventer.
 */
function adviseHand(s: Float32Array, f: Float32Array): Advice[] {
  const out: Advice[] = []
  for (const finger of FINGERS) {
    let err = 0
    for (const id of finger.ids) {
      const dx = (s[id * 2] ?? 0) - (f[id * 2] ?? 0)
      const dy = (s[id * 2 + 1] ?? 0) - (f[id * 2 + 1] ?? 0)
      err += Math.hypot(dx, dy)
    }
    err /= finger.ids.length
    if (err < FINGER_FLOOR) continue
    const reach = (v: Float32Array) => Math.hypot(v[finger.tip * 2] ?? 0, v[finger.tip * 2 + 1] ?? 0)
    const d = reach(s) - reach(f)
    // Écart de forme sans écart d'extension : le doigt est au bon éloignement
    // mais pas au bon endroit. On le dit sans prétendre savoir dans quel sens.
    const text =
      Math.abs(d) < FINGER_FLOOR / 2
        ? `place ton ${finger.name} autrement — il est à la bonne distance mais pas au bon endroit`
        : d > 0
          ? `tends davantage ton ${finger.name}`
          : `replie davantage ton ${finger.name}`
    out.push({ text, kind: 'hand', gap: err / HAND_SCALE })
  }
  return out
}

/**
 * Où est la main par rapport à la tête.
 *
 * Le flux n'est JAMAIS mirroré : un x plus grand est plus à droite dans
 * l'image, donc du côté GAUCHE de la personne filmée. Se tromper là-dessus
 * donnerait une consigne exactement inverse, et c'est le genre d'erreur qu'on
 * ne voit pas en relisant.
 */
function advisePosition(s: Float32Array, f: Float32Array): Advice[] {
  const out: Advice[] = []
  // On repasse en hauteurs de visage : c'est l'unité dans laquelle la position
  // a été mesurée, et la seule qui veuille dire quelque chose pour un humain.
  const toFace = (v: number) => (v / POS_SCALE) * POS_RANGE
  const dx = toFace((s[0] ?? 0) - (f[0] ?? 0))
  const dy = toFace((s[1] ?? 0) - (f[1] ?? 0))
  if (Math.abs(dx) >= POS_FLOOR) {
    out.push({
      text: dx > 0 ? 'déplace ta main vers ta gauche' : 'déplace ta main vers ta droite',
      kind: 'position',
      gap: Math.abs(dx),
    })
  }
  if (Math.abs(dy) >= POS_FLOOR) {
    // y croît vers le BAS de l'image.
    out.push({
      text: dy > 0 ? 'descends ta main' : 'remonte ta main',
      kind: 'position',
      gap: Math.abs(dy),
    })
  }
  return out
}
