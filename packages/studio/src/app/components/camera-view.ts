import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core'
import { FaceLandmarker } from '@mediapipe/tasks-vision'
import { DetectionService, type VizFrame } from '../services/detection.service'
import { Icon } from './icon'

/**
 * Masquer la vidéo est un réglage de confort qui vaut pour TOUTES les vues
 * caméra à la fois — Live, assistant, calibration. Un signal de module plutôt
 * qu'un état par instance : sinon on le couperait sur Live et il reviendrait
 * en pleine figure à l'ouverture de l'assistant.
 *
 * Le stockage local suffit : perdre ce choix ne coûte qu'un clic, et le faire
 * transiter par la base ajouterait une migration pour une préférence
 * d'affichage.
 */
const HIDE_KEY = 'deck4me.hideVideo'
const hideVideo = signal(localStorage.getItem(HIDE_KEY) === '1')

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
  imports: [Icon],
  template: `
    <!-- Le cadre épouse le rapport d'image de la source (4:3, 16:9…) : sinon
         la vidéo est étirée et les landmarks tombent à côté. -->
    <div class="wrap" [class.bare]="hidden()" [style.aspect-ratio]="aspect()">
      <video #video class="mirror" muted playsinline></video>
      <canvas #canvas class="mirror" width="640" height="480"></canvas>
      @if (detection.running()) {
        <button
          type="button"
          class="toggle"
          (click)="toggleVideo()"
          [title]="hidden() ? 'Afficher la caméra' : 'Masquer la caméra, garder le maillage'"
          [attr.aria-pressed]="hidden()"
        >
          <app-icon [name]="hidden() ? 'eye-off' : 'eye'" [size]="15" />
          {{ hidden() ? 'Caméra masquée' : 'Masquer la caméra' }}
        </button>
      } @else {
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
    video { object-fit: cover; transition: opacity .18s ease; }
    /* Vignettage discret : recentre le regard sur le visage sans rien masquer */
    .wrap::after {
      content: ''; position: absolute; inset: 0; pointer-events: none;
      box-shadow: inset 0 0 90px 12px #00000066;
    }
    /* Caméra masquée : la vidéo s'efface, le maillage reste. Opacité et non
       display:none — le <video> doit continuer à jouer, c'est LUI que
       MediaPipe échantillonne. Le couper arrêterait la détection. */
    .bare video { opacity: 0; }
    .bare::after { box-shadow: none; }

    /* Toujours visible, et libellé.
       Il n'apparaissait qu'au survol : une commande qu'on ne voit pas est une
       commande qui n'existe pas, et celle-ci est une des rares choses que ce
       logiciel fait et que les autres ne font pas. Elle se montre donc, avec
       son mot — une icône seule n'annonce pas ce qu'elle va faire. */
    .toggle {
      position: absolute; top: 9px; right: 9px;
      display: flex; align-items: center; gap: 6px;
      height: 30px; padding: 0 10px;
      border: 1px solid #ffffff2e; border-radius: 8px;
      background: #0b0f14d9; color: var(--ink-1);
      font-size: 11.5px; font-weight: 560; letter-spacing: 0.01em;
      cursor: pointer;
      box-shadow: 0 2px 10px #0006;
      transition: background .15s ease, border-color .15s ease;
    }
    .toggle:hover { background: #131a22ee; border-color: #ffffff4d; }
    /* Caméra masquée : l'état actif se voit, sinon on ne sait plus si le noir
       vient d'un réglage ou d'une panne. */
    .bare .toggle { background: #5eead41f; border-color: #5eead466; color: #5eead4; }
    .off {
      position: absolute; inset: 0; display: grid; place-items: center;
      color: var(--ink-3); font-size: 13px; padding: 20px; text-align: center;
    }
  `,
})
export class CameraView implements AfterViewInit, OnDestroy {
  protected detection = inject(DetectionService)

  protected hidden = hideVideo.asReadonly()

  protected toggleVideo(): void {
    const next = !hideVideo()
    hideVideo.set(next)
    localStorage.setItem(HIDE_KEY, next ? '1' : '0')
  }

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
    // En flux direct il n'y a pas de MediaStream, donc rien à donner au
    // <video> : l'image arrive en JPEG depuis Rust et se dessine ici, sous les
    // landmarks. Sans ça, l'aperçu resterait noir alors que la détection
    // tourne — et on croirait la caméra en panne.
    const feed = this.detection.feedActive()
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
    const bmp = this.detection.bitmap
    if (feed && bmp && !this.hidden()) {
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height)
    }
    // Le visage se dessine sous les mains : quand une main passe devant la
    // bouche, c'est la main qu'on veut lire par-dessus, pas le filet.
    if (viz.faceLandmarks) {
      // Opacité relevée depuis que le filet est seul : à 12 % il ne servait que
      // de fond aux contours, il doit maintenant se tenir tout seul. Sur fond
      // noir il n'a plus le visage pour l'appuyer, d'où le second palier — un
      // filet à 25 % sur du vide est illisible.
      ctx.strokeStyle = this.hidden() ? '#5eead4b0' : '#5eead440'
      ctx.lineWidth = this.hidden() ? 0.75 : 0.6
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
