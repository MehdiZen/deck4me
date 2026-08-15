import { Component, inject, signal } from '@angular/core'
import { Calibration } from '../components/calibration'
import { VirtualCamCard } from '../components/virtual-cam'
import { DetectionService } from '../services/detection.service'
import { StoreService } from '../services/store.service'

@Component({
  selector: 'app-settings-page',
  imports: [Calibration, VirtualCamCard],
  template: `
    <h1>Réglages</h1>
    <div style="display:flex; flex-direction:column; gap:16px; max-width:720px">
      <div class="card">
        <h2>Caméra</h2>
        <p style="display:flex; gap:8px; align-items:center">
          <select
            style="flex:1"
            [value]="detection.selectedCameraId()"
            (change)="select($event)"
          >
            @if (!detection.cameras().length) {
              <option value="">— clique Détecter —</option>
            }
            @for (cam of detection.cameras(); track cam.deviceId) {
              <option [value]="cam.deviceId">
                {{ cam.label || 'Caméra ' + ($index + 1) }}
              </option>
            }
          </select>
          <button (click)="detection.listCameras()">Détecter</button>
        </p>
        <p class="lbl">
          Choisis la caméra que tu utilises en stream. Le changement redémarre la
          détection si elle tourne. {{ detection.status() }}
        </p>
        <p class="lbl">
          Si la caméra virtuelle ci-dessous tourne, sélectionne « facememe Camera »
          ici aussi : la webcam physique n'est alors ouverte qu'une seule fois.
        </p>
      </div>
      <app-virtual-cam />
      <div class="card">
        <h2>Overlay OBS</h2>
        <p class="lbl">
          Dans OBS : Sources → + → Navigateur, colle cette URL, taille 1920×1080.
          Coche « Contrôler l'audio via OBS » si tes memes ont du son.
        </p>
        <p style="display:flex; gap:8px">
          <input readonly [value]="store.overlayUrl()" style="flex:1" (focus)="$any($event.target).select()" />
          <button class="primary" (click)="copy()">{{ copied() ? 'Copié ✓' : 'Copier' }}</button>
        </p>
        <p class="lbl">
          L'URL contient un jeton privé : ne la montre pas à l'écran en stream.
          Port {{ store.port() }} (127.0.0.1 uniquement).
        </p>
      </div>
      <app-calibration />
    </div>
  `,
})
export class SettingsPage {
  protected store = inject(StoreService)
  protected detection = inject(DetectionService)
  copied = signal(false)

  constructor() {
    void this.detection.listCameras()
  }

  async select(ev: Event): Promise<void> {
    await this.detection.selectCamera((ev.target as HTMLSelectElement).value)
  }

  async copy(): Promise<void> {
    await navigator.clipboard.writeText(this.store.overlayUrl())
    this.copied.set(true)
    setTimeout(() => this.copied.set(false), 1500)
  }
}
