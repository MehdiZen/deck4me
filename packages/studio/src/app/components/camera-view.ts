import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  effect,
  inject,
} from '@angular/core'
import { DetectionService, type VizFrame } from '../services/detection.service'

/**
 * Preview caméra + landmarks. Le <video> local rejoue le MediaStream partagé ;
 * le canvas est dessiné à chaque frame de détection, hors change detection.
 * Affichage mirroré en CSS uniquement — le flux MediaPipe reste non mirroré.
 */
@Component({
  selector: 'app-camera-view',
  template: `
    <div class="wrap">
      <video #video class="mirror" width="480" height="360" muted playsinline></video>
      <canvas #canvas class="mirror" width="480" height="360"></canvas>
      @if (!detection.running()) {
        <div class="off">{{ detection.status() }}</div>
      }
    </div>
  `,
  styles: `
    .wrap { position: relative; width: 480px; height: 360px; background: #0b1220; border-radius: 10px; overflow: hidden; }
    video, canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
    .off { position: absolute; inset: 0; display: grid; place-items: center; color: #94a3b8; }
  `,
})
export class CameraView implements AfterViewInit, OnDestroy {
  protected detection = inject(DetectionService)
  @ViewChild('video') videoRef!: ElementRef<HTMLVideoElement>
  @ViewChild('canvas') canvasRef!: ElementRef<HTMLCanvasElement>
  private unsub: (() => void) | null = null

  constructor() {
    effect(() => {
      if (this.detection.running() && this.videoRef) this.attach()
    })
  }

  ngAfterViewInit(): void {
    if (this.detection.running()) this.attach()
    this.unsub = this.detection.onFrame((_raw, viz) => this.draw(viz))
  }

  ngOnDestroy(): void {
    this.unsub?.()
  }

  private attach(): void {
    const v = this.videoRef.nativeElement
    if (v.srcObject !== this.detection.stream) {
      v.srcObject = this.detection.stream
      void v.play().catch(() => {})
    }
  }

  private draw(viz: VizFrame): void {
    const canvas = this.canvasRef?.nativeElement
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (viz.faceLandmarks) {
      ctx.fillStyle = '#4ade80'
      for (let i = 0; i < viz.faceLandmarks.length; i += 4) {
        const p = viz.faceLandmarks[i]!
        ctx.fillRect(p.x * canvas.width, p.y * canvas.height, 2, 2)
      }
    }
    viz.handLandmarks.forEach((lm, h) => {
      ctx.fillStyle = h === 0 ? '#60a5fa' : '#f472b6'
      for (const p of lm)
        ctx.fillRect(p.x * canvas.width - 2, p.y * canvas.height - 2, 4, 4)
    })
  }
}
