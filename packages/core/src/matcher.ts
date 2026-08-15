import { gestureBest, type BlockDiag } from './distance.js'
import { GestureRuntime, type GestureState } from './stateMachine.js'
import type { FeatureBlocks, GestureDef } from './types.js'

export interface MatchEvent {
  type: 'fire' | 'release'
  gestureId: string
  dist: number | null
}

/** Snapshot par gesture pour l'écran Live/Debug (barres de distance). */
export interface GestureSnapshot {
  gestureId: string
  name: string
  dist: number | null
  threshold: number
  state: GestureState
  /** Détail par bloc : ce qui bloque, quand ça ne déclenche pas. */
  blocks: BlockDiag[] | null
}

/**
 * Matcher du profil actif. Une GestureRuntime par gesture.
 * Règle d'exclusivité : seule la gesture argmin peut progresser vers ACTIVE ;
 * les autres reçoivent ∞ — SAUF une gesture déjà ACTIVE, qui garde sa vraie
 * distance pour que l'hystérésis de sortie fonctionne.
 */
export class Matcher {
  private runtimes = new Map<string, GestureRuntime>()
  private gestures: GestureDef[] = []

  setGestures(gestures: GestureDef[]): void {
    this.gestures = gestures.filter((g) => g.enabled && g.samples.length > 0)
    const keep = new Set(this.gestures.map((g) => g.id))
    for (const id of [...this.runtimes.keys()]) if (!keep.has(id)) this.runtimes.delete(id)
    for (const g of this.gestures) {
      const rt = this.runtimes.get(g.id)
      if (rt) rt.params = g
      else this.runtimes.set(g.id, new GestureRuntime(g))
    }
  }

  /** Coupe tout : les gestures actives relâchent, tout repart d'IDLE. */
  panic(): MatchEvent[] {
    const out: MatchEvent[] = []
    for (const [id, rt] of this.runtimes) {
      if (rt.state === 'ACTIVE') out.push({ type: 'release', gestureId: id, dist: null })
      rt.reset()
    }
    return out
  }

  step(frame: FeatureBlocks, now: number): { events: MatchEvent[]; snapshots: GestureSnapshot[] } {
    const dists = new Map<string, number | null>()
    const blocks = new Map<string, BlockDiag[] | null>()
    let bestId: string | null = null
    let bestDist = Infinity
    for (const g of this.gestures) {
      const r = gestureBest(g.samples, frame, g.source)
      dists.set(g.id, r.dist)
      blocks.set(g.id, r.blocks)
      if (r.dist !== null && r.dist < bestDist) {
        bestDist = r.dist
        bestId = g.id
      }
    }

    const events: MatchEvent[] = []
    const snapshots: GestureSnapshot[] = []
    for (const g of this.gestures) {
      const rt = this.runtimes.get(g.id)!
      const real = dists.get(g.id) ?? null
      const fed = g.id === bestId || rt.state === 'ACTIVE' ? real : null
      const ev = rt.step(fed, now)
      if (ev) events.push({ type: ev, gestureId: g.id, dist: real })
      snapshots.push({
        gestureId: g.id,
        name: g.name,
        dist: real,
        threshold: g.threshold,
        state: rt.state,
        blocks: blocks.get(g.id) ?? null,
      })
    }
    return { events, snapshots }
  }
}
