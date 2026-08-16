import { Injectable, computed, inject, signal } from '@angular/core'
import {
  DEFAULT_RENDER,
  FEATURIZER_VERSION,
  NEIGHBOR_CAP,
  blocksFromJson,
  blocksToJson,
  computeBaseline,
  computeThreshold,
  featurizeRaw,
  migrateRenderParams,
  normalizeAction,
  type ActionDef,
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
  actions: ActionDef[]
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
  /** Actions de TOUS les profils : leur propriétaire est une gesture ou une
   *  macro, et c'est lui qui porte le profil. Elles n'en ont pas besoin. */
  readonly actions = signal<ActionDef[]>([])
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

  /**
   * Deux familles de poses, qui ne se mélangent jamais dans l'interface.
   *
   * Une pose à meme est une fin en soi : elle affiche quelque chose. Une pose de
   * maillon n'existe que pour armer un enchaînement — pas de meme, pas d'action
   * propre (le matcher ne la déclenche même pas seule), pas de mode « tenue ».
   * Les afficher dans la même liste revenait à mélanger des objets qui n'ont ni
   * les mêmes réglages ni le même sens.
   *
   * Le drapeau `sequenceOnly` EST la frontière : le basculer déplace la pose
   * d'une famille à l'autre, ce qui rend le classement réversible et lisible.
   */
  readonly memeGestures = computed(() => this.gestures().filter((g) => !g.sequenceOnly))
  readonly linkGestures = computed(() => this.gestures().filter((g) => !!g.sequenceOnly))

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
      actions: [],
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
    this.actions.set((boot.actions ?? []).map(normalizeAction))
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
    // La calibration D'ABORD : tout ce qui suit se featurise avec sa baseline.
    await this.migrateCalibration()
    await this.migrateFeaturizerVersion()
    await this.migrateRenderModel()
    await this.dropOrphanActions()
    this.loaded.set(true)
  }

  /**
   * Recalcule la baseline quand le featurizer a changé de dimensions.
   *
   * Une baseline est un tableau de la taille de FACE_KEYS au moment où elle a
   * été écrite. Les nouvelles clés n'y ont donc aucune entrée et ne verraient
   * jamais leur biais morphologique soustrait — précisément ce que la
   * calibration existe pour faire, et ce qui compte le plus avec des lunettes.
   * Les frames neutres brutes étant conservées, le recalcul est silencieux.
   */
  private async migrateCalibration(): Promise<void> {
    const c = this.calibration()
    if (!c || c.featurizerVersion === FEATURIZER_VERSION || !c.negativesRaw?.length) return
    const next: Calibration = {
      ...c,
      featurizerVersion: FEATURIZER_VERSION,
      baseline: Array.from(computeBaseline(c.negativesRaw)),
    }
    await this.tauri.invoke('save_calibration', { calibration: next })
    this.calibration.set(next)
  }

  /**
   * Une action n'appartient qu'à une MACRO.
   *
   * Une pose seule peut partir par accident ; un enchaînement de deux gestes
   * volontaires, non. Confier « lance ce script » à une pose isolée était le
   * maillon faible de tout le modèle — d'autant qu'un meme a déjà son son.
   *
   * Reste le cas des actions attachées à une gesture par une version
   * antérieure : plus aucun écran ne les montre, mais le chemin de
   * déclenchement les exécuterait encore. Invisible ET actif, c'est le pire
   * mode d'échec possible — on les supprime, et on le dit dans le journal.
   */
  private async dropOrphanActions(): Promise<void> {
    const macroIds = new Set(this.allMacros().map((m) => m.id))
    const orphans = this.actions().filter((a) => !macroIds.has(a.ownerId))
    if (!orphans.length) return
    for (const a of orphans) await this.deleteAction(a.id)
    console.warn(
      `${orphans.length} action(s) n'appartenaient à aucune macro et ont été supprimées :`,
      orphans.map((a) => a.label || a.target),
    )
  }

  /**
   * featurizerVersion a bougé → re-featurisation SILENCIEUSE depuis le brut.
   * « N gestures à réenregistrer » n'est que le fallback sans frames brutes.
   *
   * Le seuil est recalculé, et ce n'est pas un luxe : la distance est une RMS
   * normalisée par le nombre de dimensions, donc ajouter des clés au visage
   * RÉTRÉCIT toutes les distances. Un seuil hérité deviendrait mécaniquement
   * plus permissif — c'est-à-dire des faux positifs en direct, sans que rien
   * n'ait l'air d'avoir changé. Le multiplicateur `sensitivity` réglé à la main
   * est en revanche conservé : il est relatif au seuil auto, pas absolu.
   */
  private async migrateFeaturizerVersion(): Promise<void> {
    const b = this.baseline()
    const stale = this.allGestures().filter(
      (g) => g.featurizerVersion !== FEATURIZER_VERSION && g.rawSamples.length,
    )
    if (!stale.length) return

    // Deux passes : on refeaturise TOUT avant de calculer le moindre seuil,
    // sinon une gesture serait comparée à des voisines encore dans l'ancien
    // espace, et le seuil obtenu n'aurait aucun sens.
    const refeaturized = new Map(
      this.allGestures().map((g) => [
        g.id,
        g.rawSamples.length
          ? g.rawSamples.map((r) => featurizeRaw(r, b))
          : g.samples.map(blocksFromJson),
      ]),
    )
    const negatives = this.negatives()

    for (const g of stale) {
      const samples = refeaturized.get(g.id)!
      const others = this.allGestures()
        .filter((o) => o.id !== g.id && (o.profileId || 'default') === (g.profileId || 'default'))
        .map((o) => ({ gestureId: o.id, samples: refeaturized.get(o.id)!, source: o.source }))
      const v = computeThreshold(samples, g.source, others, negatives)
      // Sur un verdict de collision, `threshold` n'est PAS plafonné par le
      // voisin — c'est voulu côté wizard, qui refuse alors l'enregistrement.
      // Ici on ne peut rien refuser : on prend le minimum, donc le plus strict.
      const threshold = v.nearestOther
        ? Math.min(v.threshold, v.nearestOther.dist * NEIGHBOR_CAP)
        : v.threshold
      await this.saveGesture({
        ...g,
        samples: samples.map(blocksToJson),
        threshold,
        thresholdAuto: threshold,
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
    this.actions.update((all) => all.filter((a) => a.ownerId !== id))
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

  /** Macros du profil actif qui se servent de cette pose — c'est l'information
   *  qui manque le plus sur une carte de maillon : à quoi elle sert. */
  macrosUsing(gestureId: string): MacroDef[] {
    return this.macros().filter((m) => m.steps.includes(gestureId))
  }

  /**
   * Maillons enregistrés qui n'arment encore aucune macro, dans leur ordre
   * d'enregistrement.
   *
   * C'est le stock que l'interface doit consommer d'elle-même : quelqu'un qui
   * vient d'enregistrer trois poses pour une macro ne devrait pas avoir à les
   * redésigner une par une dans des listes déroulantes — il les a déjà
   * désignées en les enregistrant.
   */
  readonly freeLinkGestures = computed(() => {
    const used = this.gesturesInMacros()
    return this.linkGestures().filter((g) => !used.has(g.id))
  })

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
    this.actions.update((all) => all.filter((a) => a.ownerId !== id))
  }

  // ---- Actions ----
  //
  // Le propriétaire d'une action est une gesture OU une macro : `ownerId` ne
  // distingue pas, et les deux passent déjà par le même chemin de déclenchement.

  /** Actions d'un déclencheur, dans l'ordre d'exécution. */
  actionsOf(ownerId: string): ActionDef[] {
    return this.actions()
      .filter((a) => a.ownerId === ownerId)
      .sort((x, y) => x.order - y.order)
  }

  async saveAction(a: ActionDef): Promise<void> {
    await this.tauri.invoke('save_action', { action: a })
    this.actions.update((all) => [...all.filter((x) => x.id !== a.id), a])
  }

  async deleteAction(id: string): Promise<void> {
    await this.tauri.invoke('delete_action', { id })
    this.actions.update((all) => all.filter((a) => a.id !== id))
  }

  /** Réécrit les rangs après un déplacement — le tableau reçu fait foi. */
  async reorderActions(list: ActionDef[]): Promise<void> {
    for (const [i, a] of list.entries()) {
      if (a.order !== i) await this.saveAction({ ...a, order: i })
    }
  }

  /** Exécute une action seule et REMONTE l'erreur : sans ça, régler un webhook
   *  ou un raccourci se ferait à l'aveugle, en se contorsionnant devant la
   *  webcam pour voir si quelque chose se passe. */
  async testAction(a: ActionDef): Promise<void> {
    await this.tauri.invoke('test_action', { action: a })
  }

  /** Noms de touches acceptés — la table fait autorité côté Rust. */
  async keyNames(): Promise<string[]> {
    return this.tauri.invoke<string[]>('key_names', {}, [])
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
      actions: ActionDef[]
    }>('delete_profile', { id })
    this.profiles.set(res.profiles)
    this.allGestures.set(res.gestures)
    this.bindings.set(res.bindings)
    this.allMacros.set(res.macros ?? [])
    this.actions.set((res.actions ?? []).map(normalizeAction))
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
