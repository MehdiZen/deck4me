import { Component, OnDestroy, inject, signal } from '@angular/core'
import { DetectionService } from '../services/detection.service'
import { StoreService } from '../services/store.service'
import { TauriService } from '../services/tauri.service'

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

const EMPTY: VcamStatus = {
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
 * Carte « Caméra virtuelle ». meme4me ouvre la webcam physique et republie
 * « meme4me Camera » : Streamlabs et la détection se partagent enfin la même
 * source, sans conflit DirectShow exclusif.
 */
@Component({
  selector: 'app-virtual-cam',
  template: `
    <div class="card">
      <h2>Caméra virtuelle — pour Streamlabs</h2>
      <p class="lbl">
        Streamlabs prend la webcam en accès exclusif. Ici, meme4me l'ouvre seul et
        republie le flux sous le nom « meme4me Camera » : dans Streamlabs, choisis
        cette caméra au lieu de ta webcam.
      </p>

      @if (status().error) {
        <p class="badge err fault">{{ status().error }}</p>
      }

      <!-- Le filtre est normalement posé par l'installeur ; ce bouton n'est
           qu'un secours (build de dev, ou installation qui a échoué). -->
      <div class="row">
        <span class="badge" [class.ok]="status().registered" [class.warn]="!status().registered">
          <i class="led" [class.on]="status().registered"></i>
          {{ status().registered ? 'pilote prêt' : 'pilote absent' }}
        </span>
        @if (!status().registered) {
          <button class="primary" [disabled]="busy()" (click)="register(false)">
            Installer le pilote
          </button>
          <p class="lbl hint">
            Normalement posé pendant l'installation de meme4me — ce bouton n'est
            qu'un secours, et demande les droits administrateur.
          </p>
        } @else {
          <button [disabled]="busy()" (click)="register(true)">Retirer le pilote</button>
        }
      </div>

      <!-- 2. source + démarrage -->
      <div class="row">
        <select
          class="grow"
          [value]="selected()"
          (change)="pickDevice(+$any($event.target).value)"
          [disabled]="status().running"
          aria-label="Webcam à republier"
        >
          @if (!devices().length) {
            <option value="-1">— aucune caméra détectée —</option>
          }
          @for (d of devices(); track d.index) {
            <option [value]="d.index">{{ d.name }}</option>
          }
        </select>
        <button [disabled]="busy()" (click)="refresh()">Actualiser</button>
      </div>

      <div class="row">
        <select
          class="grow"
          [value]="formatKey()"
          (change)="pickFormat($any($event.target).value)"
          [disabled]="status().running || !formats().length"
          aria-label="Définition diffusée"
        >
          <option value="">Automatique</option>
          @for (f of formats(); track f.width + 'x' + f.height) {
            <option [value]="f.width + 'x' + f.height + '@' + f.fps">
              {{ f.width }}×{{ f.height }} · {{ f.fps }} fps
            </option>
          }
        </select>
        @if (status().running) {
          <button class="danger" [disabled]="busy()" (click)="stop()">Arrêter</button>
        } @else {
          <button
            class="primary"
            [disabled]="busy() || !status().registered || selected() < 0"
            (click)="start()"
          >
            Démarrer
          </button>
        }
        <p class="lbl hint">
          C'est la définition que verra Streamlabs. La détection, elle, réduit
          toujours l'image de son côté : monter en définition améliore ta facecam,
          pas la reconnaissance des poses — et coûte du CPU.
        </p>
      </div>

      <label class="opt">
        <span class="switch">
          <input
            type="checkbox"
            [checked]="store.settings().vcamAutoStart"
            (change)="setAutoStart($event)"
          />
        </span>
        <span>
          Reprendre au lancement
          <span class="lbl">
            meme4me rouvre cette caméra et redémarre la diffusion tout seul au
            démarrage — plus rien à recliquer avant un stream.
          </span>
        </span>
      </label>

      @if (status().running) {
        <div class="stats">
          <span class="badge ok">
            <i class="led live"></i>en diffusion
            <b class="num">{{ status().width }}×{{ status().height }}</b>
            · <b class="num">{{ status().fps.toFixed(0) }}</b> fps
          </span>
          <span class="badge" [class.ok]="status().connected">
            <i class="led" [class.on]="status().connected"></i>
            {{ status().connected ? 'Streamlabs reçoit le flux' : 'personne ne regarde encore' }}
          </span>
        </div>
        <p class="lbl">
          @if (switched()) {
            La détection est passée sur meme4me Camera automatiquement.
          }
          Dans Streamlabs : ajoute une source « Périphérique de capture vidéo » et
          choisis <b>meme4me Camera</b>. Laisse meme4me ouvert pendant le stream.
        </p>
      }
    </div>
  `,
  styles: `
    .fault {
      display: block; white-space: normal; line-height: 1.5;
      padding: 10px 13px; margin-bottom: 12px;
    }
    .stats { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
    .row { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; margin-bottom: 12px; }
    .row:last-child { margin-bottom: 0; }
    .grow { flex: 1; min-width: 160px; }
    .hint { flex-basis: 100%; margin: 0; text-transform: none; letter-spacing: 0; }
    .opt { display: flex; align-items: flex-start; gap: 11px; cursor: pointer; font-size: 13.5px; margin-bottom: 12px; }
    .opt .lbl { display: block; margin-top: 2px; text-transform: none; letter-spacing: 0; font-size: 11.5px; }
  `,
})
export class VirtualCamCard implements OnDestroy {
  /** Une seule reprise automatique par lancement de l'application. */
  private static autoStarted = false

  private tauri = inject(TauriService)
  private detection = inject(DetectionService)
  protected store = inject(StoreService)

  status = signal<VcamStatus>(EMPTY)
  devices = signal<VcamDevice[]>([])
  formats = signal<VcamFormat[]>([])
  /** "" = automatique, sinon "LxH@fps". */
  formatKey = signal('')
  selected = signal(-1)
  busy = signal(false)
  /** La détection a bien été rebasculée sur la caméra virtuelle. */
  switched = signal(false)
  private poll = 0

  constructor() {
    // Énumération au chargement, sinon la liste reste vide jusqu'à ce que
    // l'utilisateur clique « Actualiser » sans savoir qu'il doit le faire.
    void this.refresh().then(() => this.maybeAutoStart())
    // Le statut bouge sans nous (Streamlabs se connecte, caméra perdue).
    // Sondage léger : simple lecture mémoire + registre côté Rust, aucun
    // processus lancé — sinon des fenêtres de console clignotent sans fin.
    this.poll = window.setInterval(() => void this.readStatus(), 3000)
  }

  /** Reprise au lancement. Ne se déclenche qu'une fois par session : sans ce
   *  verrou, revenir sur l'écran Réglages relancerait la caméra que
   *  l'utilisateur vient d'arrêter à la main. */
  private async maybeAutoStart(): Promise<void> {
    if (VirtualCamCard.autoStarted) return
    VirtualCamCard.autoStarted = true
    const s = this.store.settings()
    if (!s.vcamAutoStart || this.status().running || !this.status().registered) return
    if (this.selected() < 0) return
    await this.start()
  }

  /** Le choix est retenu par NOM : l'index d'une caméra change dès qu'un autre
   *  périphérique est branché, et on rouvrirait la mauvaise sans rien dire. */
  private async remember(patch: Partial<{ vcamDevice: string; vcamFormat: string }>): Promise<void> {
    await this.store.saveSettings(patch)
  }

  async pickDevice(index: number): Promise<void> {
    this.selected.set(index)
    const name = this.devices().find((d) => d.index === index)?.name ?? ''
    await this.remember({ vcamDevice: name })
    await this.loadFormats()
  }

  async pickFormat(key: string): Promise<void> {
    this.formatKey.set(key)
    await this.remember({ vcamFormat: key })
  }

  async setAutoStart(ev: Event): Promise<void> {
    await this.store.saveSettings({ vcamAutoStart: (ev.target as HTMLInputElement).checked })
  }

  ngOnDestroy(): void {
    clearInterval(this.poll)
  }

  private async readStatus(): Promise<void> {
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
        // Retrouver la caméra retenue par son nom ; à défaut, la première.
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
  private async loadFormats(): Promise<void> {
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
      this.status.set(await this.tauri.invoke<VcamStatus>('vcam_stop', {}, EMPTY))
    } catch (e) {
      this.status.update((s) => ({ ...s, error: String(e) }))
    } finally {
      this.busy.set(false)
    }
  }
}
