import { Component, inject, signal } from '@angular/core'
import { Calibration } from '../components/calibration'
import { Hotkeys } from '../components/hotkeys'
import { Icon } from '../components/icon'
import { Profiles } from '../components/profiles'
import { Updater } from '../components/updater'
import { VirtualCamCard } from '../components/virtual-cam'
import { DetectionService } from '../services/detection.service'
import { StoreService } from '../services/store.service'

@Component({
  selector: 'app-settings-page',
  imports: [Calibration, VirtualCamCard, Profiles, Hotkeys, Updater, Icon],
  template: `
    <div class="head">
      <div>
        <h1>Réglages</h1>
        <p class="lbl sub">Caméra, overlay, profils et raccourcis.</p>
      </div>
    </div>

    <div class="stack">
      <div class="card">
        <h2>Caméra de détection</h2>
        <div class="row">
          <select
            class="grow"
            [value]="detection.selectedCameraId()"
            (change)="select($event)"
            aria-label="Caméra utilisée pour la détection"
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
          <button (click)="detection.listCameras()">
            <app-icon name="camera" [size]="15" /> Détecter
          </button>
        </div>
        <p class="lbl">
          Choisis la caméra qui te filme. En changer redémarre la détection si elle
          tourne. Si la caméra virtuelle ci-dessous est active, prends
          « meme4me Camera » ici aussi : la webcam n'est alors ouverte qu'une fois.
        </p>
      </div>

      <app-virtual-cam />

      <div class="card">
        <h2>Overlay OBS</h2>
        <p class="lbl">
          Dans OBS : Sources → + → Navigateur, colle cette URL, taille 1920×1080.
          Coche « Contrôler l'audio via OBS » si tes memes ont du son.
        </p>
        <div class="row">
          <input
            class="grow url"
            readonly
            [value]="store.overlayUrl()"
            (focus)="$any($event.target).select()"
            aria-label="URL de l'overlay"
          />
          <button class="primary" (click)="copy()">
            <app-icon [name]="copied() ? 'check' : 'copy'" [size]="15" />
            {{ copied() ? 'Copié' : 'Copier' }}
          </button>
        </div>
        <p class="lbl warnline">
          Cette adresse contient un jeton privé : ne la laisse pas apparaître à
          l'écran pendant un stream. Port <span class="num">{{ store.port() }}</span>,
          accessible depuis cette machine uniquement.
        </p>
      </div>

      <app-profiles />
      <app-hotkeys />
      <app-calibration />
      <app-updater />
    </div>
  `,
  styles: `
    .head { margin-bottom: 20px; }
    .head h1 { margin: 0 0 4px; }
    .sub { margin: 0; text-transform: none; letter-spacing: 0; }
    .stack { display: flex; flex-direction: column; gap: 14px; max-width: 820px; }
    .row { display: flex; gap: 9px; align-items: center; margin-bottom: 12px; }
    .grow { flex: 1; min-width: 0; }
    .url { font-family: var(--font-data); font-size: 12px; }
    .warnline { border-left: 2px solid var(--st-candidate); padding-left: 11px; }
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
