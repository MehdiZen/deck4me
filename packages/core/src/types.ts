// Types partagés Studio / core. Le contrat WS (TriggerEvent & co) vit ici aussi :
// le Rust le duplique en serde, un test d'intégration vérifie l'isomorphisme.

export type Handedness = 'Left' | 'Right'

export interface Landmark {
  x: number
  y: number
  z: number
}

export interface BlendshapeCategory {
  categoryName: string
  score: number
}

export interface RawHand {
  handedness: Handedness
  landmarks: Landmark[] // 21 points MediaPipe
}

/** Ancre visage pour situer les mains PAR RAPPORT à la tête (featurizer v2) :
 *  nez + échelle inter-oculaire, en coordonnées image normalisées. */
export interface FaceAnchor {
  nose: { x: number; y: number }
  scale: number
}

/** Frame brute telle que sortie de MediaPipe — c'est CE format qu'on persiste
 *  (re-featurisation silencieuse possible quand FEATURIZER_VERSION change).
 *  faceAnchor est absent des enregistrements v1 : le bloc position est alors
 *  simplement ignoré, rien ne casse. */
export interface RawFrame {
  face: BlendshapeCategory[] | null
  hands: RawHand[]
  faceAnchor?: FaceAnchor | null
}

/** Vecteurs featurisés, par bloc. hands[0]=Left, hands[1]=Right (label brut
 *  MediaPipe, flux jamais mirroré — convention verrouillée).
 *  hands = forme des doigts (invariante position/échelle/rotation),
 *  handPos = position du poignet relative au visage (ce qui distingue
 *  « mains aux épaules » de « mains derrière la tête »). */
export interface FeatureBlocks {
  face: Float32Array | null
  hands: [Float32Array | null, Float32Array | null]
  handPos: [Float32Array | null, Float32Array | null]
}

export type GestureSource = 'face' | 'hand' | 'both'
export type HoldMode = 'while_held' | 'fixed_duration'

export interface GestureParams {
  threshold: number
  framesToTrigger: number
  cooldownMs: number
  holdMode: HoldMode
}

export interface GestureDef extends GestureParams {
  id: string
  profileId: string
  name: string
  enabled: boolean
  source: GestureSource
  /** Samples featurisés (5–8 après filtrage), reconstruits depuis rawSamples au boot si besoin. */
  samples: FeatureBlocks[]
  /** Frames brutes des samples retenus — la vraie source de vérité. */
  rawSamples: RawFrame[]
  featurizerVersion: number
}

export type Anchor = 'tl' | 'tc' | 'tr' | 'ml' | 'center' | 'mr' | 'bl' | 'bc' | 'br'
export type EnterFx = 'pop' | 'fade' | 'slide'
export type ExitFx = 'fade' | 'shrink'

export interface RenderParams {
  anchor: Anchor
  x: number // offset en % de la largeur canvas
  y: number // offset en % de la hauteur canvas
  scale: number // 1 = taille native
  durationMs: number
  enter: EnterFx
  exit: ExitFx
  layer: number
  sound?: { url: string; volume: number }
}

export interface BindingDef extends RenderParams {
  id: string
  gestureId: string
  assetId: string
}

export interface TriggerEvent extends RenderParams {
  bindingId: string
  assetUrl: string
  /** while_held : l'overlay attend un ReleaseMsg au lieu du timer durationMs. */
  hold: boolean
}

// ---- Messages WS serveur → overlay ----
export interface PreloadMsg {
  type: 'preload'
  assets: string[]
}
export interface TriggerMsg extends TriggerEvent {
  type: 'trigger'
}
export interface ReleaseMsg {
  type: 'release'
  bindingId: string
}
export interface ClearMsg {
  type: 'clear'
  bindingId?: string
}
export interface ReloadMsg {
  type: 'reload'
}
export type WsMsg = PreloadMsg | TriggerMsg | ReleaseMsg | ClearMsg | ReloadMsg
