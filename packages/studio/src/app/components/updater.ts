import { Component, inject } from '@angular/core'
import { StoreService } from '../services/store.service'
import { UpdateService } from '../services/update.service'
import { Icon } from './icon'

/** Carte « Mise à jour » — vue seule : l'état et les appels vivent dans
 *  [UpdateService], qui a déjà interrogé le canal au démarrage. */
@Component({
  selector: 'app-updater',
  imports: [Icon],
  template: `
    <div class="card">
      <h2>Mise à jour</h2>
      <div class="row">
        <span class="badge">version installée <b class="num">{{ store.version() || '—' }}</b></span>
        @if (upd.found(); as u) {
          <span class="badge ok"><i class="led on"></i>{{ u.version }} disponible</span>
        } @else if (upd.checked() && !upd.error()) {
          <span class="badge">à jour</span>
        }
        <span class="spacer"></span>
        @if (upd.found()) {
          <button class="primary" [disabled]="upd.busy()" (click)="upd.install()">
            <app-icon name="download" [size]="15" />
            {{ upd.busy() ? 'Installation…' : 'Installer et relancer' }}
          </button>
        } @else {
          <button [disabled]="upd.busy()" (click)="upd.check()">
            {{ upd.busy() ? 'Vérification…' : 'Vérifier maintenant' }}
          </button>
        }
      </div>

      @if (upd.found()?.notes) {
        <p class="notes">{{ upd.found()!.notes }}</p>
      }
      @if (upd.error()) {
        <p class="badge err block">{{ upd.error() }}</p>
      }

      <label class="opt">
        <span class="switch">
          <input
            type="checkbox"
            [checked]="store.settings().autoUpdateCheck"
            (change)="toggleAuto($event)"
          />
        </span>
        <span>
          Vérifier au démarrage
          <span class="lbl">
            Une requête au dépôt GitHub, rien de plus. Aucune installation
            automatique : c'est toujours toi qui déclenches.
          </span>
        </span>
      </label>
    </div>
  `,
  styles: `
    .row { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; margin-bottom: 12px; }
    .notes {
      font-size: 12.5px; color: var(--ink-2); line-height: 1.6;
      padding: 10px 13px; background: var(--void);
      border: 1px solid var(--line-soft); border-radius: var(--r-control);
      white-space: pre-wrap; margin-bottom: 12px;
    }
    .block { display: block; white-space: normal; line-height: 1.5; padding: 9px 12px; margin-bottom: 12px; }
    .opt { display: flex; align-items: flex-start; gap: 11px; cursor: pointer; font-size: 13.5px; }
    .opt .lbl { display: block; margin-top: 2px; text-transform: none; letter-spacing: 0; font-size: 11.5px; }
  `,
})
export class Updater {
  protected store = inject(StoreService)
  protected upd = inject(UpdateService)

  async toggleAuto(ev: Event): Promise<void> {
    await this.store.saveSettings({ autoUpdateCheck: (ev.target as HTMLInputElement).checked })
  }
}
