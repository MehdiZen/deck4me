import { describe, expect, it } from 'vitest'
import {
  ACTION_MAX_WAIT_MS,
  actionsOf,
  chainDurationMs,
  describeAction,
  newAction,
  normalizeAction,
  validateAction,
  type ActionDef,
  type ActionKind,
} from '../src/action.js'

const make = (kind: ActionKind, over: Partial<ActionDef> = {}): ActionDef => ({
  ...newAction('owner', 0),
  kind,
  ...over,
})

describe('validateAction', () => {
  it('refuse une cible vide pour tout ce qui vise quelque chose', () => {
    for (const k of ['open', 'run', 'keys'] as ActionKind[]) {
      expect(validateAction(make(k, { target: '   ' })), k).not.toBeNull()
    }
  })

  it("ne rogne pas le texte à taper — trois espaces, c'est trois espaces", () => {
    expect(validateAction(make('text', { target: '   ' }))).toBeNull()
    expect(validateAction(make('text', { target: '' }))).not.toBeNull()
  })

  it('accepte une cible renseignée', () => {
    expect(validateAction(make('open', { target: 'spotify:playlist:37i9' }))).toBeNull()
    expect(validateAction(make('run', { target: 'C:\\bin\\truc.exe' }))).toBeNull()
    expect(validateAction(make('keys', { target: 'Ctrl+Shift+M' }))).toBeNull()
  })

  it("exige http(s) pour une requête — un chemin local n'est pas une URL", () => {
    expect(validateAction(make('http', { target: 'localhost:8123' }))).not.toBeNull()
    expect(validateAction(make('http', { target: 'file:///c:/x' }))).not.toBeNull()
    expect(validateAction(make('http', { target: 'http://192.168.1.50:8123/api' }))).toBeNull()
  })

  it('borne la pause des deux côtés', () => {
    expect(validateAction(make('wait', { waitMs: 0 }))).not.toBeNull()
    expect(validateAction(make('wait', { waitMs: ACTION_MAX_WAIT_MS + 1 }))).not.toBeNull()
    expect(validateAction(make('wait', { waitMs: 500 }))).toBeNull()
  })
})

describe('describeAction', () => {
  it("l'étiquette de l'utilisateur prime sur le résumé calculé", () => {
    const a = make('open', { target: 'notepad.exe', label: 'Bloc-notes' })
    expect(describeAction(a)).toBe('Bloc-notes')
  })

  it('recompose la ligne de commande pour un exécutable', () => {
    const a = make('run', { target: 'py', args: ['scene.py', '--live'] })
    expect(describeAction(a)).toBe('py scene.py --live')
  })

  it('tronque un texte long', () => {
    const a = make('text', { target: 'x'.repeat(60) })
    expect(describeAction(a)).toContain('…')
    expect(describeAction(a).length).toBeLessThan(50)
  })

  it('montre la méthode HTTP, qui change tout au sens de la requête', () => {
    const a = make('http', { target: 'https://example.com/hook', method: 'PUT' })
    expect(describeAction(a)).toBe('PUT https://example.com/hook')
  })
})

describe('actionsOf', () => {
  it("ne rend que le propriétaire demandé, dans l'ordre déclaré", () => {
    const all: ActionDef[] = [
      make('open', { id: 'c', ownerId: 'g1', order: 2 }),
      make('open', { id: 'a', ownerId: 'g1', order: 0 }),
      make('open', { id: 'z', ownerId: 'g2', order: 0 }),
      make('open', { id: 'b', ownerId: 'g1', order: 1 }),
    ]
    expect(actionsOf(all, 'g1').map((a) => a.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('chainDurationMs', () => {
  it("ne compte que les pauses actives — une action désactivée n'attend pas", () => {
    const list = [
      make('wait', { waitMs: 300 }),
      make('wait', { waitMs: 700, enabled: false }),
      make('open', { target: 'x' }),
    ]
    expect(chainDurationMs(list)).toBe(300)
  })
})

describe('normalizeAction', () => {
  it("complète un enregistrement partiel plutôt que de produire des undefined", () => {
    const a = normalizeAction({ id: 'x', ownerId: 'g1', kind: 'keys', target: 'F13' } as never)
    expect(a.args).toEqual([])
    expect(a.method).toBe('POST')
    expect(a.enabled).toBe(true)
    expect(a.waitMs).toBeGreaterThan(0)
  })

  it('conserve un enabled explicitement faux', () => {
    const a = normalizeAction({ id: 'x', ownerId: 'g1', enabled: false } as never)
    expect(a.enabled).toBe(false)
  })

  it('répare un args qui ne serait pas un tableau', () => {
    const a = normalizeAction({ id: 'x', ownerId: 'g1', args: 'notepad' } as never)
    expect(a.args).toEqual([])
  })
})
