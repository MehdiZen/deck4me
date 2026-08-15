import { Component, EventEmitter, Input, Output, inject, signal } from '@angular/core'
import { IMAGE_ACCEPT, StoreService, type AssetMeta } from '../services/store.service'
import { Icon } from './icon'

/**
 * Import d'un visuel : depuis un fichier, depuis une URL, ou en reprenant une
 * image déjà importée.
 *
 * L'URL n'est pas un confort : un meme se trouve sur le web, et l'obliger à
 * passer par « clic droit → enregistrer sous → retrouver le dossier » pour
 * ensuite le rechercher dans un sélecteur de fichiers, c'est trois étapes de
 * trop pour un geste qu'on fait vingt fois.
 */
@Component({
  selector: 'app-asset-picker',
  imports: [Icon],
  template: `
    <div class="pick">
      <label class="file">
        <app-icon name="image" [size]="15" /> {{ label }}
        <input type="file" [accept]="ACCEPT" hidden (change)="fromFile($event)" />
      </label>

      <div class="url">
        <input
          [value]="url()"
          (input)="url.set($any($event.target).value); error.set('')"
          (keydown.enter)="fromUrl()"
          placeholder="…ou colle l'adresse d'une image"
          aria-label="Adresse d'une image à importer"
        />
        <button [disabled]="!url().trim() || busy()" (click)="fromUrl()">
          {{ busy() ? '…' : 'Importer' }}
        </button>
      </div>

      @if (reusable().length) {
        <select (change)="fromLibrary($event)" aria-label="Image déjà importée">
          <option value="">— reprendre une image déjà importée —</option>
          @for (a of reusable(); track a.id) {
            <option [value]="a.id">{{ a.filename }}</option>
          }
        </select>
      }

      @if (error()) {
        <p class="badge err block">{{ error() }}</p>
      }
    </div>
  `,
  styles: `
    .pick { display: flex; flex-direction: column; gap: 8px; }
    .file {
      display: flex; align-items: center; justify-content: center; gap: 7px;
      cursor: pointer; font-size: 12.5px; color: var(--ink-2);
      border: 1px dashed var(--line); border-radius: var(--r-control);
      padding: 11px 12px; text-align: center;
      transition: border-color 160ms var(--ease), color 160ms var(--ease), background 160ms var(--ease);
    }
    .file:hover { border-color: var(--accent); color: var(--ink); background: var(--accent-wash); }
    .url { display: flex; gap: 7px; }
    .url input { flex: 1; min-width: 0; font-size: 12.5px; }
    .block { display: block; white-space: normal; line-height: 1.5; padding: 9px 12px; }
  `,
})
export class AssetPicker {
  @Input() label = 'Choisir une image'
  @Output() picked = new EventEmitter<AssetMeta>()

  protected store = inject(StoreService)
  protected readonly ACCEPT = IMAGE_ACCEPT
  readonly url = signal('')
  readonly busy = signal(false)
  readonly error = signal('')

  readonly reusable = () => this.store.imageAssets()

  async fromFile(ev: Event): Promise<void> {
    const file = (ev.target as HTMLInputElement).files?.[0]
    if (!file) return
    this.error.set('')
    try {
      this.picked.emit(await this.store.uploadAsset(file))
    } catch (e) {
      this.error.set(this.explain(e))
    }
  }

  async fromUrl(): Promise<void> {
    const url = this.url().trim()
    if (!url || this.busy()) return
    this.busy.set(true)
    this.error.set('')
    try {
      const meta = await this.store.importFromUrl(url)
      this.url.set('')
      this.picked.emit(meta)
    } catch (e) {
      this.error.set(this.explain(e))
    } finally {
      this.busy.set(false)
    }
  }

  fromLibrary(ev: Event): void {
    const id = (ev.target as HTMLSelectElement).value
    const a = this.store.asset(id)
    if (a) this.picked.emit(a)
  }

  /** Le cas de loin le plus fréquent : coller l'adresse de la PAGE d'un site de
   *  memes au lieu de celle de l'image. Le message doit dire quoi faire. */
  private explain(e: unknown): string {
    const s = String(e)
    if (s.includes('format non supporté')) {
      return "Ce lien ne renvoie pas une image (souvent : c'est l'adresse de la page). Fais clic droit sur l'image elle-même → « Copier l'adresse de l'image »."
    }
    return s.replace(/^Error:\s*/, '')
  }
}
