import { Injectable, computed, inject, signal } from '@angular/core'
import {
  DEFAULT_RENDER,
  FEATURIZER_VERSION,
  blocksFromJson,
  blocksToJson,
  computeBaseline,
  featurizeRaw,
  migrateRenderParams,
  type FeatureBlocks,
  type FeatureBlocksJson,
  type GestureDef,
  type GestureSource,
  type HoldMode,
  type RawFrame,
  type MacroDef,
  type RenderParams,
  type SoundRef,
} from '@meme4me/core'
import { TauriService } from './tauri.service'

export interface AssetMeta {
  id: string
  filename: string
  mime: string
  ext: string
  width: number
  height: number
  sizeBytes: number
}

export const isAudio = (a: AssetMeta): boolean => a.mime.startsWith('audio/')

/** Sans canal alpha : le meme arrivera avec un fond dans OBS. On l'accepte —
 *  beaucoup de memes marchent en rectangle assumé — mais on le dit. */
export const isOpaque = (a: AssetMeta): boolean => a.mime === 'image/jpeg'

/** Extensions proposées à l'import d'un visuel. Le format réel est décidé côté
 *  Rust sur les octets ; cette liste ne fait que filtrer le sélecteur Windows. */
export const IMAGE_ACCEPT = '.png,.gif,.webp,.avif,.jpg,.jpeg,.webm'

export interface Profile {
  id: string
  name: string
  isActive: boolean
}

export interface Settings {
  /** action → accélérateur ("CmdOrCtrl+Shift+P"). Vide = non assigné. */
  hotkeys: Record<string, string>
  autoUpdateCheck: boolean
  /** Webcam republiée, retenue par NOM : l'index bouge au branchement. */
  vcamDevice: string
  /** Définition diffusée, "LxH@fps". Vide = automatique. */
  vcamFormat: string
  vcamAutoStart: boolean
  detectionAutoStart: boolean
  detectionCamera: string
}

export const DEFAULT_SETTINGS: Settings = {
  hotkeys: {},
  autoUpdateCheck: true,
  vcamDevice: '',
  vcamFormat: '',
  vcamAutoStart: false,
  detectionAutoStart: false,
  detectionCamera: '',
}

/** Gesture telle que persistée (samples en JSON, frames brutes incluses). */
export interface StoredGesture {
  id: string
  profileId: string
  name: string
  enabled: boolean
  source: GestureSource
  samples: FeatureBlocksJson[]
  rawSamples: RawFrame[]
  threshold: number
  /** Seuil calculé par le wizard — référence stable pour le réglage manuel. */
  thresholdAuto?: number
  /** Multiplicateur utilisateur (1 = auto). >1 = plus permissif. */
  sensitivity?: number
  framesToTrigger: number
  cooldownMs: number
  holdMode: HoldMode
  featurizerVersion: number
  /** Maillon d'enchaînement : la pose est reconnue et alimente les macros,
   *  mais ne déclenche pas de meme à elle seule. Sans ce drapeau, faire
   *  « OK puis 3 » afficherait aussi le meme du OK au passage. */
  sequenceOnly?: boolean
}

/** Seuil réellement appliqué : l'auto, modulé par le réglage utilisateur. */
export function effectiveThreshold(g: StoredGesture): number {
  return (g.thresholdAuto ?? g.threshold) * (g.sensitivity ?? 1)
}

export interface StoredBinding extends RenderParams {
  id: string
  gestureId: string
  assetId: string
}

export { DEFAULT_RENDER }

export interface Calibration {
  featurizerVersion: number
  baseline: number[]
  negativesRaw: RawFrame[]
  savedAt: string
}

interface Bootstrap {
  profiles: Profile[]
  gestures: StoredGesture[]
  bindings: StoredBinding[]
  macros: MacroDef[]
  assets: AssetMeta[]
  defaultAssetId: string | null
  settings: Settings
  overlayUrl: string
  hasCalibration: boolean
  port: number
  version: string
  /** Panne du serveur local au démarrage — port occupé, seconde instance. */
  serverError: string | null
  logPath: string | null
}

@Injectable({ providedIn: 'root' })
export class StoreService {
  private tauri = inject(TauriService)

  readonly loaded = signal(false)
  readonly profiles = signal<Profile[]>([])
  readonly allGestures = signal<StoredGesture[]>([])
  readonly bindings = signal<StoredBinding[]>([])
  readonly allMacros = signal<MacroDef[]>([])
  readonly assets = signal<AssetMeta[]>([])
  readonly settings = signal<Settings>({ ...DEFAULT_SETTINGS })
  readonly overlayUrl = signal('')
  readonly port = signal(47821)
  readonly version = signal('')
  /** Panne bloquante du serveur local : sans lui, l'overlay OBS ne reçoit
   *  jamais rien, et sans message on chercherait du côté d'OBS. */
  readonly serverError = signal<string | null>(null)
  readonly logPath = signal<string | null>(null)
  readonly calibration = signal<Calibration | null>(null)

  readonly activeProfile = computed<Profile | null>(
    () => this.profiles().find((p) => p.isActive) ?? this.profiles()[0] ?? null,
  )

  /** Tout l'écran ne voit QUE le profil actif : c'est ce qui rend le
   *  basculement instantané (aucune gesture d'un autre profil n'est armée). */
  readonly gestures = computed(() => {
    const active = this.activeProfile()?.id ?? 'default'
    return this.allGestures().filter((g) => (g.profileId || 'default') === active)
  })

  /** Comme les gestures, seules celles du profil actif sont armées. */
  readonly macros = computed(() => {
    const active = this.activeProfile()?.id ?? 'default'
    return this.allMacros().filter((m) => (m.profileId || 'default') === active)
  })

  /** Gestures engagées dans au moins une macro du profil actif : l'interface
   *  s'en sert pour expliquer pourquoi une pose ne déclenche rien seule. */
  readonly gesturesInMacros = computed(() => {
    const out = new Set<string>()
    for (const m of this.macros()) for (const s of m.steps) out.add(s)
    return out
  })

  readonly imageAssets = computed(() => this.assets().filter((a) => !isAudio(a)))
  readonly soundAssets = computed(() => this.assets().filter((a) => isAudio(a)))

  readonly baseline = computed<Float32Array | null>(() => {
    const c = this.calibration()
    return c ? Float32Array.from(c.baseline) : null
  })

  /** Négatifs (parole normale) featurisés avec la baseline courante — pour le wizard. */
  readonly negatives = computed<FeatureBlocks[]>(() => {
    const c = this.calibration()
    const b = this.baseline()
    return c ? c.negativesRaw.map((r) => featurizeRaw(r, b)) : []
  })

  /** Gestures prêtes pour le Matcher : re-featurisées depuis les frames brutes
   *  avec la baseline COURANTE. Le champ `samples` persisté n'est qu'un cache :
   *  changer de baseline ou de FEATURIZER_VERSION ne casse jamais rien. */
  readonly runtimeGestures = computed<GestureDef[]>(() => {
    const b = this.baseline()
    return this.gestures().map((g) => ({
      ...g,
      samples: g.rawSamples.length
        ? g.rawSamples.map((r) => featurizeRaw(r, b))
        : g.samples.map(blocksFromJson),
      threshold: effectiveThreshold(g),
      featurizerVersion: FEATURIZER_VERSION,
    }))
  })

  private token = computed(
    () => new URL(this.overlayUrl() || 'http://x/?t=').searchParams.get('t') ?? '',
  )

  assetUrl(a: AssetMeta): string {
    return `http://127.0.0.1:${this.port()}/assets/${a.id}.${a.ext}?t=${this.token()}`
  }

  asset(id: string | null | undefined): AssetMeta | null {
    return id ? (this.assets().find((a) => a.id === id) ?? null) : null
  }

  async load(): Promise<void> {
    const boot = await this.tauri.invoke<Bootstrap>('bootstrap', {}, {
      profiles: [{ id: 'default', name: 'Défaut', isActive: true }],
      gestures: [],
      bindings: [],
      macros: [],
      assets: [],
      defaultAssetId: null,
      settings: { ...DEFAULT_SETTINGS },
      overlayUrl: '',
      hasCalibration: false,
      port: 47821,
      version: '',
      serverError: null,
      logPath: null,
    })
    this.profiles.set(boot.profiles)
    this.allGestures.set(boot.gestures)
    this.bindings.set(boot.bindings)
    this.allMacros.set(boot.macros ?? [])
    this.assets.set(boot.assets)
    this.settings.set({ ...DEFAULT_SETTINGS, ...boot.settings })
    this.overlayUrl.set(boot.overlayUrl)
    this.port.set(boot.port)
    this.version.set(boot.version)
    this.serverError.set(boot.serverError ?? null)
    this.logPath.set(boot.logPath ?? null)
    if (boot.hasCalibration) {
      const cal = await this.tauri.invoke<Calibration | null>('get_calibration', {}, null)
      this.calibration.set(cal)
    }
    await this.migrateFeaturizerVersion()
    await this.migrateRenderModel()
    this.loaded.set(true)
  }

  /** featurizerVersion a bougé → re-featurisation SILENCIEUSE depuis le brut,
   *  persistée. « 3 gestures à réenregistrer » n'est que le fallback sans raw. */
  private async migrateFeaturizerVersion(): Promise<void> {
    const b = this.baseline()
    for (const g of this.allGestures()) {
      if (g.featurizerVersion === FEATURIZER_VERSION || !g.rawSamples.length) continue
      await this.saveGesture({
        ...g,
        samples: g.rawSamples.map((r) => blocksToJson(featurizeRaw(r, b))),
        featurizerVersion: FEATURIZER_VERSION,
      })
    }
  }

  /** Rendu v1 → v2, une fois, à la lecture. La conversion elle-même vit dans
   *  le core (elle appartient au format) et y est couverte par des tests. */
  private async migrateRenderModel(): Promise<void> {
    for (const b of this.bindings()) {
      if (typeof b.sizePct === 'number') continue
      const a = this.asset(b.assetId)
      const params = migrateRenderParams(b, a ? { width: a.width, height: a.height } : null)
      await this.saveBinding({ ...params, id: b.id, gestureId: b.gestureId, assetId: b.assetId })
    }
  }

  /** Gestures sans frames brutes ET d'une autre version : à réenregistrer. */
  readonly staleGestures = computed(() =>
    this.gestures().filter(
      (g) => g.featurizerVersion !== FEATURIZER_VERSION && !g.rawSamples.length,
    ),
  )

  async saveGesture(g: StoredGesture): Promise<void> {
    await this.tauri.invoke('save_gesture', { gesture: g })
    this.allGestures.update((all) => [...all.filter((x) => x.id !== g.id), g])
  }

  /** Réglage en direct pendant le glissement du curseur : mémoire seulement,
   *  pour que le matcher et les barres réagissent sans écrire sur le disque
   *  à chaque pixel. */
  setSensitivityLocal(id: string, sensitivity: number): void {
    this.allGestures.update((all) => all.map((g) => (g.id === id ? { ...g, sensitivity } : g)))
  }

  /** Persiste l'état courant d'une gesture (fin de glissement). */
  async persistGesture(id: string): Promise<void> {
    const g = this.allGestures().find((x) => x.id === id)
    if (!g) return
    await this.tauri.invoke('save_gesture', { gesture: g })
  }

  async deleteGesture(id: string): Promise<void> {
    await this.tauri.invoke('delete_gesture', { id })
    this.allGestures.update((all) => all.filter((x) => x.id !== id))
    this.bindings.update((all) => all.filter((x) => x.gestureId !== id))
  }

  async uploadAsset(file: File): Promise<AssetMeta> {
    const buf = new Uint8Array(await file.arrayBuffer())
    let bin = ''
    const CHUNK = 0x8000
    for (let i = 0; i < buf.length; i += CHUNK)
      bin += String.fromCharCode(...buf.subarray(i, i + CHUNK))
    const meta = await this.tauri.invoke<AssetMeta>('upload_asset', {
      filename: file.name,
      dataBase64: btoa(bin),
    })
    this.assets.update((all) => [...all.filter((a) => a.id !== meta.id), meta])
    return meta
  }

  /** Import par URL. Le téléchargement se fait côté Rust : la webview se ferait
   *  refuser la moitié des liens par CORS, et le Rust peut refuser les adresses
   *  du réseau local — coller une URL ne doit pas faire sonder ton réseau. */
  async importFromUrl(url: string): Promise<AssetMeta> {
    const meta = await this.tauri.invoke<AssetMeta>('import_asset_from_url', { url })
    this.assets.update((all) => [...all.filter((a) => a.id !== meta.id), meta])
    return meta
  }

  binding(gestureId: string): StoredBinding | null {
    return this.bindings().find((b) => b.gestureId === gestureId) ?? null
  }

  /** Écrit un binding tel quel — l'éditeur est propriétaire de son objet. */
  async saveBinding(binding: StoredBinding): Promise<void> {
    await this.tauri.invoke('save_binding', { binding })
    this.bindings.update((all) => [...all.filter((b) => b.id !== binding.id), binding])
  }

  /** Associe une image à une gesture. Changer d'image conserve les réglages
   *  de rendu déjà faits — repartir des défauts effacerait le cadrage. */
  async bindAsset(gestureId: string, assetId: string): Promise<StoredBinding> {
    const existing = this.binding(gestureId)
    const binding: StoredBinding = {
      ...DEFAULT_RENDER,
      ...existing,
      id: existing?.id ?? crypto.randomUUID(),
      gestureId,
      assetId,
    }
    await this.saveBinding(binding)
    return binding
  }

  async updateBinding(gestureId: string, patch: Partial<RenderParams>): Promise<void> {
    const existing = this.binding(gestureId)
    if (!existing) return
    await this.saveBinding({ ...existing, ...patch })
  }

  async setSound(gestureId: string, sound: SoundRef | null): Promise<void> {
    await this.updateBinding(gestureId, { sound })
  }

  async unbind(gestureId: string): Promise<void> {
    const b = this.binding(gestureId)
    if (!b) return
    await this.tauri.invoke('delete_binding', { id: b.id })
    this.bindings.update((all) => all.filter((x) => x.id !== b.id))
  }

  /** Aperçu dans OBS d'un binding pas encore enregistré (éditeur). */
  async previewBinding(binding: StoredBinding): Promise<void> {
    await this.tauri.invoke('preview_binding', { binding })
  }

  // ---- Macros (enchaînements) ----
  //
  // Une macro réutilise tout le chemin des bindings : son binding a pour
  // `gestureId` l'identifiant de la macro. Aucun cas particulier nulle part.

  async saveMacro(m: MacroDef): Promise<void> {
    await this.tauri.invoke('save_macro', { macroDef: m })
    this.allMacros.update((all) => [...all.filter((x) => x.id !== m.id), m])
  }

  async deleteMacro(id: string): Promise<void> {
    await this.tauri.invoke('delete_macro', { id })
    this.allMacros.update((all) => all.filter((x) => x.id !== id))
    this.bindings.update((all) => all.filter((b) => b.gestureId !== id))
  }

  // ---- Profils (phase 6) ----

  async saveProfile(profile: Profile): Promise<void> {
    this.profiles.set(await this.tauri.invoke<Profile[]>('save_profile', { profile }, []))
  }

  async deleteProfile(id: string): Promise<void> {
    const res = await this.tauri.invoke<{
      profiles: Profile[]
      gestures: StoredGesture[]
      bindings: StoredBinding[]
      macros: MacroDef[]
    }>('delete_profile', { id })
    this.profiles.set(res.profiles)
    this.allGestures.set(res.gestures)
    this.bindings.set(res.bindings)
    this.allMacros.set(res.macros ?? [])
  }

  async setActiveProfile(id: string): Promise<void> {
    this.profiles.set(await this.tauri.invoke<Profile[]>('set_active_profile', { id }, []))
  }

  /** Rotation utilisée par le raccourci global « profil suivant ». */
  async nextProfile(): Promise<void> {
    const all = this.profiles()
    if (all.length < 2) return
    const i = all.findIndex((p) => p.isActive)
    await this.setActiveProfile(all[(i + 1) % all.length]!.id)
  }

  // ---- Réglages (phase 6) ----

  async saveSettings(patch: Partial<Settings>): Promise<void> {
    const next = { ...this.settings(), ...patch }
    this.settings.set(next)
    await this.tauri.invoke('save_settings', { settings: next })
  }

  async saveCalibration(negativesRaw: RawFrame[]): Promise<void> {
    const baseline = Array.from(computeBaseline(negativesRaw))
    const cal: Calibration = {
      featurizerVersion: FEATURIZER_VERSION,
      baseline,
      negativesRaw,
      savedAt: new Date().toISOString(),
    }
    await this.tauri.invoke('save_calibration', { calibration: cal })
    this.calibration.set(cal)
    // Nouvelle baseline → les caches persistés des gestures sont refaits en douce
    const b = this.baseline()
    for (const g of this.allGestures()) {
      if (!g.rawSamples.length) continue
      await this.saveGesture({
        ...g,
        samples: g.rawSamples.map((r) => blocksToJson(featurizeRaw(r, b))),
        featurizerVersion: FEATURIZER_VERSION,
      })
    }
  }
}
