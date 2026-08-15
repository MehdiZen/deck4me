import { Component, inject, signal } from '@angular/core'
import { RouterLink } from '@angular/router'
import { type HoldMode } from '@meme4me/core'
import { MatcherService } from '../services/matcher.service'
import { StoreService, effectiveThreshold, type StoredGesture } from '../services/store.service'
import { Wizard } from '../components/wizard'

@Component({
  selector: 'app-gestures-page',
  imports: [Wizard, RouterLink],
  template: `
    <div class="head">
      <h1>Gestures</h1>
      <span class="spacer"></span>
      <button class="primary" [disabled]="!store.calibration()" (click)="wizardOpen.set(true)">
        Enregistrer une gesture
      </button>
    </div>

    @if (!store.calibration() && store.loaded()) {
      <div class="card notice warn">
        <b>Commence par la calibration.</b>
        <a routerLink="/reglages">Vingt secondes de visage neutre</a> : elles absorbent
        ta morphologie et tes lunettes, et servent de garde-fou contre les
        déclenchements involontaires.
      </div>
    }
    @if (store.staleGestures().length) {
      <div class="card notice err">
        <b>{{ store.staleGestures().length }} gesture(s) à réenregistrer.</b>
        Elles viennent d'une version antérieure et n'ont plus les données nécessaires.
      </div>
    }

    @if (!store.gestures().length && store.calibration()) {
      <div class="card empty">
        <b>Aucune gesture pour l'instant.</b>
        <p class="lbl">
          Vise huit à quinze poses volontaires et exagérées, lisibles à la caméra.
          Une pose que le viewer ne devine pas ne fait pas un bon bit.
        </p>
      </div>
    }

    <div class="list">
      @for (g of store.gestures(); track g.id) {
        <div class="card row">
          <label class="toggle">
            <input
              type="checkbox"
              [checked]="g.enabled"
              (change)="toggle(g, $event)"
            />
          </label>
          <div style="flex:1; min-width:0">
            <b>{{ g.name }}</b>
            <div class="meta">
              <span class="badge">{{ srcLabel(g.source) }}</span>
              @if (needsPosition(g)) {
                <span
                  class="badge warn"
                  title="Enregistrée avant la prise en compte de la position des mains : réenregistre-la pour distinguer deux poses de même forme"
                >
                  sans position
                </span>
              }
              <span class="lbl">
                seuil <span class="num">{{ effective(g).toFixed(3) }}</span>
                @if ((g.sensitivity ?? 1) !== 1) {
                  <span class="num">({{ ((g.sensitivity ?? 1) * 100).toFixed(0) }}%)</span>
                }
                · <span class="num">{{ g.rawSamples.length }}</span> prises
              </span>
            </div>
          </div>
          <div class="holdcell">
            <select [value]="g.holdMode" (change)="setHoldMode(g, $event)" title="Affichage du meme">
              <option value="fixed_duration">durée fixe</option>
              <option value="while_held">tant que la pose est tenue</option>
            </select>
            @if (g.holdMode === 'fixed_duration' && binding(g.id); as b) {
              <span>
                <input
                  type="number"
                  min="0.3"
                  max="30"
                  step="0.5"
                  style="width:66px"
                  [value]="b.durationMs / 1000"
                  (change)="setDuration(g.id, $event)"
                />
                <span class="lbl">s</span>
              </span>
            }
          </div>
          <div class="bindcell">
            @if (bindingAsset(g.id); as asset) {
              <img [src]="store.assetUrl(asset)" alt="" class="thumb" />
              <span class="fname">{{ asset.filename }}</span>
              <button class="ghost" (click)="store.unbind(g.id)" title="Retirer l'image">×</button>
            } @else {
              <label class="file">
                Choisir une image
                <input type="file" accept=".png,.gif,.webp,.webm" hidden (change)="upload(g, $event)" />
              </label>
            }
          </div>
          <button (click)="matcher.testTrigger(g.id)" title="Affiche le meme dans OBS">
            Tester
          </button>
          <button class="danger" (click)="remove(g)">Supprimer</button>
        </div>
      }
    </div>

    @if (wizardOpen()) {
      <app-wizard (cancel)="wizardOpen.set(false)" (saved)="wizardOpen.set(false)" />
    }
  `,
  styles: `
    .head { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
    .head h1 { margin: 0; }
    .spacer { flex: 1; }

    .notice { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; font-size: 13px; }
    .notice.warn { border-color: #c8820e59; background: #c8820e12; }
    .notice.err { border-color: #e03e4e59; background: #e03e4e12; }
    .notice b { font-weight: 600; }

    .empty { text-align: center; padding: 34px 20px; }
    .empty b { display: block; margin-bottom: 6px; font-weight: 600; }
    .empty .lbl { max-width: 52ch; margin: 0 auto; }

    .list { display: flex; flex-direction: column; gap: 8px; }
    /* Bandeau d'instrument : état à gauche, identité, réglages, actions */
    .row {
      display: flex; align-items: center; gap: 16px;
      padding: 12px 16px;
      transition: border-color 120ms ease;
    }
    .row:hover { border-color: #3d3a4c; }
    .toggle { display: flex; }
    .meta { display: flex; align-items: center; gap: 8px; margin-top: 3px; }

    .holdcell { display: flex; align-items: center; gap: 7px; }
    .holdcell select { max-width: 210px; }

    .bindcell { display: flex; align-items: center; gap: 9px; width: 214px; }
    .thumb {
      height: 38px; width: 52px; object-fit: cover;
      border-radius: 5px; border: 1px solid var(--line);
      background: var(--ground);
    }
    .fname {
      flex: 1; font-size: 12px; color: var(--ink-2);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    button.ghost { padding: 4px 9px; background: none; border-color: transparent; color: var(--ink-3); }
    button.ghost:hover { color: var(--ink); background: var(--panel-2); }
    .file {
      cursor: pointer; font-size: 12.5px; color: var(--ink-2);
      border: 1px dashed var(--line); border-radius: var(--r-control);
      padding: 9px 12px; width: 100%; text-align: center;
      transition: border-color 120ms ease, color 120ms ease;
    }
    .file:hover { border-color: var(--accent); color: var(--ink); }
  `,
})
export class GesturesPage {
  protected store = inject(StoreService)
  protected matcher = inject(MatcherService)
  wizardOpen = signal(false)

  effective(g: StoredGesture): number {
    return effectiveThreshold(g)
  }

  /** Gesture à main enregistrée sans ancre visage : la position ne peut pas
   *  la distinguer d'une autre pose de même forme. */
  needsPosition(g: StoredGesture): boolean {
    if (g.source === 'face') return false
    return !g.rawSamples.some((r) => r.faceAnchor)
  }

  srcLabel(s: string): string {
    return s === 'face' ? 'visage' : s === 'hand' ? 'main' : 'visage+main'
  }

  binding(gestureId: string) {
    return this.store.bindings().find((x) => x.gestureId === gestureId) ?? null
  }

  bindingAsset(gestureId: string) {
    const b = this.binding(gestureId)
    return b ? this.store.assets().find((a) => a.id === b.assetId) ?? null : null
  }

  async toggle(g: StoredGesture, ev: Event): Promise<void> {
    await this.store.saveGesture({ ...g, enabled: (ev.target as HTMLInputElement).checked })
  }

  async setHoldMode(g: StoredGesture, ev: Event): Promise<void> {
    const holdMode = (ev.target as HTMLSelectElement).value as HoldMode
    await this.store.saveGesture({ ...g, holdMode })
  }

  async setDuration(gestureId: string, ev: Event): Promise<void> {
    const sec = Number((ev.target as HTMLInputElement).value)
    if (!Number.isFinite(sec) || sec <= 0) return
    await this.store.updateBinding(gestureId, { durationMs: Math.round(sec * 1000) })
  }

  async upload(g: StoredGesture, ev: Event): Promise<void> {
    const file = (ev.target as HTMLInputElement).files?.[0]
    if (!file) return
    const meta = await this.store.uploadAsset(file)
    await this.store.bindAsset(g.id, meta.id)
  }

  async remove(g: StoredGesture): Promise<void> {
    if (confirm(`Supprimer « ${g.name} » ?`)) await this.store.deleteGesture(g.id)
  }
}
