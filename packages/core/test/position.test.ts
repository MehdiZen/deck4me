import { describe, expect, it } from 'vitest'
import { featurize } from '../src/featurizer.js'
import { frameDistance } from '../src/distance.js'
import type { FaceAnchor, Landmark, RawHand } from '../src/types.js'

// Le cas réel qui a motivé le bloc position : deux poses à mains ouvertes
// identiques, l'une aux épaules, l'autre derrière la tête → sans position on
// les confondait.

function openHand(cx: number, cy: number): RawHand {
  const pts: Landmark[] = []
  for (let i = 0; i < 21; i++) {
    pts.push({ x: cx + Math.sin(i * 1.7) * 0.03, y: cy - i * 0.008, z: 0 })
  }
  return { handedness: 'Right', landmarks: pts }
}

/** Repère v7 : origine entre les yeux, échelle sur la hauteur du visage.
 *  `nose`/`scale` sont là parce que le type les porte encore pour les vieux
 *  enregistrements, mais plus rien ne les lit. */
const anchor: FaceAnchor = {
  nose: { x: 0.5, y: 0.34 },
  scale: 0.08,
  eyes: { x: 0.5, y: 0.3 },
  height: 0.22,
}

/** Repère d'avant la v7 : le nouveau champ manque, il est irrécupérable. */
const legacy: FaceAnchor = { nose: { x: 0.5, y: 0.34 }, scale: 0.08 }

describe('position des mains relative au visage', () => {
  it('même forme de main, positions différentes → distinguées', () => {
    const shoulders = featurize(null, [openHand(0.72, 0.55)], null, anchor)
    const behindHead = featurize(null, [openHand(0.58, 0.18)], null, anchor)
    const d = frameDistance(shoulders, behindHead, 'hand')
    expect(d).not.toBeNull()
    expect(d!).toBeGreaterThan(0.1) // largement au-dessus d'un seuil réaliste
  })

  it('un léger décalage de main ne tue PAS le match (tolérance de reproduction)', () => {
    const ref = featurize(null, [openHand(0.72, 0.55)], null, anchor)
    // ~3 cm de dérive : la main n'est jamais exactement au même endroit
    const drifted = featurize(null, [openHand(0.745, 0.575)], null, anchor)
    const d = frameDistance(ref, drifted, 'hand')!
    expect(d).toBeLessThan(0.06) // sous le plancher de seuil
  })

  it('même forme, même position → quasi identiques', () => {
    const a = featurize(null, [openHand(0.72, 0.55)], null, anchor)
    const b = featurize(null, [openHand(0.72, 0.55)], null, anchor)
    expect(frameDistance(a, b, 'hand')).toBeLessThan(1e-6)
  })

  it('invariant à la distance caméra (ancre + main plus proches/grosses ensemble)', () => {
    const far = featurize(null, [openHand(0.72, 0.55)], null, anchor)
    // 2× plus proche : tout est 2× plus grand autour du milieu des yeux
    const zoom = (p: number, c: number) => c + (p - c) * 2
    const nearHand = openHand(0, 0)
    nearHand.landmarks = openHand(0.72, 0.55).landmarks.map((p) => ({
      x: zoom(p.x, anchor.eyes!.x),
      y: zoom(p.y, anchor.eyes!.y),
      z: p.z,
    }))
    const nearAnchor: FaceAnchor = { ...anchor, height: anchor.height! * 2 }
    const near = featurize(null, [nearHand], null, nearAnchor)
    expect(frameDistance(far, near, 'hand')!).toBeLessThan(0.02)
  })

  /**
   * LA régression qui a motivé la v7 : signe correct, main immobile, mais le
   * regard part vers le second écran → ça ne déclenchait plus.
   *
   * Tête tournée d'environ 40° : l'écart entre les yeux perd 30 % en
   * projection, le bout du nez se déplace franchement (il dépasse), tandis que
   * la hauteur du visage et le milieu des yeux ne bougent quasiment pas.
   * L'ancien repère se servait précisément des deux grandeurs qui bougent.
   */
  it('la tête qui tourne ne déplace PAS la main', () => {
    const face = featurize(null, [openHand(0.72, 0.55)], null, anchor)
    const turned: FaceAnchor = {
      nose: { x: 0.53, y: 0.345 }, // le nez dépasse et suit la rotation
      scale: 0.08 * 0.7, // inter-oculaire écrasé par la projection
      eyes: { x: 0.503, y: 0.3 }, // creux entre les yeux : quasi immobile
      height: 0.22, // hauteur du visage : inchangée par un lacet
    }
    const sideways = featurize(null, [openHand(0.72, 0.55)], null, turned)
    expect(frameDistance(face, sideways, 'hand')!).toBeLessThan(0.01)
  })

  it('un enregistrement d’avant la v7 tombe en forme seule au lieu de mentir', () => {
    // Le repère v7 ne peut pas être reconstruit : les points du visage qui
    // l'auraient permis n'ont jamais été persistés. Comparer une position v2 à
    // une position v7 donnerait des distances absurdes en silence — mieux vaut
    // renoncer au bloc.
    const old = featurize(null, [openHand(0.72, 0.55)], null, legacy)
    expect(old.handPos[1]).toBeNull()

    const frame = featurize(null, [openHand(0.2, 0.8)], null, anchor)
    // formes identiques, positions très différentes → jugé sur la forme seule
    expect(frameDistance(old, frame, 'hand')!).toBeLessThan(1e-5)
  })

  it('sample v7 : si la frame ne peut pas fournir la position (visage perdu) → pas de match', () => {
    const sample = featurize(null, [openHand(0.72, 0.55)], null, anchor)
    const blindFrame = featurize(null, [openHand(0.72, 0.55)], null, null)
    expect(frameDistance(sample, blindFrame, 'hand')).toBeNull()
  })
})
