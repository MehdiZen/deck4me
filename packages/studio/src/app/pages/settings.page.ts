import { Component, inject, signal } from '@angular/core'
import { AssetLibrary } from '../components/asset-library'
import { Calibration } from '../components/calibration'
import { Hotkeys } from '../components/hotkeys'
import { Icon } from '../components/icon'
import { Profiles } from '../components/profiles'
import { Updater } from '../components/updater'
import { VirtualCamCard } from '../components/virtual-cam'
import { DetectionService } from '../services/detection.service'
import { OverlayService } from '../services/overlay.service'
import { StoreService } from '../services/store.service'

@Component({
  selector: 'app-settings-page',
  imports: [Calibration, VirtualCamCard, AssetLibrary, Profiles, Hotkeys, Updater, Icon],
  template: `
    <div class="head">
      <div>
        <h1>Réglages</h1>
        <p class="lbl sub">Caméra, calibration, overlay OBS, profils et raccourcis.</p>
      </div>
    </div>

    <div class="stack">
      <div class="card">
        <h2>Caméra de détection</h2>
        <div class="row">
          <!-- Verrouillé pendant le flux direct : voir le texte ci-dessous.
               Laisser le choix ouvert menait droit dans un mur — on coupait le
               flux rapide, et la webcam refusait de s'ouvrir puisque la pompe
               la tient. Plus d'image, et aucun moyen de revenir. -->
          <select
            class="grow"
            [value]="detection.selectedCameraId()"
            (change)="select($event)"
            [disabled]="detection.feedActive()"
            aria-label="Caméra utilisée pour la détection"
          >
            @if (!detection.cameras().length) {
              <option value="">— clique Détecter —</option>
            }
            <!-- [selected] : la valeur du select est posée avant que @for ait
                 créé les options, sans quoi l'écran annonce la première caméra
                 alors que la détection en utilise une autre. -->
            @for (cam of detection.cameras(); track cam.deviceId) {
              <option
                [value]="cam.deviceId"
                [selected]="cam.deviceId === detection.selectedCameraId()"
              >
                {{ cam.label || 'Caméra ' + ($index + 1) }}
              </option>
            }
          </select>
          <button (click)="detection.listCameras()">
            <app-icon name="camera" [size]="15" /> Détecter
          </button>
        </div>
        @if (detection.feedActive()) {
          <p class="lbl">
            <b>La caméra virtuelle tourne : la détection reçoit ses images
            directement.</b>
            Elles arrivent de deck4me lui-même, sans repasser par Windows — c'est
            deux à trois fois plus rapide, et la webcam n'est ouverte qu'une seule
            fois. Ce choix reprendra effet quand tu arrêteras la caméra virtuelle.
            Pour changer de webcam maintenant, c'est le menu de la carte
            ci-dessous.
          </p>
        } @else {
          <p class="lbl">
            Choisis la caméra qui te filme. En changer redémarre la détection si
            elle tourne. Quand la caméra virtuelle ci-dessous est active, ce
            réglage se met en pause : la détection est alimentée directement,
            sans passer par une webcam.
          </p>
        }
        <label class="opt">
          <span class="switch">
            <input
              type="checkbox"
              [checked]="store.settings().detectionAutoStart"
              (change)="setAutoStart($event)"
            />
          </span>
          <span>
            Démarrer la détection au lancement
            <span class="lbl">
              La caméra s'ouvre dès l'ouverture de deck4me. À laisser décoché si tu
              veux garder la main sur le moment où la webcam s'allume.
            </span>
          </span>
        </label>
      </div>

      <app-calibration />

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
        <!-- Le seul endroit qui réponde à « est-ce que c'est branché ? ». -->
        <div class="row wire">
          @if (overlay.connected()) {
            <span class="badge ok">
              <i class="led on"></i>
              OBS reçoit l'overlay
              @if ((overlay.clients() ?? 0) > 1) {
                · <b class="num">{{ overlay.clients() }}</b> sources
              }
            </span>
            <span class="lbl">Tes memes s'afficheront.</span>
          } @else if (overlay.missing()) {
            <span class="badge warn"><i class="led"></i> aucune source connectée</span>
            <span class="lbl">
              Tant que cette URL n'est pas dans OBS, <b>rien ne s'affichera</b>,
              même si la pose est reconnue.
            </span>
          } @else {
            <span class="badge"><i class="led"></i> vérification…</span>
          }
        </div>

        <p class="lbl warnline">
          Cette adresse contient un jeton privé : ne la laisse pas apparaître à
          l'écran pendant un stream. Port <span class="num">{{ store.port() }}</span>,
          accessible depuis cette machine uniquement.
        </p>
      </div>

      <app-virtual-cam />

      <app-asset-library />

      <app-profiles />
      <app-hotkeys />
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
    .wire { flex-wrap: wrap; }
    .wire .lbl { text-transform: none; letter-spacing: 0; font-size: 12px; flex: 1; min-width: 200px; }
    .opt { display: flex; align-items: flex-start; gap: 11px; cursor: pointer; font-size: 13.5px; margin-top: 14px; }
    .opt .lbl { display: block; margin-top: 2px; text-transform: none; letter-spacing: 0; font-size: 11.5px; }
  `,
})
export class SettingsPage {
  protected store = inject(StoreService)
  protected detection = inject(DetectionService)
  protected overlay = inject(OverlayService)
  copied = signal(false)

  constructor() {
    void this.detection.listCameras()
  }

  async select(ev: Event): Promise<void> {
    await this.detection.selectCamera((ev.target as HTMLSelectElement).value)
  }

  async setAutoStart(ev: Event): Promise<void> {
    await this.store.saveSettings({
      detectionAutoStart: (ev.target as HTMLInputElement).checked,
    })
  }

  async copy(): Promise<void> {
    await navigator.clipboard.writeText(this.store.overlayUrl())
    this.copied.set(true)
    setTimeout(() => this.copied.set(false), 1500)
  }
}
