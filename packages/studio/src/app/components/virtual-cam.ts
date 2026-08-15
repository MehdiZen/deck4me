import { Component, OnDestroy, inject, signal } from '@angular/core'
import { DetectionService } from '../services/detection.service'
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
          (change)="selected.set(+$any($event.target).value)"
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
      </div>

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
    .hint { flex-basis: 100%; margin: 0; }
  `,
})
export class VirtualCamCard implements OnDestroy {
  private tauri = inject(TauriService)
  private detection = inject(DetectionService)

  status = signal<VcamStatus>(EMPTY)
  devices = signal<VcamDevice[]>([])
  selected = signal(-1)
  busy = signal(false)
  /** La détection a bien été rebasculée sur la caméra virtuelle. */
  switched = signal(false)
  private poll = 0

  constructor() {
    // Énumération au chargement, sinon la liste reste vide jusqu'à ce que
    // l'utilisateur clique « Actualiser » sans savoir qu'il doit le faire.
    void this.refresh()
    // Le statut bouge sans nous (Streamlabs se connecte, caméra perdue).
    // Sondage léger : simple lecture mémoire + registre côté Rust, aucun
    // processus lancé — sinon des fenêtres de console clignotent sans fin.
    this.poll = window.setInterval(() => void this.readStatus(), 3000)
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
      if (this.selected() < 0 && devs.length) this.selected.set(devs[0].index)
    } catch (e) {
      this.status.update((s) => ({ ...s, error: String(e) }))
    } finally {
      this.busy.set(false)
    }
    await this.readStatus()
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
