import type { GestureParams } from './types.js'

export type GestureState = 'IDLE' | 'CANDIDATE' | 'ACTIVE' | 'COOLDOWN'
export type GestureEvent = 'fire' | 'release' | null

/**
 * Sortie d'ACTIVE à threshold × 1.4 : sans cette hystérésis l'overlay clignote
 * quand la distance oscille autour du seuil. Bug n°1 de ce type d'app.
 */
export const HYSTERESIS = 1.4

/**
 * Une machine PAR gesture (un cooldown global bloquerait les autres gestures).
 * step() est pur vis-à-vis du temps : `now` est injecté, testable sans horloge.
 */
export class GestureRuntime {
  state: GestureState = 'IDLE'
  private count = 0
  private cooldownStart = 0

  constructor(public params: GestureParams) {}

  reset(): void {
    this.state = 'IDLE'
    this.count = 0
  }

  step(dist: number | null, now: number): GestureEvent {
    const d = dist ?? Infinity
    const p = this.params
    switch (this.state) {
      case 'IDLE':
        if (d < p.threshold) {
          this.state = 'CANDIDATE'
          this.count = 1
        }
        return null

      case 'CANDIDATE':
        if (d < p.threshold) {
          this.count++
          if (this.count >= p.framesToTrigger) {
            if (p.holdMode === 'fixed_duration') {
              // one-shot : l'overlay gère durationMs, la gesture part en cooldown
              this.state = 'COOLDOWN'
              this.cooldownStart = now
            } else {
              this.state = 'ACTIVE'
            }
            return 'fire'
          }
        } else {
          this.state = 'IDLE'
          this.count = 0
        }
        return null

      case 'ACTIVE':
        // uniquement en while_held
        if (d > p.threshold * HYSTERESIS) {
          this.state = 'COOLDOWN'
          this.cooldownStart = now
          return 'release'
        }
        return null

      case 'COOLDOWN':
        if (now - this.cooldownStart >= p.cooldownMs) {
          this.state = 'IDLE'
          this.count = 0
        }
        return null
    }
  }
}
