import { ChangeDetectionStrategy, Component, inject } from '@angular/core'
import { ConfirmService } from '../services/confirm.service'
import { Icon } from './icon'

/**
 * La boîte de confirmation de l'app. Montée une seule fois, dans la coquille.
 *
 * Deux choix qui ne sont pas cosmétiques :
 *  · le bouton d'annulation est à GAUCHE et reçoit le focus au montage. Sur une
 *    action destructrice, la touche Entrée doit renoncer, pas détruire ;
 *  · Échap et le fond annulent tous les deux. Une modale destructrice qu'on ne
 *    sait pas quitter pousse à cliquer n'importe où pour s'en débarrasser.
 */
@Component({
  selector: 'app-confirm',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    @if (confirm.pending(); as r) {
      <div
        class="bg"
        (click)="onBackdrop($event)"
        (window:keydown.escape)="confirm.answer(false)"
      >
        <div class="card box" role="alertdialog" aria-modal="true">
          <span class="mark" [class.danger]="r.danger">
            <app-icon [name]="r.danger ? 'trash' : 'target'" [size]="19" />
          </span>
          <b class="ttl">{{ r.title }}</b>
          @if (r.body) {
            <p class="lbl">{{ r.body }}</p>
          }
          <div class="acts">
            <button #first class="sm" (click)="confirm.answer(false)">Annuler</button>
            <button
              class="sm"
              [class.danger]="r.danger"
              [class.primary]="!r.danger"
              (click)="confirm.answer(true)"
            >
              {{ r.ok ?? 'Supprimer' }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
  styles: `
    .bg {
      position: fixed; inset: 0; z-index: 80;
      background: #07060acc; backdrop-filter: blur(5px);
      display: grid; place-items: center; padding: 24px;
      animation: fade 140ms ease-out;
    }
    .box {
      width: 380px; max-width: 100%; padding: 20px;
      text-align: center;
      border-radius: var(--r-big);
      box-shadow: var(--edge), 0 40px 90px -20px #000d;
      animation: pop 200ms var(--spring) both;
    }
    @keyframes pop { from { opacity: 0; transform: translateY(8px) scale(.985) } }

    .mark {
      display: grid; place-items: center; width: 42px; height: 42px;
      margin: 0 auto 12px; border-radius: 12px;
      background: var(--panel-3); color: var(--ink-2);
    }
    .mark.danger { background: #ef444422; color: #f87171; }

    .ttl { display: block; font-size: 15px; letter-spacing: -0.01em; }
    .lbl { margin: 7px 0 0; text-transform: none; letter-spacing: 0; line-height: 1.5; }

    .acts { display: flex; gap: 9px; margin-top: 18px; }
    .acts button { flex: 1; justify-content: center; }
    .danger { background: #ef4444; border-color: #ef4444; color: #fff; }
    .danger:hover { background: #dc2626; border-color: #dc2626; }
  `,
})
export class Confirm {
  protected confirm = inject(ConfirmService)

  /** Le fond ferme, la boîte non. */
  onBackdrop(ev: MouseEvent): void {
    if (ev.target === ev.currentTarget) this.confirm.answer(false)
  }
}
