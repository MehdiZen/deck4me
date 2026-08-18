import { Component, computed, inject, signal } from '@angular/core'
import { ConfirmService } from '../services/confirm.service'
import { StoreService, isAudio, type AssetMeta } from '../services/store.service'
import { Icon } from './icon'

/**
 * Liste les images et les sons importés, et permet d'en retirer.
 *
 * Ce qui sert n'est pas supprimable, et le bouton dit qui s'en sert plutôt que
 * de se contenter d'être gris.
 */
@Component({
  selector: 'app-asset-library',
  imports: [Icon],
  template: `
    <div class="card">
      <h2>Bibliothèque</h2>
      <p class="lbl">
        Toutes les images et tous les sons importés, quel que soit le profil.
        Une image détourée compte comme une image de plus : l'originale est
        conservée intacte à côté d'elle.
      </p>

      @if (!mine().length) {
        <p class="lbl none">Rien d'importé pour l'instant.</p>
      } @else {
        <div class="sum">
          <span class="badge"><b class="num">{{ mine().length }}</b> fichiers</span>
          <span class="badge"><b class="num">{{ mb() }}</b> Mo</span>
          @if (freeCount(); as n) {
            <span class="badge warn"><b class="num">{{ n }}</b> inutilisés</span>
          }
          <span class="spacer"></span>
          <label class="only">
            <input type="checkbox" [checked]="onlyFree()" (change)="onlyFree.set($any($event.target).checked)" />
            N'afficher que les inutilisés
          </label>
        </div>

        @if (error()) {
          <p class="badge err block">{{ error() }}</p>
        }

        <div class="grid">
          @for (a of shown(); track a.id) {
            <div class="item" [class.free]="!users(a).length">
              <div class="thumb alpha-grid">
                @if (isAudio(a)) {
                  <app-icon name="volume" [size]="22" />
                } @else {
                  <img [src]="store.assetUrl(a)" alt="" loading="lazy" />
                }
              </div>
              <div class="who">
                <span class="fn" [title]="a.filename">{{ a.filename }}</span>
                <span class="lbl dim">
                  {{ (a.sizeBytes / 1024).toFixed(0) }} ko
                  @if (a.width) {
                    · {{ a.width }}×{{ a.height }}
                  }
                </span>
                @if (users(a); as u) {
                  @if (u.length) {
                    <span class="lbl uses" [title]="u.join(', ')">sert à {{ u.join(', ') }}</span>
                  } @else {
                    <span class="lbl dim">personne ne s'en sert</span>
                  }
                }
              </div>
              <button
                class="ghost sm"
                [disabled]="!!users(a).length"
                [title]="
                  users(a).length
                    ? 'Impossible tant que ' + users(a).join(', ') + ' s\\'en sert. Retire le meme là-bas d\\'abord.'
                    : 'Retirer ce fichier de la bibliothèque'
                "
                (click)="remove(a)"
                [attr.aria-label]="'Supprimer ' + a.filename"
              >
                <app-icon name="trash" [size]="15" />
              </button>
            </div>
          }
        </div>
        @if (onlyFree() && !shown().length) {
          <p class="lbl none">Tout est utilisé.</p>
        }
      }
    </div>
  `,
  styles: `
    .none { margin: 4px 0 0; text-transform: none; letter-spacing: 0; }
    .sum { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: 12px 0 10px; }
    .only {
      display: flex; align-items: center; gap: 7px;
      font-size: 12px; color: var(--ink-2); cursor: pointer;
    }

    /* Une grille qui se remplit d'elle-meme : la bibliotheque va de trois
       fichiers a soixante, et une largeur de colonne fixe se trompe aux deux
       bouts. */
    .grid {
      display: grid; gap: 8px;
      grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr));
    }
    .item {
      display: flex; align-items: center; gap: 10px;
      padding: 8px; border-radius: var(--r-control);
      border: 1px solid var(--line-soft); background: var(--void);
    }
    /* Ce que personne n'utilise se voit : c'est ce qu'on vient chercher ici. */
    .item.free { border-color: #d9901240; }
    .thumb {
      flex: none; width: 46px; height: 46px; border-radius: 7px;
      display: grid; place-items: center; overflow: hidden;
      color: var(--ink-3);
    }
    .thumb img { width: 100%; height: 100%; object-fit: contain; }
    .who { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    .fn {
      font-size: 12.5px; font-weight: 540;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .who .lbl {
      text-transform: none; letter-spacing: 0; font-size: 11px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .dim { color: var(--ink-3); }
    .uses { color: var(--st-armed); }
  `,
})
export class AssetLibrary {
  protected store = inject(StoreService)
  private confirm = inject(ConfirmService)
  protected readonly isAudio = isAudio

  protected onlyFree = signal(false)
  protected error = signal('')

  /** Les noms de ce qui se sert d'un fichier, prêts à être lus dans une phrase. */
  protected users(a: AssetMeta): string[] {
    return this.store.assetUsers(a.id).map((id) => this.store.ownerName(id))
  }

  /** Tout sauf l'image de test embarquée : elle n'a pas été importée et le
   *  Rust refuse de l'effacer. L'afficher comme « inutilisée » offrirait un
   *  bouton qui ne peut que échouer. */
  protected readonly mine = computed(() =>
    this.store.assets().filter((a) => a.id !== this.store.builtinAssetId()),
  )

  protected readonly freeCount = computed(
    () => this.mine().filter((a) => !this.store.assetUsers(a.id).length).length,
  )

  protected readonly mb = computed(() =>
    (this.mine().reduce((n, a) => n + a.sizeBytes, 0) / 1_048_576).toFixed(1),
  )

  protected readonly shown = computed(() =>
    this.onlyFree() ? this.mine().filter((a) => !this.store.assetUsers(a.id).length) : this.mine(),
  )

  protected async remove(a: AssetMeta): Promise<void> {
    this.error.set('')
    const ok = await this.confirm.ask({
      title: `Supprimer « ${a.filename} » ?`,
      body: 'Le fichier est effacé du disque. Rien ne s’en sert, mais il faudra le réimporter pour le retrouver.',
      danger: true,
    })
    if (!ok) return
    try {
      await this.store.deleteAsset(a.id)
    } catch (e) {
      this.error.set(String(e))
    }
  }
}
