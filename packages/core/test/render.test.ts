import { describe, expect, it } from 'vitest'
import { DEFAULT_RENDER, migrateRenderParams } from '../src/render.js'
import type { RenderParams } from '../src/types.js'

const asset = { width: 480, height: 270 }

describe('migrateRenderParams', () => {
  it('laisse intact un binding déjà en v2', () => {
    const v2: RenderParams = { ...DEFAULT_RENDER, x: 12, y: 88, sizePct: 40 }
    expect(migrateRenderParams(v2, asset)).toMatchObject({ x: 12, y: 88, sizePct: 40 })
  })

  it("traduit l'échelle v1 en fraction du cadre de référence", () => {
    // 480 px natifs × 2 = 960 px sur un cadre de 1920 → la moitié
    const out = migrateRenderParams({ anchor: 'center', x: 0, y: 0, scale: 2 }, asset)
    expect(out.sizePct).toBeCloseTo(50, 5)
  })

  it('centre le point d\'ancrage « center » au milieu du cadre', () => {
    const out = migrateRenderParams({ anchor: 'center', x: 0, y: 0, scale: 1 }, asset)
    expect(out.x).toBeCloseTo(50, 5)
    expect(out.y).toBeCloseTo(50, 5)
  })

  it('rentre un coin dans le cadre au lieu de le laisser à cheval', () => {
    // Ancré en haut à gauche, l'élément v1 a son COIN en (0,0) : son centre
    // est donc à une demi-taille de chaque bord, pas à l'origine.
    const out = migrateRenderParams({ anchor: 'tl', x: 0, y: 0, scale: 1 }, asset)
    expect(out.sizePct).toBeCloseTo(25, 5)
    expect(out.x).toBeCloseTo(12.5, 5)
    // 270/480 × 25 % de largeur = 14,06 % de largeur, soit 25 % de hauteur
    expect(out.y).toBeCloseTo(12.5, 1)
  })

  it('reporte les décalages v1 et pousse le coin bas-droit vers l\'intérieur', () => {
    const out = migrateRenderParams({ anchor: 'br', x: -5, y: -5, scale: 1 }, asset)
    expect(out.x).toBeCloseTo(82.5, 5) // 100 - 5 - 12.5
    expect(out.y).toBeCloseTo(82.5, 1)
  })

  it('ne laisse jamais un binding hors du cadre', () => {
    const out = migrateRenderParams({ anchor: 'tr', x: 400, y: -900, scale: 1 }, asset)
    expect(out.x).toBeLessThanOrEqual(100)
    expect(out.y).toBeGreaterThanOrEqual(0)
  })

  it('abandonne les champs v1 au lieu de les recopier', () => {
    const out = migrateRenderParams({ anchor: 'bl', x: 0, y: 0, scale: 1 }, asset)
    expect(out.anchor).toBeUndefined()
    expect(out.scale).toBeUndefined()
  })

  it('survit à un asset de dimensions inconnues (webm)', () => {
    const out = migrateRenderParams({ anchor: 'center', x: 0, y: 0, scale: 1 }, {
      width: 0,
      height: 0,
    })
    expect(Number.isFinite(out.sizePct)).toBe(true)
    expect(out.sizePct).toBeGreaterThan(0)
  })

  it('conserve les réglages qui ne changent pas de sens', () => {
    const out = migrateRenderParams(
      { anchor: 'center', x: 0, y: 0, scale: 1, durationMs: 8000, enter: 'slide', layer: 3 },
      asset,
    )
    expect(out.durationMs).toBe(8000)
    expect(out.enter).toBe('slide')
    expect(out.layer).toBe(3)
  })
})
