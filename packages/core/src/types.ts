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

/**
 * Ancre visage pour situer les mains PAR RAPPORT à la tête, en coordonnées
 * image normalisées.
 *
 * `nose` + `scale` (inter-oculaire) sont le repère v2, conservés parce que les
 * enregistrements faits avant la v7 ne contiennent que ceux-là. Ils ne sont
 * plus utilisés pour featuriser : voir featurizePosition.
 *
 * `eyes` + `height` sont le repère v7, insensible à la rotation de la tête.
 * Optionnels par nécessité — une frame relue depuis la base peut être plus
 * vieille que le champ.
 */
export interface FaceAnchor {
  nose: { x: number; y: number }
  scale: number
  /** Milieu des coins externes des yeux. Origine stable en rotation, là où le
   *  bout du nez, lui, dépasse et se déplace. */
  eyes?: { x: number; y: number }
  /** Hauteur du visage, front→menton. Ne rétrécit pas quand la tête tourne sur
   *  le côté, contrairement à l'écart entre les yeux. */
  height?: number
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

/** Ancrage du modèle de rendu v1 — lu à la migration, plus jamais écrit. */
export type Anchor = 'tl' | 'tc' | 'tr' | 'ml' | 'center' | 'mr' | 'bl' | 'bc' | 'br'

export type EnterFx = 'pop' | 'fade' | 'slide' | 'drop' | 'shake' | 'spin'
export type ExitFx = 'fade' | 'shrink' | 'slide' | 'drop'

export const ENTER_FX: EnterFx[] = ['pop', 'fade', 'slide', 'drop', 'shake', 'spin']
export const EXIT_FX: ExitFx[] = ['fade', 'shrink', 'slide', 'drop']

/** Son attaché à un binding. Le binding ne stocke QUE l'identifiant d'asset :
 *  l'URL (et donc le jeton) est résolue côté Rust au moment du trigger. */
export interface SoundRef {
  assetId: string
  volume: number
}

/**
 * Rendu v2, entièrement relatif au cadre de l'overlay.
 *   x, y   — centre de l'élément, en % du cadre (0 = bord gauche/haut)
 *   sizePct — largeur de l'élément, en % de la LARGEUR du cadre
 * Tout est proportionnel : le même binding rend pareil en 1080p et en 1440p.
 * Le v1 (anchor + offsets + scale relatif aux pixels natifs) dérivait dès que
 * la source de navigateur OBS changeait de taille.
 */
export interface RenderParams {
  x: number
  y: number
  sizePct: number
  durationMs: number
  enter: EnterFx
  exit: ExitFx
  layer: number
  sound?: SoundRef | null
  /** Champs v1 conservés le temps de la migration — jamais réécrits. */
  anchor?: Anchor
  scale?: number
}

export interface BindingDef extends RenderParams {
  id: string
  gestureId: string
  assetId: string
}

/** Ce qui part réellement sur le fil vers l'overlay. */
export interface TriggerEvent {
  bindingId: string
  assetUrl: string
  x: number
  y: number
  sizePct: number
  durationMs: number
  enter: EnterFx
  exit: ExitFx
  layer: number
  /** while_held : l'overlay attend un ReleaseMsg au lieu du timer durationMs. */
  hold: boolean
  sound?: { url: string; volume: number }
  /** Numéro de séquence — l'overlay le renvoie pour mesurer l'aller-retour. */
  seq?: number
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

/** Seul message overlay → serveur : accusé d'affichage. Il ferme la boucle de
 *  mesure — le Rust connaît l'instant d'émission, il en déduit l'aller-retour
 *  réel jusqu'au navigateur OBS (phase 5). */
export interface AckMsg {
  type: 'ack'
  seq: number
}
