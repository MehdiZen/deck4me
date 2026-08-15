import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  inject,
} from '@angular/core'
import { HYSTERESIS, type BlockDiag } from '@facememe/core'
import { CameraView } from '../components/camera-view'
import { DetectionService } from '../services/detection.service'
import { MatcherService } from '../services/matcher.service'
import { StoreService, effectiveThreshold, type StoredGesture } from '../services/store.service'

/**
 * Écran Live (pré-version de l'écran Debug de la phase 5).
 * Barres de distance + indicateurs par bloc en canvas, PAS en DOM : 30 Hz.
 * Les curseurs de sensibilité sont en DOM : ils ne changent qu'à la main.
 */
@Component({
  selector: 'app-live-page',
  imports: [CameraView],
  template: `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px">
      <h1 style="margin:0">Live</h1>
      <div style="display:flex; gap:8px; align-items:center">
        <span class="lbl">{{ detection.status() }} · {{ detection.fps() }} fps</span>
        @if (!detection.running()) {
          <button class="primary" (click)="detection.start()">Démarrer la caméra</button>
        } @else {
          <button (click)="detection.stop()">Arrêter</button>
        }
        @if (matcher.muted()) {
          <button class="primary" (click)="matcher.unmute()">Réactiver les gestures</button>
        } @else {
          <button class="danger" (click)="matcher.panic()">PANIC — tout couper</button>
        }
      </div>
    </div>
    <div class="cols">
      <app-camera-view />
      <div class="card grow">
        <h2>Distances</h2>
        <p class="lbl" style="margin-top:0">
          Barre = distance à la pose · trait plein = seuil · pointillé = sortie ×{{ HYSTERESIS }}.
          Sous chaque barre, le détail par partie :
          <span style="color:#86efac">vert</span> = conforme,
          <span style="color:#fca5a5">rouge</span> = c'est ça qui bloque,
          <span style="color:#cbd5e1">gris</span> = pas vu par la caméra.
        </p>
        <canvas #bars></canvas>

        <h2 style="margin-top:16px">Sensibilité</h2>
        <p class="lbl" style="margin-top:0">
          Vers la droite = déclenche plus facilement (et plus de faux positifs).
          Prends la pose, regarde où arrive la barre, place le seuil juste au-delà.
        </p>
        @if (!store.gestures().length) {
          <p class="lbl">aucune gesture</p>
        }
        <div class="sens">
          @for (g of store.gestures(); track g.id) {
            <div class="sensrow">
              <span class="nm">{{ g.name }}</span>
              <input
                type="range"
                min="0.4"
                max="3"
                step="0.05"
                [value]="g.sensitivity ?? 1"
                (input)="onSlide(g, $event)"
                (change)="onCommit(g)"
              />
              <span class="pct">{{ ((g.sensitivity ?? 1) * 100).toFixed(0) }}%</span>
              <span class="lbl">seuil {{ effective(g).toFixed(3) }}</span>
              <button (click)="resetSens(g)" [disabled]="(g.sensitivity ?? 1) === 1">auto</button>
            </div>
          }
        </div>
      </div>
      <div class="card" style="min-width:230px">
        <h2>Derniers triggers</h2>
        @if (!matcher.triggerLog().length) {
          <p class="lbl">aucun</p>
        }
        <ul class="log">
          @for (t of matcher.triggerLog(); track $index) {
            <li>
              <span class="lbl">{{ t.at }}</span>
              {{ t.name }}
              <span class="badge" [class.ok]="t.kind === 'fire'">{{ t.kind }}</span>
            </li>
          }
        </ul>
      </div>
    </div>
  `,
  styles: `
    .cols { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
    .grow { flex: 1 1 460px; min-width: 0; }
    canvas { display: block; width: 100%; }
    .log { list-style: none; margin: 0; padding: 0; }
    .log li { padding: 3px 0; border-bottom: 1px solid #33415555; }
    .sens { display: flex; flex-direction: column; gap: 6px; }
    .sensrow { display: flex; align-items: center; gap: 10px; }
    .sensrow .nm { flex: 0 0 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sensrow input[type='range'] { flex: 1; min-width: 80px; accent-color: #0ea5e9; }
    .sensrow .pct { flex: 0 0 42px; text-align: right; font-variant-numeric: tabular-nums; }
    .sensrow button { padding: 2px 10px; }
  `,
})
export class LivePage implements AfterViewInit, OnDestroy {
  protected detection = inject(DetectionService)
  protected matcher = inject(MatcherService)
  protected store = inject(StoreService)
  protected readonly HYSTERESIS = HYSTERESIS
  @ViewChild('bars') barsRef!: ElementRef<HTMLCanvasElement>
  private raf = 0

  ngAfterViewInit(): void {
    const draw = () => {
      this.drawBars()
      this.raf = requestAnimationFrame(draw)
    }
    this.raf = requestAnimationFrame(draw)
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.raf)
  }

  effective(g: StoredGesture): number {
    return effectiveThreshold(g)
  }

  onSlide(g: StoredGesture, ev: Event): void {
    this.store.setSensitivityLocal(g.id, Number((ev.target as HTMLInputElement).value))
  }

  async onCommit(g: StoredGesture): Promise<void> {
    await this.store.persistGesture(g.id)
  }

  async resetSens(g: StoredGesture): Promise<void> {
    this.store.setSensitivityLocal(g.id, 1)
    await this.store.persistGesture(g.id)
  }

  /** « main G » = ta main gauche : le flux n'est pas mirroré, la handedness
   *  MediaPipe est donc anatomique. */
  private blockLabel(b: BlockDiag): string {
    if (b.kind === 'face') return 'visage'
    const side = b.slot === 0 ? 'G' : 'D'
    return b.kind === 'hand' ? `main ${side}` : `pos ${side}`
  }

  private drawBars(): void {
    const canvas = this.barsRef.nativeElement
    const snaps = this.matcher.lastSnapshots
    const ROW = 58
    const cssW = canvas.clientWidth || 480
    const cssH = Math.max(1, snaps.length) * ROW + 10
    const dpr = window.devicePixelRatio || 1
    const pxW = Math.round(cssW * dpr)
    const pxH = Math.round(cssH * dpr)
    // Redimensionner réinitialise le contexte : on le fait AVANT tout réglage.
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW
      canvas.height = pxH
      canvas.style.height = `${cssH}px`
    }

    const ctx = canvas.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, cssH)
    ctx.font = '12px system-ui'

    if (!snaps.length) {
      ctx.fillStyle = '#94a3b8'
      ctx.fillText(
        this.matcher.muted()
          ? 'PANIC actif — gestures coupées'
          : 'aucune gesture active (caméra démarrée ? gestures activées ?)',
        0,
        20,
      )
      return
    }

    // Échelle adaptative : on garde le seuil le plus large et les distances
    // courantes dans le cadre, sans jamais déborder.
    let maxVal = 0.25
    for (const s of snaps) {
      maxVal = Math.max(maxVal, s.threshold * HYSTERESIS * 1.15)
      if (s.dist !== null) maxVal = Math.max(maxVal, s.dist * 1.05)
    }
    const SCALE = cssW / maxVal

    snaps.forEach((s, i) => {
      const y = i * ROW + 6
      ctx.fillStyle = '#e2e8f0'
      ctx.fillText(
        `${s.name} — ${s.dist === null ? 'incomplet' : s.dist.toFixed(3)} [${s.state}]`,
        0,
        y + 10,
      )

      const barY = y + 16
      ctx.fillStyle = '#0b1220'
      ctx.fillRect(0, barY, cssW, 12)
      if (s.dist !== null) {
        ctx.fillStyle =
          s.state === 'ACTIVE'
            ? '#34d399'
            : s.state === 'CANDIDATE'
              ? '#fde047'
              : s.state === 'COOLDOWN'
                ? '#60a5fa'
                : '#64748b'
        ctx.fillRect(0, barY, Math.max(0, Math.min(cssW, s.dist * SCALE)), 12)
      }
      const tx = Math.min(cssW - 2, s.threshold * SCALE)
      ctx.fillStyle = '#f8fafc'
      ctx.fillRect(tx, barY - 2, 2, 16)
      ctx.strokeStyle = '#f8fafc88'
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      const hx = Math.min(cssW - 1, s.threshold * HYSTERESIS * SCALE)
      ctx.moveTo(hx, barY - 2)
      ctx.lineTo(hx, barY + 14)
      ctx.stroke()
      ctx.setLineDash([])

      // Indicateurs par bloc : ce qui manque / ce qui est trop loin.
      // Comparer un bloc seul au seuil de la gesture est une heuristique
      // (le seuil porte sur la moyenne) mais c'est ce qui se lit le mieux :
      // « cette partie à elle seule dépasse le budget total ».
      let x = 0
      const chipY = barY + 18
      for (const b of s.blocks ?? []) {
        const label = this.blockLabel(b)
        const text = b.dist === null ? `${label} absent` : `${label} ${b.dist.toFixed(2)}`
        const w = ctx.measureText(text).width + 12
        if (x + w > cssW) break // jamais de débordement
        const over = b.dist !== null && b.dist > s.threshold
        ctx.fillStyle = b.dist === null ? '#334155' : over ? '#7f1d1d' : '#14532d'
        ctx.fillRect(x, chipY, w, 16)
        ctx.fillStyle = b.dist === null ? '#cbd5e1' : over ? '#fca5a5' : '#86efac'
        ctx.fillText(text, x + 6, chipY + 12)
        x += w + 6
      }
    })
  }
}
