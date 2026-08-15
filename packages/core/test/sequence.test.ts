import { beforeEach, describe, expect, it } from 'vitest'
import { SequenceMatcher, type MacroDef } from '../src/sequence.js'

const macro = (over: Partial<MacroDef> = {}): MacroDef => ({
  id: 'm1',
  profileId: 'default',
  name: 'test',
  enabled: true,
  steps: ['ok', 'trois'],
  windowMs: 1500,
  ...over,
})

describe('SequenceMatcher', () => {
  let sm: SequenceMatcher

  beforeEach(() => {
    sm = new SequenceMatcher()
    sm.setMacros([macro()])
  })

  it('déclenche quand la séquence est faite dans la fenêtre', () => {
    expect(sm.push('ok', 0)).toHaveLength(0)
    const done = sm.push('trois', 1000)
    expect(done.map((m) => m.id)).toEqual(['m1'])
  })

  it('ne déclenche pas si la fenêtre est dépassée', () => {
    sm.push('ok', 0)
    expect(sm.push('trois', 1501)).toHaveLength(0)
  })

  it("l'ordre compte", () => {
    sm.push('trois', 0)
    expect(sm.push('ok', 500)).toHaveLength(0)
  })

  it('une pose étrangère casse la séquence', () => {
    sm.push('ok', 0)
    sm.push('autre', 200)
    expect(sm.push('trois', 400)).toHaveLength(0)
  })

  it('la première pose répétée réamorce au lieu de tout perdre', () => {
    // « OK, OK, 3 » doit marcher : on hésite, on refait le premier geste.
    sm.push('ok', 0)
    sm.push('ok', 300)
    expect(sm.push('trois', 600).map((m) => m.id)).toEqual(['m1'])
  })

  it('une pose étrangère qui ouvre la macro la redémarre', () => {
    sm.setMacros([macro({ steps: ['ok', 'trois', 'poing'] })])
    sm.push('ok', 0)
    sm.push('trois', 300)
    sm.push('ok', 600) // casse la fin, mais réamorce
    sm.push('trois', 900)
    expect(sm.push('poing', 1200)).toHaveLength(1)
  })

  it('la fenêtre se mesure entre maillons, pas depuis le début', () => {
    sm.setMacros([macro({ steps: ['a', 'b', 'c'], windowMs: 1000 })])
    sm.push('a', 0)
    sm.push('b', 900)
    // 1800 ms depuis le début, mais 900 depuis le maillon précédent
    expect(sm.push('c', 1800)).toHaveLength(1)
  })

  it('rejoue après un déclenchement complet', () => {
    sm.push('ok', 0)
    expect(sm.push('trois', 500)).toHaveLength(1)
    sm.push('ok', 1000)
    expect(sm.push('trois', 1500)).toHaveLength(1)
  })

  it('une fenêtre expirée ne bloque pas un nouvel enchaînement', () => {
    sm.push('ok', 0)
    sm.push('trois', 5000) // trop tard, mais « trois » n'ouvre pas la macro
    expect(sm.push('ok', 5100)).toHaveLength(0)
    expect(sm.push('trois', 5600).map((m) => m.id)).toEqual(['m1'])
  })

  it('plusieurs macros peuvent partager un préfixe', () => {
    sm.setMacros([
      macro({ id: 'a', steps: ['ok', 'un'] }),
      macro({ id: 'b', steps: ['ok', 'deux'] }),
    ])
    sm.push('ok', 0)
    expect(sm.push('deux', 300).map((m) => m.id)).toEqual(['b'])
  })

  it('ignore les macros désactivées ou trop courtes', () => {
    sm.setMacros([
      macro({ id: 'off', enabled: false }),
      macro({ id: 'court', steps: ['ok'] }),
    ])
    expect(sm.push('ok', 0)).toHaveLength(0)
  })

  it("expose l'avancement pour l'affichage, sans les fenêtres expirées", () => {
    sm.push('ok', 0)
    expect(sm.progress(500)).toEqual([{ macroId: 'm1', done: 1, total: 2, lastAt: 0 }])
    expect(sm.progress(2000)).toHaveLength(0)
  })

  it('liste les gestures engagées dans une macro', () => {
    sm.setMacros([macro({ steps: ['ok', 'trois'] }), macro({ id: 'm2', steps: ['ok', 'poing'] })])
    expect([...sm.gesturesInUse()].sort()).toEqual(['ok', 'poing', 'trois'])
  })

  it('panic remet tous les enchaînements à zéro', () => {
    sm.push('ok', 0)
    sm.reset()
    expect(sm.push('trois', 300)).toHaveLength(0)
  })
})
