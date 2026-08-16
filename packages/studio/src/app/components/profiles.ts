import { Component, inject, signal } from '@angular/core'
import { ConfirmService } from '../services/confirm.service'
import { StoreService } from '../services/store.service'
import { Icon } from './icon'

/**
 * Profils (phase 6). Un profil = un jeu de gestures armées.
 * L'usage réel : « Just Chatting » et « en jeu » ne veulent pas les mêmes
 * poses — celles qui marchent assis face caméra déclenchent au hasard manette
 * en main. Le basculement doit donc être instantané et sans effet de bord :
 * seules les gestures du profil actif sont chargées dans le Matcher.
 */
@Component({
  selector: 'app-profiles',
  imports: [Icon],
  template: `
    <div class="card">
      <h2>Profils</h2>
      <p class="lbl">
        Chaque profil a ses propres gestures. Le profil actif est le seul armé —
        change-en depuis le rail à gauche, ou avec le raccourci « profil suivant ».
      </p>

      <div class="list">
        @for (p of store.profiles(); track p.id) {
          <div class="prow" [class.on]="p.isActive">
            <button
              class="pick"
              [disabled]="p.isActive"
              (click)="store.setActiveProfile(p.id)"
              [attr.aria-label]="'Activer ' + p.name"
            >
              <i class="led" [class.on]="p.isActive"></i>
            </button>
            @if (renaming() === p.id) {
              <input
                #ren
                class="grow"
                [value]="p.name"
                (keydown.enter)="commitRename(p.id, $any($event.target).value)"
                (keydown.escape)="renaming.set('')"
                (blur)="commitRename(p.id, $any($event.target).value)"
                autofocus
              />
            } @else {
              <b class="nm" (dblclick)="renaming.set(p.id)">{{ p.name }}</b>
              <span class="lbl count">
                <span class="num">{{ count(p.id) }}</span> gesture(s)
              </span>
              <span class="spacer"></span>
              <button class="ghost sm" (click)="renaming.set(p.id)" aria-label="Renommer">
                <app-icon name="sliders" [size]="15" />
              </button>
              <button
                class="ghost sm"
                [disabled]="store.profiles().length < 2"
                (click)="remove(p.id, p.name)"
                aria-label="Supprimer ce profil"
              >
                <app-icon name="trash" [size]="15" />
              </button>
            }
          </div>
        }
      </div>

      <div class="add">
        <input
          [value]="draft()"
          (input)="draft.set($any($event.target).value)"
          (keydown.enter)="create()"
          placeholder="Nom du nouveau profil"
          class="grow"
          aria-label="Nom du nouveau profil"
        />
        <button class="primary" [disabled]="!draft().trim()" (click)="create()">
          <app-icon name="plus" [size]="15" /> Créer
        </button>
      </div>
    </div>
  `,
  styles: `
    .list { display: flex; flex-direction: column; gap: 5px; margin-bottom: 14px; }
    .prow {
      display: flex; align-items: center; gap: 11px;
      padding: 9px 11px; border-radius: var(--r-control);
      border: 1px solid transparent;
      transition: background 140ms var(--ease), border-color 140ms var(--ease);
    }
    .prow:hover { background: #ffffff07; }
    .prow.on { background: var(--accent-wash); border-color: #8b5cf640; }
    .pick { padding: 6px; background: none; border: 0; box-shadow: none; }
    .pick:disabled { opacity: 1; }
    .nm { font-weight: 550; font-size: 13.5px; }
    .count { text-transform: none; letter-spacing: 0; font-size: 11.5px; }
    .grow { flex: 1; min-width: 0; }
    .add { display: flex; gap: 9px; }
  `,
})
export class Profiles {
  protected store = inject(StoreService)
  private confirm = inject(ConfirmService)
  readonly draft = signal('')
  readonly renaming = signal('')

  count(profileId: string): number {
    return this.store.allGestures().filter((g) => (g.profileId || 'default') === profileId).length
  }

  async create(): Promise<void> {
    const name = this.draft().trim()
    if (!name) return
    await this.store.saveProfile({ id: crypto.randomUUID(), name, isActive: false })
    this.draft.set('')
  }

  async commitRename(id: string, name: string): Promise<void> {
    this.renaming.set('')
    const trimmed = name.trim()
    const current = this.store.profiles().find((p) => p.id === id)
    if (!trimmed || !current || trimmed === current.name) return
    await this.store.saveProfile({ ...current, name: trimmed })
  }

  /** Supprimer un profil emporte ses gestures : la confirmation dit combien. */
  async remove(id: string, name: string): Promise<void> {
    const n = this.count(id)
    const ok = await this.confirm.ask({
      title: `Supprimer « ${name} » ?`,
      body: n ? `Ses ${n} gesture(s) partent avec lui : les enregistrements seront perdus.` : undefined,
      danger: true,
    })
    if (ok) await this.store.deleteProfile(id)
  }
}
