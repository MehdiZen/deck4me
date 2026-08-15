import { Injectable, inject, signal } from '@angular/core'
import { DetectionService } from './detection.service'
import { StoreService } from './store.service'
import { TauriService } from './tauri.service'

export interface VcamStatus {
  registered: boolean
  running: boolean
  connected: boolean
  width: number
  height: number
  fps: number
  camera: string | null
  error: string | null
}

export interface VcamDevice {
  index: number
  name: string
}

export interface VcamFormat {
  width: number
  height: number
  fps: number
}

export const EMPTY_VCAM: VcamStatus = {
  registered: false,
  running: false,
  connected: false,
  width: 0,
  height: 0,
  fps: 0,
  camera: null,
  error: null,
}

/**
 * Pilotage de la caméra virtuelle.
 *
 * Ceci vit dans un service et non dans la carte de Réglages pour une raison
 * précise : la reprise au lancement doit avoir lieu AU LANCEMENT. Tant que la
 * logique habitait le composant, elle ne s'exécutait que si l'utilisateur
 * ouvrait l'écran Réglages — c'est-à-dire jamais, puisque l'application ouvre
 * sur l'écran Live. L'option promettait quelque chose qu'elle ne faisait pas.
 */
@Injectable({ providedIn: 'root' })
export class VcamService {
  private tauri = inject(TauriService)
  private detection = inject(DetectionService)
  private store = inject(StoreService)

  readonly status = signal<VcamStatus>(EMPTY_VCAM)
  readonly devices = signal<VcamDevice[]>([])
  readonly formats = signal<VcamFormat[]>([])
  /** "" = automatique, sinon "LxH@fps". */
  readonly formatKey = signal('')
  readonly selected = signal(-1)
  readonly busy = signal(false)
  /** La détection a bien été rebasculée sur la caméra virtuelle. */
  readonly switched = signal(false)

  private autoStarted = false

  async readStatus(): Promise<void> {
    if (this.busy()) return // ne pas empiler les appels
    try {
      const s = await this.tauri.invoke<VcamStatus | null>('vcam_status', {}, null)
      // en cas d'échec, on garde le dernier état connu plutôt que de faire
      // clignoter l'UI entre « installé » et « non installé »
      if (s) this.status.set(s)
    } catch {
      /* transitoire, on réessaiera au prochain tick */
    }
  }

  /** Énumération des caméras : à la demande uniquement (Media Foundation met
   *  parfois une seconde à répondre). */
  async refresh(): Promise<void> {
    this.busy.set(true)
    try {
      const devs = await this.tauri.invoke<VcamDevice[]>('vcam_devices', {}, [])
      this.devices.set(devs)
      if (this.selected() < 0 && devs.length) {
        // Retrouver la caméra retenue par son NOM ; à défaut, la première.
        const saved = this.store.settings().vcamDevice
        this.selected.set(devs.find((d) => d.name === saved)?.index ?? devs[0]!.index)
        this.formatKey.set(this.store.settings().vcamFormat)
      }
      if (this.selected() >= 0 && !this.status().running) await this.loadFormats()
    } catch (e) {
      this.status.update((s) => ({ ...s, error: String(e) }))
    } finally {
      this.busy.set(false)
    }
    await this.readStatus()
  }

  /** Modes réellement supportés — il faut ouvrir la caméra pour les connaître,
   *  d'où l'échec silencieux si elle est occupée (on reste en automatique). */
  async loadFormats(): Promise<void> {
    try {
      const list = await this.tauri.invoke<VcamFormat[]>(
        'vcam_formats',
        { cameraIndex: this.selected() },
        [],
      )
      this.formats.set(list)
      // La définition retenue peut ne plus exister sur cette caméra : mieux
      // vaut retomber sur « automatique » qu'échouer à l'ouverture.
      const key = this.formatKey()
      if (key && !list.some((f) => `${f.width}x${f.height}@${f.fps}` === key)) {
        this.formatKey.set('')
      }
    } catch {
      this.formats.set([])
    }
  }

  private chosenFormat(): VcamFormat | null {
    const key = this.formatKey()
    if (!key) return null
    return this.formats().find((f) => `${f.width}x${f.height}@${f.fps}` === key) ?? null
  }

  async pickDevice(index: number): Promise<void> {
    this.selected.set(index)
    const name = this.devices().find((d) => d.index === index)?.name ?? ''
    await this.store.saveSettings({ vcamDevice: name })
    await this.loadFormats()
  }

  async pickFormat(key: string): Promise<void> {
    this.formatKey.set(key)
    await this.store.saveSettings({ vcamFormat: key })
  }

  async register(unregister: boolean): Promise<void> {
    this.busy.set(true)
    try {
      await this.tauri.invoke<boolean>('vcam_register', { unregister })
      await this.readStatus()
    } catch (e) {
      this.status.update((s) => ({ ...s, error: String(e) }))
    } finally {
      this.busy.set(false)
    }
  }

  /**
   * Séquence complète, sinon Windows refuse (0xC00D3704) : une webcam ne
   * s'ouvre qu'une fois.
   *   1. libérer la webcam physique tenue par la détection
   *   2. la caméra virtuelle la prend et republie
   *   3. la détection repart sur « meme4me Camera »
   */
  async start(): Promise<void> {
    this.busy.set(true)
    const wasDetecting = this.detection.running()
    try {
      if (wasDetecting) this.detection.stop()
      const s = await this.tauri.invoke<VcamStatus>('vcam_start', {
        cameraIndex: this.selected(),
        format: this.chosenFormat(),
      })
      this.status.set(s)
      if (s.running) await this.switchDetectionToVirtual(wasDetecting)
    } catch (e) {
      this.status.update((st) => ({ ...st, error: String(e) }))
      if (wasDetecting) await this.detection.start().catch(() => {})
    } finally {
      this.busy.set(false)
    }
  }

  /** Bascule la détection sur la caméra virtuelle (elle seule reste lisible). */
  private async switchDetectionToVirtual(restart: boolean): Promise<void> {
    await this.detection.listCameras()
    const virt = this.detection.cameras().find((c) => /meme4me/i.test(c.label))
    if (virt) {
      await this.detection.selectCamera(virt.deviceId)
      this.switched.set(true)
    } else {
      this.switched.set(false)
    }
    if (restart && !this.detection.running()) await this.detection.start().catch(() => {})
  }

  async stop(): Promise<void> {
    this.busy.set(true)
    this.switched.set(false)
    try {
      // libérer la caméra virtuelle AVANT que la détection ne la relâche,
      // sinon la webcam physique reste prise par le pompage
      if (this.detection.running()) this.detection.stop()
      this.status.set(await this.tauri.invoke<VcamStatus>('vcam_stop', {}, EMPTY_VCAM))
    } catch (e) {
      this.status.update((s) => ({ ...s, error: String(e) }))
    } finally {
      this.busy.set(false)
    }
  }

  /** Appelé une fois au lancement, après lecture des réglages. */
  async autoStartIfWanted(): Promise<void> {
    if (this.autoStarted) return
    this.autoStarted = true
    if (!this.store.settings().vcamAutoStart) return
    await this.refresh()
    const s = this.status()
    if (!s.registered || s.running || this.selected() < 0) return
    await this.start()
  }
}
