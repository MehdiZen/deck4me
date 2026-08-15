import { Component, inject, signal } from '@angular/core'
import { RouterLink } from '@angular/router'
import { type HoldMode } from '@facememe/core'
import { MatcherService } from '../services/matcher.service'
import { StoreService, effectiveThreshold, type StoredGesture } from '../services/store.service'
import { Wizard } from '../components/wizard'

@Component({
  selector: 'app-gestures-page',
  imports: [Wizard, RouterLink],
  template: `
    @if (!store.calibration() && store.loaded()) {
      <p class="card badge warn" style="display:block">
        Avant tout : fais la <a routerLink="/reglages">calibration neutre</a> (20 s).
        Elle absorbe ta morphologie et tes lunettes, et sert de garde-fou anti-faux-positifs.
      </p>
    }
    @if (store.staleGestures().length) {
      <p class="card badge err" style="display:block">
        {{ store.staleGestures().length }} gesture(s) d'une ancienne version sans données
        brutes : à réenregistrer.
      </p>
    }
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px">
      <h1 style="margin:0">Gestures</h1>
      <button class="primary" [disabled]="!store.calibration()" (click)="wizardOpen.set(true)">
        + Enregistrer une gesture
      </button>
    </div>

    @if (!store.gestures().length) {
      <p class="card">Aucune gesture. Vise 8 à 15 poses volontaires, exagérées, lisibles à la caméra.</p>
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
          <div style="flex:1">
            <b>{{ g.name }}</b>
            <span class="badge">{{ srcLabel(g.source) }}</span>
            @if (needsPosition(g)) {
              <span class="badge warn" title="Enregistrée avant la prise en compte de la position des mains : réenregistre-la pour distinguer deux poses de même forme">
                sans position
              </span>
            }
            <br />
            <span class="lbl">
              seuil {{ effective(g).toFixed(3) }}
              @if ((g.sensitivity ?? 1) !== 1) {
                ({{ ((g.sensitivity ?? 1) * 100).toFixed(0) }}%)
              }
              · {{ g.rawSamples.length }} samples
            </span>
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
              <span class="lbl">{{ asset.filename }}</span>
              <button (click)="store.unbind(g.id)">retirer</button>
            } @else {
              <label class="lbl file">
                image…
                <input type="file" accept=".png,.gif,.webp,.webm" hidden (change)="upload(g, $event)" />
              </label>
              <span class="lbl">(sinon : image de test)</span>
            }
          </div>
          <button (click)="matcher.testTrigger(g.id)" title="Déclenche dans OBS">Tester</button>
          <button class="danger" (click)="remove(g)">Suppr.</button>
        </div>
      }
    </div>

    @if (wizardOpen()) {
      <app-wizard (cancel)="wizardOpen.set(false)" (saved)="wizardOpen.set(false)" />
    }
  `,
  styles: `
    .list { display: flex; flex-direction: column; gap: 8px; }
    .row { display: flex; align-items: center; gap: 12px; padding: 10px 16px; }
    .thumb { height: 40px; border-radius: 4px; vertical-align: middle; }
    .bindcell { display: flex; align-items: center; gap: 8px; min-width: 220px; }
    .holdcell { display: flex; align-items: center; gap: 6px; }
    .file { cursor: pointer; border: 1px dashed #334155; border-radius: 6px; padding: 4px 10px; }
    .file:hover { border-color: #38bdf8; }
    .toggle input { width: 18px; height: 18px; }
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
