import type { FeatureBlocks, GestureSource } from './types.js'

/**
 * Distance RMS par dimension entre deux vecteurs de même taille.
 * Normaliser par la dimension rend les blocs face (23 dims) et main (42 dims)
 * comparables — les seuils vivent tous dans le même espace.
 * (Cosinus rejeté : blendshapes tous positifs → toute la dynamique écrasée
 * dans les derniers pourcents de similarité.)
 */
export function blockDistance(a: Float32Array, b: Float32Array): number {
  let acc = 0
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!
    acc += d * d
  }
  return Math.sqrt(acc / a.length)
}

export type BlockKind = 'face' | 'hand' | 'position'

/** Détail par bloc — c'est ce qui permet de dire à l'utilisateur CE QUI cloche
 *  (« main D absente », « position trop loin ») plutôt qu'un simple « ça matche pas ». */
export interface BlockDiag {
  kind: BlockKind
  slot: 0 | 1 | null
  /** null = bloc requis par le sample mais absent de la frame. */
  dist: number | null
}

/**
 * Décomposition sample↔frame. Retourne null si le sample n'a aucun bloc
 * comparable pour cette source (sample invalide), sinon un bloc par partie.
 */
export function frameBlocks(
  sample: FeatureBlocks,
  frame: FeatureBlocks,
  source: GestureSource,
): BlockDiag[] | null {
  const out: BlockDiag[] = []

  if (source === 'face' || source === 'both') {
    if (!sample.face) return null // sample invalide pour cette source
    out.push({
      kind: 'face',
      slot: null,
      dist: frame.face ? blockDistance(sample.face, frame.face) : null,
    })
  }

  if (source === 'hand' || source === 'both') {
    let anyHand = false
    for (const slot of [0, 1] as const) {
      const s = sample.hands[slot]
      if (!s) continue
      anyHand = true
      const f = frame.hands[slot]
      out.push({ kind: 'hand', slot, dist: f ? blockDistance(s, f) : null })
      // Position relative au visage (v2). Un sample v1 n'en a pas : bloc
      // ignoré, comportement v1 conservé. Un sample v2 l'exige : si la frame
      // ne peut pas la fournir (visage perdu), pas de match — jamais un
      // match « au bénéfice du doute ».
      const sp = sample.handPos[slot]
      if (sp) {
        const fp = frame.handPos[slot]
        out.push({ kind: 'position', slot, dist: fp ? blockDistance(sp, fp) : null })
      }
    }
    if (!anyHand) return null
  }

  return out.length ? out : null
}

/**
 * Distance sample↔frame pour une gesture donnée.
 * Retourne null si un bloc requis par le sample est absent de la frame
 * (main non visible, visage perdu) : pas de match possible, pas un match lointain.
 */
export function frameDistance(
  sample: FeatureBlocks,
  frame: FeatureBlocks,
  source: GestureSource,
): number | null {
  const blocks = frameBlocks(sample, frame, source)
  if (!blocks) return null
  let acc = 0
  for (const b of blocks) {
    if (b.dist === null) return null
    acc += b.dist
  }
  return acc / blocks.length
}

/**
 * kNN k=1 + décomposition du meilleur sample.
 * Si aucun sample n'est comparable (bloc manquant), on renvoie quand même la
 * décomposition du premier sample exploitable : c'est elle qui explique le
 * « pourquoi ça ne déclenche pas ».
 */
export function gestureBest(
  samples: FeatureBlocks[],
  frame: FeatureBlocks,
  source: GestureSource,
): { dist: number | null; blocks: BlockDiag[] | null } {
  let bestDist: number | null = null
  let bestBlocks: BlockDiag[] | null = null
  let fallback: BlockDiag[] | null = null

  for (const s of samples) {
    const blocks = frameBlocks(s, frame, source)
    if (!blocks) continue
    if (!fallback) fallback = blocks
    let acc = 0
    let complete = true
    for (const b of blocks) {
      if (b.dist === null) {
        complete = false
        break
      }
      acc += b.dist
    }
    if (!complete) continue
    const d = acc / blocks.length
    if (bestDist === null || d < bestDist) {
      bestDist = d
      bestBlocks = blocks
    }
  }
  return { dist: bestDist, blocks: bestBlocks ?? fallback }
}

/** kNN k=1 : min sur les samples de la gesture. null si aucun sample comparable. */
export function gestureDistance(
  samples: FeatureBlocks[],
  frame: FeatureBlocks,
  source: GestureSource,
): number | null {
  return gestureBest(samples, frame, source).dist
}
