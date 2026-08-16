import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  computed,
  effect,
  inject,
} from '@angular/core'
import { FaceLandmarker } from '@mediapipe/tasks-vision'
import { DetectionService, type VizFrame } from '../services/detection.service'

/** Squelette MediaPipe : paume puis les cinq doigts. Relier les points fait
 *  la différence entre « un nuage » et « une main » à l'œil nu. */
const HAND_BONES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
]

/**
 * Maillage du visage : la tesselation MediaPipe, ≈2500 arêtes, et rien
 * d'autre.
 *
 * Les contours (ovale, sourcils, yeux, lèvres) ont été essayés par-dessus et
 * retirés : appuyer sur les traits d'un visage réel n'y ajoute aucune lecture,
 * ça le cerne et ça l'alourdit. Le filet seul suit le relief et se laisse
 * oublier — c'est ce qu'on veut d'un calque qu'on garde à l'écran en continu.
 * Ne pas les remettre « pour la lisibilité » : c'était le raisonnement d'avant.
 *
 * Mis à plat une fois pour toutes : la conversion {start,end} → paire coûte
 * peu, mais la refaire 30 fois par seconde n'a aucune raison d'être.
 */
const FACE_MESH: [number, number][] = FaceLandmarker.FACE_LANDMARKS_TESSELATION.map((e) => [
  e.start,
  e.end,
])

/**
 * Preview caméra + landmarks. Le <video> local rejoue le MediaStream partagé ;
 * le canvas est dessiné à chaque frame de détection, hors change detection.
 * Affichage mirroré en CSS uniquement — le flux MediaPipe reste non mirroré.
 */
@Component({
  selector: 'app-camera-view',
  template: `
    <!-- Le cadre épouse le rapport d'image de la source (4:3, 16:9…) : sinon
         la vidéo est étirée et les landmarks tombent à côté. -->
    <div class="wrap" [style.aspect-ratio]="aspect()">
      <video #video class="mirror" muted playsinline></video>
      <canvas #canvas class="mirror" width="640" height="480"></canvas>
      @if (!detection.running()) {
        <div class="off">{{ detection.status() }}</div>
      }
    </div>
  `,
  styles: `
    :host { display: block; }
    .wrap {
      position: relative; width: 100%;
      background: var(--void);
      overflow: hidden;
    }
    video, canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
    video { object-fit: cover; }
    /* Vignettage discret : recentre le regard sur le visage sans rien masquer */
    .wrap::after {
      content: ''; position: absolute; inset: 0; pointer-events: none;
      box-shadow: inset 0 0 90px 12px #00000066;
    }
    .off {
      position: absolute; inset: 0; display: grid; place-items: center;
      color: var(--ink-3); font-size: 13px; padding: 20px; text-align: center;
    }
  `,
})
export class CameraView implements AfterViewInit, OnDestroy {
  protected detection = inject(DetectionService)

  /** Rapport d'image de la source, 4/3 tant qu'elle n'a pas démarré. */
  protected aspect = computed(() => {
    const s = this.detection.sourceSize()
    return s ? `${s.w} / ${s.h}` : '4 / 3'
  })

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
    // Aligner la toile sur le rapport de la source, sinon les points dessinés
    // ronds deviennent ovales une fois la toile étirée dans le cadre.
    const src = this.detection.sourceSize()
    if (src) {
      const w = 640
      const h = Math.round((640 * src.h) / src.w)
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
    }
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    // Le visage se dessine sous les mains : quand une main passe devant la
    // bouche, c'est la main qu'on veut lire par-dessus, pas le filet.
    if (viz.faceLandmarks) {
      // Opacité relevée depuis que le filet est seul : à 12 % il ne servait que
      // de fond aux contours, il doit maintenant se tenir tout seul.
      ctx.strokeStyle = '#5eead440'
      ctx.lineWidth = 0.6
      this.bones(ctx, viz.faceLandmarks, FACE_MESH)
    }
    viz.handLandmarks.forEach((lm, h) => {
      const color = h === 0 ? '#a78bfa' : '#f0abfc'
      ctx.strokeStyle = color + '99'
      ctx.lineWidth = 1.6
      this.bones(ctx, lm, HAND_BONES)
      ctx.fillStyle = color
      for (const p of lm) {
        ctx.beginPath()
        ctx.arc(p.x * canvas.width, p.y * canvas.height, 2.4, 0, 7)
        ctx.fill()
      }
    })
  }

  /** Un seul chemin pour tout un jeu d'arêtes : 2500 `stroke()` séparés
   *  coûteraient un ordre de grandeur de plus qu'un `stroke()` unique. */
  private bones(
    ctx: CanvasRenderingContext2D,
    lm: { x: number; y: number }[],
    bones: [number, number][],
  ): void {
    const { width, height } = ctx.canvas
    ctx.beginPath()
    for (const [a, b] of bones) {
      const p = lm[a]
      const q = lm[b]
      if (!p || !q) continue
      ctx.moveTo(p.x * width, p.y * height)
      ctx.lineTo(q.x * width, q.y * height)
    }
    ctx.stroke()
  }
}
