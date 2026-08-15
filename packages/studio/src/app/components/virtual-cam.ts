import { Component, OnDestroy, inject, signal } from '@angular/core'
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
        <p class="badge err" style="display:block">{{ status().error }}</p>
      }

      <!-- Le filtre est normalement posé par l'installeur ; ce bouton n'est
           qu'un secours (build de dev, ou installation qui a échoué). -->
      <p>
        <span class="badge" [class.ok]="status().registered" [class.warn]="!status().registered">
          {{ status().registered ? 'prêt' : 'pilote non installé' }}
        </span>
        @if (!status().registered) {
          <button class="primary" [disabled]="busy()" (click)="register(false)">
            Installer le pilote (admin)
          </button>
          <span class="lbl">
            Normalement posé à l'installation de meme4me — ce bouton est un secours.
          </span>
        } @else {
          <button [disabled]="busy()" (click)="register(true)">Retirer le pilote</button>
        }
      </p>

      <!-- 2. source + démarrage -->
      <p style="display:flex; gap:8px; align-items:center">
        <select
          style="flex:1"
          [value]="selected()"
          (change)="selected.set(+$any($event.target).value)"
          [disabled]="status().running"
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
      </p>

      @if (status().running) {
        <p>
          <span class="badge ok">
            diffusion {{ status().width }}×{{ status().height }} · {{ status().fps.toFixed(0) }} fps
          </span>
          <span class="badge" [class.ok]="status().connected">
            {{ status().connected ? 'Streamlabs connecté' : 'aucun consommateur' }}
          </span>
        </p>
        <p class="lbl">
          Dans Streamlabs : source « Périphérique de capture vidéo » → meme4me Camera.
          Laisse meme4me ouvert pendant le stream.
        </p>
      }
    </div>
  `,
})
export class VirtualCamCard implements OnDestroy {
  private tauri = inject(TauriService)

  status = signal<VcamStatus>(EMPTY)
  devices = signal<VcamDevice[]>([])
  selected = signal(-1)
  busy = signal(false)
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

  async start(): Promise<void> {
    this.busy.set(true)
    try {
      this.status.set(
        await this.tauri.invoke<VcamStatus>('vcam_start', { cameraIndex: this.selected() }),
      )
    } catch (e) {
      this.status.update((s) => ({ ...s, error: String(e) }))
    } finally {
      this.busy.set(false)
    }
  }

  async stop(): Promise<void> {
    this.busy.set(true)
    try {
      this.status.set(await this.tauri.invoke<VcamStatus>('vcam_stop', {}, EMPTY))
    } catch (e) {
      this.status.update((s) => ({ ...s, error: String(e) }))
    } finally {
      this.busy.set(false)
    }
  }
}
