import { describe, expect, it } from 'vitest'
import { GestureRuntime, HYSTERESIS } from '../src/stateMachine.js'
import type { GestureParams } from '../src/types.js'

const P: GestureParams = {
  threshold: 0.1,
  framesToTrigger: 5,
  cooldownMs: 1500,
  holdMode: 'while_held',
}

function feed(rt: GestureRuntime, dists: number[], startNow = 0, dtMs = 33) {
  const events: (string | null)[] = []
  dists.forEach((d, i) => events.push(rt.step(d, startNow + i * dtMs)))
  return events
}

describe('GestureRuntime', () => {
  it('fire après framesToTrigger frames consécutives sous le seuil', () => {
    const rt = new GestureRuntime({ ...P })
    const ev = feed(rt, [0.05, 0.05, 0.05, 0.05, 0.05])
    expect(ev).toEqual([null, null, null, null, 'fire'])
    expect(rt.state).toBe('ACTIVE')
  })

  it('une frame au-dessus du seuil pendant CANDIDATE remet à zéro', () => {
    const rt = new GestureRuntime({ ...P })
    const ev = feed(rt, [0.05, 0.05, 0.2, 0.05, 0.05, 0.05, 0.05, 0.05])
    expect(ev.filter((e) => e === 'fire')).toHaveLength(1)
    expect(ev[7]).toBe('fire') // il a fallu repartir de zéro après la frame 0.2
  })

  it("hystérésis : osciller entre threshold et threshold×1.4 ne relâche PAS", () => {
    const rt = new GestureRuntime({ ...P })
    feed(rt, [0.05, 0.05, 0.05, 0.05, 0.05])
    // oscillation dans la zone morte : 0.1 < d < 0.14
    const ev = feed(rt, [0.12, 0.13, 0.11, 0.135, 0.12], 1000)
    expect(ev.every((e) => e === null)).toBe(true)
    expect(rt.state).toBe('ACTIVE')
  })

  it('release au-delà de threshold×HYSTERESIS puis cooldown puis IDLE', () => {
    const rt = new GestureRuntime({ ...P })
    feed(rt, [0.05, 0.05, 0.05, 0.05, 0.05])
    expect(rt.step(P.threshold * HYSTERESIS + 0.01, 1000)).toBe('release')
    expect(rt.state).toBe('COOLDOWN')
    // pendant le cooldown, même une distance parfaite ne redéclenche pas
    expect(rt.step(0.01, 1100)).toBeNull()
    expect(rt.state).toBe('COOLDOWN')
    rt.step(0.01, 1000 + P.cooldownMs)
    expect(rt.state).toBe('IDLE')
  })

  it('fixed_duration : one-shot, cooldown immédiat, pas de release', () => {
    const rt = new GestureRuntime({ ...P, holdMode: 'fixed_duration' })
    const ev = feed(rt, [0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05])
    expect(ev.filter((e) => e === 'fire')).toHaveLength(1)
    expect(ev.filter((e) => e === 'release')).toHaveLength(0)
    expect(rt.state).toBe('COOLDOWN')
  })

  it('distance null (main invisible) = ∞', () => {
    const rt = new GestureRuntime({ ...P })
    feed(rt, [0.05, 0.05, 0.05, 0.05, 0.05])
    expect(rt.step(null, 1000)).toBe('release')
  })
})
