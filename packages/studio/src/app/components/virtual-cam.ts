import { Component, OnDestroy, inject } from '@angular/core'
import { StoreService } from '../services/store.service'
import { VcamService } from '../services/vcam.service'

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

      @if (vcam.status().error) {
        <p class="badge err fault">{{ vcam.status().error }}</p>
      }

      <!-- Le filtre est normalement posé par l'installeur ; ce bouton n'est
           qu'un secours (build de dev, ou installation qui a échoué). -->
      <div class="row">
        <span class="badge" [class.ok]="vcam.status().registered" [class.warn]="!vcam.status().registered">
          <i class="led" [class.on]="vcam.status().registered"></i>
          {{ vcam.status().registered ? 'pilote prêt' : 'pilote absent' }}
        </span>
        @if (!vcam.status().registered) {
          <button class="primary" [disabled]="vcam.busy()" (click)="vcam.register(false)">
            Installer le pilote
          </button>
          <p class="lbl hint">
            Normalement posé pendant l'installation de meme4me — ce bouton n'est
            qu'un secours, et demande les droits administrateur.
          </p>
        } @else {
          <button [disabled]="vcam.busy()" (click)="vcam.register(true)">Retirer le pilote</button>
        }
      </div>

      <!-- 2. source + démarrage -->
      <div class="row">
        <select
          class="grow"
          [value]="vcam.selected()"
          (change)="vcam.pickDevice(+$any($event.target).value)"
          [disabled]="vcam.status().running"
          aria-label="Webcam à republier"
        >
          @if (!vcam.devices().length) {
            <option value="-1">— aucune caméra détectée —</option>
          }
          @for (d of vcam.devices(); track d.index) {
            <option [value]="d.index">{{ d.name }}</option>
          }
        </select>
        <button [disabled]="vcam.busy()" (click)="vcam.refresh()">Actualiser</button>
      </div>

      <div class="row">
        <select
          class="grow"
          [value]="vcam.formatKey()"
          (change)="vcam.pickFormat($any($event.target).value)"
          [disabled]="vcam.status().running || !vcam.formats().length"
          aria-label="Définition diffusée"
        >
          <option value="">Automatique</option>
          @for (f of vcam.formats(); track f.width + 'x' + f.height) {
            <option [value]="f.width + 'x' + f.height + '@' + f.fps">
              {{ f.width }}×{{ f.height }} · {{ f.fps }} fps
            </option>
          }
        </select>
        @if (vcam.status().running) {
          <button class="danger" [disabled]="vcam.busy()" (click)="vcam.stop()">Arrêter</button>
        } @else {
          <button
            class="primary"
            [disabled]="vcam.busy() || !vcam.status().registered || vcam.selected() < 0"
            (click)="vcam.start()"
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

      @if (vcam.status().running) {
        <div class="stats">
          <span class="badge ok">
            <i class="led live"></i>en diffusion
            <b class="num">{{ vcam.status().width }}×{{ vcam.status().height }}</b>
            · <b class="num">{{ vcam.status().fps.toFixed(0) }}</b> fps
          </span>
          <span class="badge" [class.ok]="vcam.status().connected">
            <i class="led" [class.on]="vcam.status().connected"></i>
            {{ vcam.status().connected ? 'Streamlabs reçoit le flux' : 'personne ne regarde encore' }}
          </span>
        </div>
        <p class="lbl">
          @if (vcam.switched()) {
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
  protected vcam = inject(VcamService)
  protected store = inject(StoreService)
  private poll = 0

  constructor() {
    // Énumération à l'ouverture de l'écran, sinon la liste reste vide jusqu'à
    // ce que l'utilisateur clique « Actualiser » sans savoir qu'il doit le faire.
    void this.vcam.refresh()
    // Le statut bouge sans nous (Streamlabs se connecte, caméra perdue).
    // Sondage léger : simple lecture mémoire + registre côté Rust, aucun
    // processus lancé — sinon des fenêtres de console clignotent sans fin.
    this.poll = window.setInterval(() => void this.vcam.readStatus(), 3000)
  }

  ngOnDestroy(): void {
    clearInterval(this.poll)
  }

  async setAutoStart(ev: Event): Promise<void> {
    await this.store.saveSettings({ vcamAutoStart: (ev.target as HTMLInputElement).checked })
  }
}
