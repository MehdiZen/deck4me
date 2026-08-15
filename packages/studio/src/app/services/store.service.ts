import { Injectable, computed, inject, signal } from '@angular/core'
import {
  FEATURIZER_VERSION,
  blocksFromJson,
  blocksToJson,
  computeBaseline,
  featurizeRaw,
  type FeatureBlocks,
  type FeatureBlocksJson,
  type GestureDef,
  type GestureSource,
  type HoldMode,
  type RawFrame,
  type RenderParams,
} from '@facememe/core'
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

export interface Calibration {
  featurizerVersion: number
  baseline: number[]
  negativesRaw: RawFrame[]
  savedAt: string
}

interface Bootstrap {
  gestures: StoredGesture[]
  bindings: StoredBinding[]
  assets: AssetMeta[]
  defaultAssetId: string | null
  overlayUrl: string
  hasCalibration: boolean
  port: number
}

@Injectable({ providedIn: 'root' })
export class StoreService {
  private tauri = inject(TauriService)

  readonly loaded = signal(false)
  readonly gestures = signal<StoredGesture[]>([])
  readonly bindings = signal<StoredBinding[]>([])
  readonly assets = signal<AssetMeta[]>([])
  readonly overlayUrl = signal('')
  readonly port = signal(47821)
  readonly calibration = signal<Calibration | null>(null)

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

  private token = computed(() => new URL(this.overlayUrl() || 'http://x/?t=').searchParams.get('t') ?? '')

  assetUrl(a: AssetMeta): string {
    return `http://127.0.0.1:${this.port()}/assets/${a.id}.${a.ext}?t=${this.token()}`
  }

  async load(): Promise<void> {
    const boot = await this.tauri.invoke<Bootstrap>('bootstrap', {}, {
      gestures: [],
      bindings: [],
      assets: [],
      defaultAssetId: null,
      overlayUrl: '',
      hasCalibration: false,
      port: 47821,
    })
    this.gestures.set(boot.gestures)
    this.bindings.set(boot.bindings)
    this.assets.set(boot.assets)
    this.overlayUrl.set(boot.overlayUrl)
    this.port.set(boot.port)
    if (boot.hasCalibration) {
      const cal = await this.tauri.invoke<Calibration | null>('get_calibration', {}, null)
      this.calibration.set(cal)
    }
    await this.migrateFeaturizerVersion()
    this.loaded.set(true)
  }

  /** featurizerVersion a bougé → re-featurisation SILENCIEUSE depuis le brut,
   *  persistée. « 3 gestures à réenregistrer » n'est que le fallback sans raw. */
  private async migrateFeaturizerVersion(): Promise<void> {
    const b = this.baseline()
    for (const g of this.gestures()) {
      if (g.featurizerVersion === FEATURIZER_VERSION || !g.rawSamples.length) continue
      const migrated: StoredGesture = {
        ...g,
        samples: g.rawSamples.map((r) => blocksToJson(featurizeRaw(r, b))),
        featurizerVersion: FEATURIZER_VERSION,
      }
      await this.saveGesture(migrated)
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
    this.gestures.update((all) => [...all.filter((x) => x.id !== g.id), g])
  }

  /** Réglage en direct pendant le glissement du curseur : mémoire seulement,
   *  pour que le matcher et les barres réagissent sans écrire sur le disque
   *  à chaque pixel. */
  setSensitivityLocal(id: string, sensitivity: number): void {
    this.gestures.update((all) =>
      all.map((g) => (g.id === id ? { ...g, sensitivity } : g)),
    )
  }

  /** Persiste l'état courant d'une gesture (fin de glissement). */
  async persistGesture(id: string): Promise<void> {
    const g = this.gestures().find((x) => x.id === id)
    if (!g) return
    await this.tauri.invoke('save_gesture', { gesture: g })
  }

  async deleteGesture(id: string): Promise<void> {
    await this.tauri.invoke('delete_gesture', { id })
    this.gestures.update((all) => all.filter((x) => x.id !== id))
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

  /** Binding minimal phase 3 : défauts sains, le réglage fin arrive en phase 4.
   *  Changer d'image conserve les réglages de rendu déjà faits. */
  async bindAsset(gestureId: string, assetId: string): Promise<void> {
    const existing = this.bindings().find((b) => b.gestureId === gestureId)
    const binding: StoredBinding = {
      anchor: 'center',
      x: 0,
      y: 0,
      scale: 1,
      durationMs: 3000,
      enter: 'pop',
      exit: 'fade',
      layer: 0,
      ...existing,
      id: existing?.id ?? crypto.randomUUID(),
      gestureId,
      assetId,
    }
    await this.tauri.invoke('save_binding', { binding })
    this.bindings.update((all) => [...all.filter((b) => b.id !== binding.id), binding])
  }

  async updateBinding(gestureId: string, patch: Partial<RenderParams>): Promise<void> {
    const existing = this.bindings().find((b) => b.gestureId === gestureId)
    if (!existing) return
    const binding: StoredBinding = { ...existing, ...patch }
    await this.tauri.invoke('save_binding', { binding })
    this.bindings.update((all) => [...all.filter((b) => b.id !== binding.id), binding])
  }

  async unbind(gestureId: string): Promise<void> {
    const b = this.bindings().find((x) => x.gestureId === gestureId)
    if (!b) return
    await this.tauri.invoke('delete_binding', { id: b.id })
    this.bindings.update((all) => all.filter((x) => x.id !== b.id))
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
    for (const g of this.gestures()) {
      if (!g.rawSamples.length) continue
      await this.saveGesture({
        ...g,
        samples: g.rawSamples.map((r) => blocksToJson(featurizeRaw(r, b))),
        featurizerVersion: FEATURIZER_VERSION,
      })
    }
  }
}
