import { frameDistance, gestureDistance } from './distance.js'
import type { FeatureBlocks, GestureSource } from './types.js'

/** Plancher : en dessous, un seuil est plus serré que le bruit de reproduction
 *  d'un humain — la gesture ne déclencherait jamais en conditions réelles. */
export const THRESHOLD_FLOOR = 0.06
/** Marge au-dessus de la dispersion intra-classe. */
export const INTRA_MARGIN = 1.3
/** Fraction de la distance au plus proche voisin qu'on s'autorise. */
export const NEIGHBOR_CAP = 0.6

export interface ThresholdVerdict {
  /** Seuil retenu (si verdict = 'ok'). */
  threshold: number
  maxIntra: number
  nearestOther: { gestureId: string; dist: number } | null
  /** Distance de la frame négative (parole normale) la plus proche. */
  nearestNegative: number | null
  /**
   * Ces trois valeurs sont des CONSTATS, pas des autorisations. Rien ici ne
   * refuse un enregistrement : c'est l'UI qui décide quoi en dire, et
   * l'utilisateur qui décide quoi en faire.
   */
  verdict: 'ok' | 'collision' | 'false_positive_risk'
  /** Gesture en collision, à nommer dans l'UI (feature clé du produit). */
  collidesWith: string | null
}

/**
 * Filtrage des prises : on écarte les samples les plus éloignés du groupe
 * (moyenne des distances aux autres), on garde `keep` samples.
 * La variante *Indices permet de garder les frames BRUTES alignées avec les
 * samples retenus (nécessaire pour la re-featurisation silencieuse).
 */
export function filterOutlierIndices(
  samples: FeatureBlocks[],
  source: GestureSource,
  keep = 8,
): number[] {
  if (samples.length <= keep) return samples.map((_, i) => i)
  const scored = samples.map((s, i) => {
    let acc = 0
    let n = 0
    samples.forEach((o, j) => {
      if (i === j) return
      const d = frameDistance(s, o, source)
      if (d !== null) {
        acc += d
        n++
      }
    })
    return { i, score: n ? acc / n : Infinity }
  })
  scored.sort((a, b) => a.score - b.score)
  return scored
    .slice(0, keep)
    .map((x) => x.i)
    .sort((a, b) => a - b)
}

export function filterOutliers(
  samples: FeatureBlocks[],
  source: GestureSource,
  keep = 8,
): FeatureBlocks[] {
  return filterOutlierIndices(samples, source, keep).map((i) => samples[i]!)
}

/**
 * Seuil auto, homogène en DISTANCES (pas de variance : une variance et une
 * distance ne se comparent pas).
 *   base  = max distance intra-classe × 1.3, plancher THRESHOLD_FLOOR
 *   cap   = distance au plus proche voisin × 0.6
 *   cap < base            → collision : on NOMME la gesture trop proche et on
 *                           garde `base` tel quel, sans le raboter sur le
 *                           voisin. Le rabotage ne réglait rien — le matcher
 *                           est en winner-take-all, la pose la plus proche
 *                           gagne — et rendait la pose plus dure à déclencher
 *                           sans que personne ne sache pourquoi.
 *   négatif < seuil × 1.1 → risque de faux positif pendant la parole normale
 */
export function computeThreshold(
  samples: FeatureBlocks[],
  source: GestureSource,
  others: { gestureId: string; samples: FeatureBlocks[]; source: GestureSource }[],
  negatives: FeatureBlocks[],
): ThresholdVerdict {
  let maxIntra = 0
  for (let i = 0; i < samples.length; i++) {
    for (let j = i + 1; j < samples.length; j++) {
      const d = frameDistance(samples[i]!, samples[j]!, source)
      if (d !== null && d > maxIntra) maxIntra = d
    }
  }
  const base = Math.max(maxIntra * INTRA_MARGIN, THRESHOLD_FLOOR)

  let nearestOther: ThresholdVerdict['nearestOther'] = null
  for (const o of others) {
    if (o.source !== source) continue // blocs différents : pas comparables, pas de collision possible
    for (const s of samples) {
      const d = gestureDistance(o.samples, s, source)
      if (d !== null && (nearestOther === null || d < nearestOther.dist))
        nearestOther = { gestureId: o.gestureId, dist: d }
    }
  }

  let threshold = base
  let verdict: ThresholdVerdict['verdict'] = 'ok'
  let collidesWith: string | null = null
  if (nearestOther) {
    const cap = nearestOther.dist * NEIGHBOR_CAP
    if (cap < base) {
      verdict = 'collision'
      collidesWith = nearestOther.gestureId
    } else {
      threshold = Math.min(base, cap)
    }
  }

  let nearestNegative: number | null = null
  for (const n of negatives) {
    const d = gestureDistance(samples, n, source)
    if (d !== null && (nearestNegative === null || d < nearestNegative)) nearestNegative = d
  }
  if (verdict === 'ok' && nearestNegative !== null && nearestNegative < threshold * 1.1) {
    verdict = 'false_positive_risk'
  }

  return { threshold, maxIntra, nearestOther, nearestNegative, verdict, collidesWith }
}
