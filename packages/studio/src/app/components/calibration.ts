import { Component, computed, inject, signal } from '@angular/core'
import type { RawFrame } from '@meme4me/core'
import { DetectionService } from '../services/detection.service'
import { StoreService } from '../services/store.service'
import { CameraView } from './camera-view'

const DURATION_MS = 20000
const SAMPLE_EVERY_MS = 250

/**
 * Calibration « neutre » : 20 s de comportement normal (parler, bouger).
 * Produit la baseline visage (biais morphologique + lunettes) et le jeu
 * négatif anti-faux-positifs utilisé par le wizard.
 */
@Component({
  selector: 'app-calibration',
  imports: [CameraView],
  template: `
    <div class="card">
      <h2>Calibration neutre</h2>
      @if (store.calibration(); as cal) {
        <p>
          <span class="badge ok">Calibré</span>
          {{ cal.negativesRaw.length }} frames de référence, le
          {{ cal.savedAt.slice(0, 10) }}
        </p>
      } @else {
        <p><span class="badge warn">Requis avant d'enregistrer des gestures</span></p>
      }
      <p class="lbl">
        20 secondes : parle normalement, ris, bois, regarde ailleurs — comme en stream.
        Garde les lunettes que tu portes en live. Ne prends PAS de pose.
      </p>
      @if (running()) {
        <app-camera-view />
        <div class="progress"><div [style.width.%]="progress()"></div></div>
        <p>{{ frames().length }} frames capturées…</p>
      } @else {
        <button class="primary" [disabled]="busy()" (click)="start()">
          {{ store.calibration() ? 'Recalibrer' : 'Lancer la calibration' }}
        </button>
      }
    </div>
  `,
  styles: `
    .progress { height: 10px; background: #0b1220; border-radius: 5px; margin: 12px 0; overflow: hidden; }
    .progress > div { height: 100%; background: #0ea5e9; transition: width .1s linear; }
  `,
})
export class Calibration {
  protected store = inject(StoreService)
  private detection = inject(DetectionService)

  running = signal(false)
  busy = signal(false)
  frames = signal<RawFrame[]>([])
  private startedAt = 0
  progress = computed(() => Math.min(100, (this.frames().length * SAMPLE_EVERY_MS * 100) / DURATION_MS))

  async start(): Promise<void> {
    this.busy.set(true)
    try {
      await this.detection.start()
      this.frames.set([])
      this.running.set(true)
      this.startedAt = performance.now()
      let lastAt = 0
      const unsub = this.detection.onFrame((raw, _viz, ts) => {
        if (raw.face && ts - lastAt >= SAMPLE_EVERY_MS) {
          lastAt = ts
          this.frames.update((f) => [...f, JSON.parse(JSON.stringify(raw)) as RawFrame])
        }
        if (ts - this.startedAt >= DURATION_MS) {
          unsub()
          void this.finish()
        }
      })
    } catch {
      this.busy.set(false)
    }
  }

  private async finish(): Promise<void> {
    this.running.set(false)
    await this.store.saveCalibration(this.frames())
    this.busy.set(false)
  }
}
