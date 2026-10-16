import type { Anchor, RenderParams } from './types.js'

/** Cadre de référence dans lequel le modèle v1 avait été réglé. */
export const REF_W = 1920
export const REF_H = 1080

export const DEFAULT_RENDER: RenderParams = {
  x: 50,
  y: 50,
  sizePct: 25,
  durationMs: 3000,
  enter: 'pop',
  exit: 'fade',
  layer: 0,
  sound: null,
  destination: 'stream',
}

/** Point d'ancrage v1 → position équivalente, en % du cadre. */
const ANCHOR_ORIGIN: Record<Anchor, [number, number]> = {
  tl: [0, 0],
  tc: [50, 0],
  tr: [100, 0],
  ml: [0, 50],
  center: [50, 50],
  mr: [100, 50],
  bl: [0, 100],
  bc: [50, 100],
  br: [100, 100],
}

export interface AssetSize {
  width: number
  height: number
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * Convertit un binding v1 (ancre + décalages + échelle relative aux pixels
 * natifs) vers le v2 (centre et largeur en % du cadre).
 *
 * Le v1 dérivait dès que la source de navigateur OBS changeait de taille :
 * « scale 1 » voulait dire « la taille native du fichier », donc un GIF de
 * 480 px occupait un quart d'un cadre 1080p et la moitié d'un cadre 960p.
 * Le v2 n'exprime plus que des proportions ; la conversion suppose donc le
 * cadre 1920×1080 dans lequel le réglage v1 avait été fait — c'est la seule
 * hypothèse possible, et elle est juste pour tout le monde sauf les cas
 * exotiques, qui se recadrent en trois secondes dans l'éditeur.
 */
export function migrateRenderParams(
  b: Partial<RenderParams>,
  asset: AssetSize | null,
): RenderParams {
  if (typeof b.sizePct === 'number') {
    return { ...DEFAULT_RENDER, ...b } as RenderParams
  }
  const nativeW = asset?.width || 480
  const nativeH = asset?.height || Math.round(nativeW * 0.5625)
  const sizePct = clamp(((nativeW * (b.scale ?? 1)) / REF_W) * 100, 2, 100)
  // Hauteur occupée, exprimée en % de la HAUTEUR du cadre : le rapport 16/9
  // convertit une fraction de largeur en fraction de hauteur.
  const heightPct = ((nativeH / nativeW) * sizePct * REF_W) / REF_H
  const [ox, oy] = ANCHOR_ORIGIN[b.anchor ?? 'center']
  // Sauf au centre, le point d'ancrage désigne un bord de l'élément : le
  // centre est donc décalé d'une demi-taille vers l'intérieur du cadre.
  const x = ox + (b.x ?? 0) + (ox === 0 ? sizePct / 2 : ox === 100 ? -sizePct / 2 : 0)
  const y = oy + (b.y ?? 0) + (oy === 0 ? heightPct / 2 : oy === 100 ? -heightPct / 2 : 0)

  const { anchor: _a, scale: _s, ...rest } = b
  return {
    ...DEFAULT_RENDER,
    ...rest,
    x: clamp(x, 0, 100),
    y: clamp(y, 0, 100),
    sizePct,
  }
}
