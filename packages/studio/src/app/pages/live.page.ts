import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  inject,
} from '@angular/core'
import { HYSTERESIS, type BlockDiag } from '@meme4me/core'
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
    <div class="head">
      <h1>Live</h1>
      <span class="badge">
        <i class="led" [class.on]="detection.running()"></i>{{ detection.status() }}
        @if (detection.running()) {
          · <b class="num">{{ detection.fps() }}</b> fps
        }
      </span>
      <span class="spacer"></span>
      @if (!detection.running()) {
        <button class="primary" (click)="detection.start()">Démarrer la caméra</button>
      } @else {
        <button (click)="detection.stop()">Arrêter la caméra</button>
      }
      @if (matcher.muted()) {
        <button class="primary" (click)="matcher.unmute()">Réactiver les gestures</button>
      } @else {
        <button class="danger" (click)="matcher.panic()">Panic — tout couper</button>
      }
    </div>

    <div class="cols">
      <app-camera-view />

      <div class="card grow">
        <h2>Distances</h2>
        <p class="lbl legend">
          Barre = distance à la pose · trait plein = seuil · pointillé = relâche
          (×{{ HYSTERESIS }}). Sous chaque barre, le détail par partie du corps.
        </p>
        <canvas #bars></canvas>

        <div class="sep"></div>

        <h2>Sensibilité</h2>
        <p class="lbl legend">
          Vers la droite, la pose déclenche plus facilement — et les faux positifs
          arrivent plus vite. Prends la pose, regarde où s'arrête la barre, puis
          amène le seuil juste au-delà.
        </p>
        @if (!store.gestures().length) {
          <p class="empty">Aucune gesture enregistrée pour l'instant.</p>
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
                [attr.aria-label]="'Sensibilité de ' + g.name"
              />
              <span class="pct num">{{ ((g.sensitivity ?? 1) * 100).toFixed(0) }}%</span>
              <span class="thr num">{{ effective(g).toFixed(3) }}</span>
              <button (click)="resetSens(g)" [disabled]="(g.sensitivity ?? 1) === 1">Auto</button>
            </div>
          }
        </div>
      </div>

      <div class="card log-panel">
        <h2>Derniers triggers</h2>
        @if (!matcher.triggerLog().length) {
          <p class="empty">Rien encore. Prends une pose enregistrée.</p>
        }
        <ul class="log">
          @for (t of matcher.triggerLog(); track $index) {
            <li>
              <i class="led" [class.on]="t.kind === 'fire'"></i>
              <span class="nm">{{ t.name }}</span>
              <span class="at num">{{ t.at }}</span>
            </li>
          }
        </ul>
      </div>
    </div>
  `,
  styles: `
    .head { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
    .head h1 { margin: 0; }
    .spacer { flex: 1; }
    .cols { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
    .grow { flex: 1 1 460px; min-width: 0; }
    .log-panel { flex: 0 1 250px; min-width: 220px; }
    canvas { display: block; width: 100%; }
    .legend { max-width: 62ch; margin-bottom: 14px; }
    .empty { color: var(--ink-3); font-size: 13px; }
    .sep { height: 1px; background: var(--line-soft); margin: 20px 0 18px; }

    .log { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .log li {
      display: flex; align-items: center; gap: 9px;
      padding: 7px 0; border-bottom: 1px solid var(--line-soft);
      font-size: 13px;
    }
    .log li:last-child { border-bottom: 0; }
    .log .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .log .at { color: var(--ink-3); font-size: 11.5px; }

    .sens { display: flex; flex-direction: column; gap: 4px; }
    .sensrow {
      display: flex; align-items: center; gap: 12px;
      padding: 5px 8px; border-radius: var(--r-control);
    }
    .sensrow:hover { background: var(--panel-2); }
    .sensrow .nm {
      flex: 0 0 118px; font-size: 13px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .sensrow input[type='range'] { flex: 1; min-width: 80px; }
    .sensrow .pct { flex: 0 0 40px; text-align: right; font-size: 12px; }
    .sensrow .thr { flex: 0 0 46px; text-align: right; font-size: 12px; color: var(--ink-3); }
    .sensrow button { padding: 4px 11px; font-size: 12px; }
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

  /** Couleurs lues depuis les tokens CSS : la toile et le DOM ne divergent jamais. */
  private token(name: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  }

  private stateColor(state: string): string {
    switch (state) {
      case 'ACTIVE':
        return this.token('--st-armed')
      case 'CANDIDATE':
        return this.token('--st-candidate')
      case 'COOLDOWN':
        return this.token('--st-cooldown')
      default:
        return this.token('--st-idle')
    }
  }

  /** Barre à extrémité arrondie, ancrée à la ligne de base. */
  private bar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
    const r = Math.min(4, w / 2)
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + w - r, y)
    ctx.quadraticCurveTo(x + w, y, x + w, y + r)
    ctx.lineTo(x + w, y + h - r)
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
    ctx.lineTo(x, y + h)
    ctx.closePath()
    ctx.fill()
  }

  private drawBars(): void {
    const canvas = this.barsRef.nativeElement
    const snaps = this.matcher.lastSnapshots
    const ROW = 62
    const BAR_H = 10
    const cssW = canvas.clientWidth || 480
    const cssH = Math.max(1, snaps.length) * ROW + 12
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

    const ink = this.token('--ink')
    const ink2 = this.token('--ink-2')
    const ink3 = this.token('--ink-3')
    const track = this.token('--ground')
    const panel = this.token('--panel-2')
    const uiFont = '12.5px "Segoe UI Variable Display", "Segoe UI", system-ui'
    const dataFont = '12px "Cascadia Mono", ui-monospace, Consolas, monospace'

    if (!snaps.length) {
      ctx.font = uiFont
      ctx.fillStyle = ink3
      ctx.fillText(
        this.matcher.muted()
          ? 'Gestures coupées par le bouton Panic.'
          : 'Rien à mesurer : démarre la caméra et active au moins une gesture.',
        0,
        20,
      )
      return
    }

    // Échelle adaptative : seuils et distances tiennent toujours dans le cadre.
    let maxVal = 0.25
    for (const s of snaps) {
      maxVal = Math.max(maxVal, s.threshold * HYSTERESIS * 1.15)
      if (s.dist !== null) maxVal = Math.max(maxVal, s.dist * 1.05)
    }
    const SCALE = cssW / maxVal

    snaps.forEach((s, i) => {
      const y = i * ROW + 8
      const color = this.stateColor(s.state)

      // Le nom porte l'encre du texte, jamais la couleur de série : c'est le
      // voyant à gauche qui porte l'identité d'état, doublé du mot lui-même.
      ctx.beginPath()
      ctx.fillStyle = color
      ctx.arc(4, y + 5, 4, 0, 7)
      ctx.fill()

      ctx.font = uiFont
      ctx.fillStyle = ink
      ctx.fillText(s.name, 15, y + 9)
      const nameW = ctx.measureText(s.name).width

      ctx.font = dataFont
      ctx.fillStyle = ink3
      ctx.fillText(s.state.toLowerCase(), 15 + nameW + 10, y + 9)

      // La valeur, alignée à droite : c'est le chiffre qu'on vient chercher
      ctx.textAlign = 'right'
      ctx.fillStyle = s.dist === null ? ink3 : ink2
      ctx.fillText(s.dist === null ? '—' : s.dist.toFixed(3), cssW, y + 9)
      ctx.textAlign = 'left'

      const barY = y + 18
      ctx.fillStyle = track
      ctx.fillRect(0, barY, cssW, BAR_H)
      if (s.dist !== null) {
        ctx.fillStyle = color
        this.bar(ctx, 0, barY, Math.max(2, Math.min(cssW, s.dist * SCALE)), BAR_H)
      }

      // Repères récessifs : seuil (plein) et sortie d'hystérésis (pointillé)
      const tx = Math.min(cssW - 2, s.threshold * SCALE)
      ctx.fillStyle = ink2
      ctx.fillRect(tx, barY - 3, 1.5, BAR_H + 6)
      ctx.strokeStyle = ink3
      ctx.lineWidth = 1
      ctx.setLineDash([2, 3])
      ctx.beginPath()
      const hx = Math.min(cssW - 1, s.threshold * HYSTERESIS * SCALE)
      ctx.moveTo(hx, barY - 3)
      ctx.lineTo(hx, barY + BAR_H + 3)
      ctx.stroke()
      ctx.setLineDash([])

      // Détail par partie. Comparer un bloc seul au seuil est une heuristique
      // (le seuil porte sur la moyenne) mais c'est ce qui se lit le mieux :
      // « cette partie à elle seule dépasse le budget total ».
      let x = 0
      const chipY = barY + BAR_H + 8
      ctx.font = dataFont
      for (const b of s.blocks ?? []) {
        const label = this.blockLabel(b)
        const text = b.dist === null ? `${label} —` : `${label} ${b.dist.toFixed(2)}`
        const w = ctx.measureText(text).width + 14
        if (x + w > cssW) break // jamais de débordement
        const over = b.dist !== null && b.dist > s.threshold
        const hue =
          b.dist === null
            ? this.token('--st-idle')
            : over
              ? this.token('--st-live')
              : this.token('--st-armed')
        ctx.fillStyle = panel
        ctx.fillRect(x, chipY, w, 17)
        ctx.fillStyle = hue
        ctx.fillRect(x, chipY, 2, 17) // liseré : l'état se lit aussi à la forme
        ctx.fillStyle = b.dist === null ? ink3 : ink2
        ctx.fillText(text, x + 9, chipY + 12)
        x += w + 5 // écart de surface entre pastilles
      }
    })
  }
}
