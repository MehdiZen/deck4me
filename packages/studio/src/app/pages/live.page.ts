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
import { HYSTERESIS, type BlockDiag } from '@meme4me/core'
import { CameraView } from '../components/camera-view'
import { Icon } from '../components/icon'
import { DetectionService } from '../services/detection.service'
import { MatcherService } from '../services/matcher.service'
import { StoreService } from '../services/store.service'

/**
 * Écran Live : ce qu'on regarde pendant qu'on stream.
 * Les barres de distance sont en canvas, PAS en DOM — elles se redessinent à
 * 30 Hz et feraient tourner la change detection sur chaque frame.
 * Le seuil se règle en attrapant son trait directement dans le graphe : la
 * chose qu'on regarde et la commande qu'on manipule sont la même.
 */
@Component({
  selector: 'app-live-page',
  imports: [CameraView, Icon],
  template: `
    <div class="head">
      <div>
        <h1>Live</h1>
        <p class="lbl sub">{{ detection.status() }}</p>
      </div>
      <span class="spacer"></span>
      @if (!detection.running()) {
        <button class="primary" (click)="detection.start()">
          <app-icon name="play" [size]="16" /> Démarrer la caméra
        </button>
      } @else {
        <button (click)="detection.stop()"><app-icon name="stop" [size]="15" /> Arrêter</button>
      }
      @if (matcher.muted()) {
        <button class="primary" (click)="matcher.unmute()">Réactiver les gestures</button>
      } @else {
        <button class="danger" (click)="matcher.panic()">
          <app-icon name="power" [size]="15" /> Panic
        </button>
      }
    </div>

    <div class="cols">
      <div class="left">
        <div class="card viewport" [class.fired]="flash()">
          <app-camera-view />
          <!-- Bandeau d'instrument sur l'image : ce qui compte pendant un live
               se lit sans quitter la vidéo des yeux. -->
          <div class="hud">
            <span class="badge" [class.ok]="detection.running()">
              <i class="led" [class.on]="detection.running()"></i>
              {{ detection.running() ? 'détection' : 'arrêt' }}
            </span>
            @if (detection.running()) {
              <span class="badge"><b class="num">{{ detection.fps() }}</b> fps</span>
              @if (detection.sourceSize(); as s) {
                <span class="badge"><span class="num">{{ s.w }}×{{ s.h }}</span></span>
              }
            }
            <span class="spacer"></span>
            @if (armed(); as n) {
              <span class="badge ok"><span class="num">{{ n }}</span> armée(s)</span>
            }
          </div>
        </div>

        <div class="card log-panel">
          <h2>Derniers triggers</h2>
          @if (!matcher.triggerLog().length) {
            <p class="empty">Rien encore. Prends une pose enregistrée.</p>
          }
          <ul class="log">
            @for (t of matcher.triggerLog(); track t.ts) {
              <li class="rise" [class.failed]="t.kind === 'error'" [title]="t.detail ?? ''">
                <i class="led" [class.on]="t.kind === 'fire'" [class.bad]="t.kind === 'error'"></i>
                <span class="nm">{{ t.name }}</span>
                <span class="kind lbl">{{ label(t.kind) }}</span>
                <span class="at num">{{ t.at }}</span>
              </li>
            }
          </ul>
        </div>
      </div>

      <div class="right">
        <div class="card">
          <div class="cardhead">
            <h2>Distances</h2>
            <span class="lbl legend">
              glisse le trait pour régler · double-clic = auto · pointillé =
              relâche (×{{ HYSTERESIS }})
            </span>
          </div>
          <!-- mouseup et mouseleave sur la fenêtre : relâcher hors de la toile
               doit terminer le geste, sinon le glissement reste collé au
               curseur après coup. -->
          <canvas
            #bars
            [class.grabbing]="!!drag()"
            [class.grab]="!drag() && !!hover()"
            (mousedown)="onBarsDown($event)"
            (mousemove)="onBarsMove($event)"
            (mouseleave)="hover.set(null)"
            (dblclick)="onBarsDbl($event)"
            (window:mouseup)="onBarsUp()"
          ></canvas>
        </div>

      </div>
    </div>
  `,
  styles: `
    .head { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 20px; }
    .head h1 { margin: 0 0 4px; }
    .sub { margin: 0; text-transform: none; letter-spacing: 0; }

    .cols { display: flex; gap: 16px; align-items: flex-start; }
    .left { flex: 0 1 500px; min-width: 340px; display: flex; flex-direction: column; gap: 16px; }
    .right { flex: 1 1 520px; min-width: 0; display: flex; flex-direction: column; gap: 16px; }
    @media (max-width: 1120px) { .cols { flex-wrap: wrap; } .left, .right { flex-basis: 100%; } }

    /* La vidéo occupe toute la carte : aucune marge ne vient la « décorer ». */
    .viewport { padding: 0; overflow: hidden; transition: box-shadow 200ms var(--ease), border-color 200ms var(--ease); }
    /* Un meme part à l'antenne : la carte s'allume une demi-seconde. C'est le
       seul retour visuel qu'on peut capter du coin de l'œil sans lâcher la
       caméra des yeux. */
    .viewport.fired {
      border-color: var(--st-armed);
      box-shadow: var(--edge), 0 0 0 1px #17a26866, 0 0 34px -4px #17a268aa;
    }
    .viewport app-camera-view { display: block; }
    .hud {
      display: flex; align-items: center; gap: 7px;
      padding: 10px 12px; border-top: 1px solid var(--line-soft);
      background: #100f16;
    }

    .cardhead { display: flex; align-items: baseline; gap: 12px; margin-bottom: 12px; }
    .cardhead h2 { margin: 0; }
    .legend { flex: 1; text-align: right; text-transform: none; letter-spacing: 0; font-size: 11px; }
    .hint { max-width: 64ch; margin-bottom: 14px; }

    canvas { display: block; width: 100%; }
    /* Le curseur est la seule affordance possible sur une toile : il doit dire
       « ça s'attrape » avant qu'on essaie. */
    canvas.grab { cursor: ew-resize; }
    canvas.grabbing { cursor: grabbing; user-select: none; }
    .empty { color: var(--ink-3); font-size: 13px; }

    .log-panel { max-height: 320px; display: flex; flex-direction: column; }
    .log { list-style: none; margin: 0; padding: 0; overflow-y: auto; }
    .log li {
      display: flex; align-items: center; gap: 10px;
      padding: 8px 0; border-bottom: 1px solid var(--line-soft);
      font-size: 13px;
    }
    .log li:last-child { border-bottom: 0; }
    .log .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .log .kind { font-size: 10px; }
    .log .at { color: var(--ink-3); font-size: 11.5px; }
    /* Un échec d'action se lit dans le même journal que les déclenchements —
       c'est là qu'on regarde quand quelque chose ne s'est pas produit. */
    .log li.failed .nm, .log li.failed .kind { color: var(--st-live); }
    .log .led.bad { background: var(--st-live); box-shadow: 0 0 8px var(--st-live); }
  `,
})
export class LivePage implements AfterViewInit, OnDestroy {
  protected detection = inject(DetectionService)
  protected matcher = inject(MatcherService)
  protected store = inject(StoreService)
  protected readonly HYSTERESIS = HYSTERESIS
  @ViewChild('bars') barsRef!: ElementRef<HTMLCanvasElement>
  private raf = 0

  readonly armed = computed(() => this.store.gestures().filter((g) => g.enabled).length)

  // ---- Réglage de la sensibilité À MÊME le graphe ----
  //
  // Le trait de seuil EST le réglage. Un curseur séparé, plus bas, obligeait à
  // faire l'aller-retour entre la barre qu'on regarde et la commande qu'on
  // manipule, en tenant de tête la correspondance entre un pourcentage et une
  // position. Ici on attrape la chose elle-même.
  //
  // Le panneau « Sensibilité » est conservé, replié : il reste le seul chemin
  // accessible au clavier, qu'une toile ne peut pas offrir.

  /** Zones cliquables reconstruites à chaque tracé — la toile n'a pas de DOM. */
  private hit: { gestureId: string; auto: number; top: number; x: number }[] = []
  private readonly ROW = 66
  /** Tolérance de préhension autour du trait. */
  private readonly GRAB = 9

  protected hover = signal<string | null>(null)
  protected drag = signal<{ gestureId: string; auto: number } | null>(null)

  private rowAt(ev: MouseEvent): { gestureId: string; auto: number; x: number; near: boolean } | null {
    const canvas = this.barsRef?.nativeElement
    if (!canvas) return null
    const r = canvas.getBoundingClientRect()
    const x = ev.clientX - r.left
    const y = ev.clientY - r.top
    const row = this.hit.find((h) => y >= h.top && y < h.top + this.ROW)
    if (!row) return null
    return { gestureId: row.gestureId, auto: row.auto, x, near: Math.abs(x - row.x) <= this.GRAB }
  }

  onBarsMove(ev: MouseEvent): void {
    const d = this.drag()
    if (d) {
      // Le x se lit sur la toile, PAS via rowAt : sortir de la ligne
      // verticalement pendant qu'on glisse est normal, et ça ne doit pas
      // renvoyer « aucune ligne » donc x = 0, donc sensibilité au minimum.
      const rect = this.barsRef!.nativeElement.getBoundingClientRect()
      const x = ev.clientX - rect.left
      // Position → sensibilité, bornée à la même plage que l'ancien curseur.
      const sens = Math.min(3, Math.max(0.4, (x / Math.max(1, rect.width)) * 3))
      // En mémoire seulement pendant le glissement : écrire sur le disque à
      // chaque pixel ferait des centaines d'écritures par réglage.
      this.store.setSensitivityLocal(d.gestureId, sens)
      return
    }
    const r = this.rowAt(ev)
    this.hover.set(r?.near ? r.gestureId : null)
  }

  onBarsDown(ev: MouseEvent): void {
    const r = this.rowAt(ev)
    if (!r?.near) return
    ev.preventDefault()
    this.drag.set({ gestureId: r.gestureId, auto: r.auto })
  }

  /** Fin de geste : c'est là, et seulement là, qu'on écrit. */
  onBarsUp(): void {
    const d = this.drag()
    if (!d) return
    this.drag.set(null)
    void this.store.persistGesture(d.gestureId)
  }

  /** Double-clic sur la poignée : retour au seuil calculé par le wizard. */
  onBarsDbl(ev: MouseEvent): void {
    const r = this.rowAt(ev)
    if (!r?.near) return
    this.store.setSensitivityLocal(r.gestureId, 1)
    void this.store.persistGesture(r.gestureId)
  }





  readonly flash = signal(false)
  private lastLogged = 0

  label(kind: 'fire' | 'release' | 'error'): string {
    if (kind === 'fire') return 'affiché'
    return kind === 'release' ? 'retiré' : 'action en échec'
  }

  constructor() {
    effect(() => {
      const top = this.matcher.triggerLog()[0]
      if (!top || top.kind !== 'fire' || top.ts === this.lastLogged) return
      this.lastLogged = top.ts
      this.flash.set(true)
      setTimeout(() => this.flash.set(false), 450)
    })
  }

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
    const r = Math.min(h / 2, w / 2)
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
    const canvas = this.barsRef?.nativeElement
    if (!canvas) return
    const snaps = this.matcher.lastSnapshots
    const ROW = this.ROW // une seule source : le tracé et la préhension doivent
    const BAR_H = 12 //     s'accorder au pixel près, sinon on clique à côté
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

    const ink = this.token('--ink')
    const ink2 = this.token('--ink-2')
    const ink3 = this.token('--ink-3')
    const track = this.token('--void')
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

    // Échelle PAR LIGNE, fondée sur le seuil AUTO de la gesture.
    //
    // Trois exigences qui semblaient s'exclure :
    //   1. le trait de seuil ne doit pas bouger tout seul ;
    //   2. il doit bouger quand on règle la sensibilité — c'est CE qu'on règle ;
    //   3. on doit pouvoir l'attraper à la souris.
    //
    // La faute d'origine n'était pas « échelle absolue » mais « échelle PARTAGÉE
    // et recalculée à chaque frame sur les distances vivantes » : une pose qui
    // s'éloignait faisait glisser les traits de toutes les autres. En prenant
    // `thresholdAuto × SPAN` comme pleine largeur, l'échelle ne dépend plus
    // d'aucune mesure — `thresholdAuto` ne change qu'au réenregistrement.
    //
    // Le trait tombe alors en `sensibilité / SPAN` de la largeur : il ne dépend
    // QUE de la sensibilité. Conséquence heureuse — toutes les gestures laissées
    // en automatique (sensibilité = 1) alignent leur trait au tiers, ce qui
    // reconstitue la colonne de référence, et seules celles qu'on a retouchées
    // s'en écartent visiblement.
    const SPAN = 3 // pleine largeur = 3 × seuil auto, couvre la plage 0,4–3
    // Reconstruites à chaque tracé : une gesture supprimée ne doit pas laisser
    // derrière elle une zone cliquable qui règle un fantôme.
    this.hit = []
    const autoOf = (id: string) => {
      const g = this.store.gestures().find((x) => x.id === id)
      return g ? (g.thresholdAuto ?? g.threshold) : null
    }

    snaps.forEach((s, i) => {
      const y = i * ROW + 8
      const color = this.stateColor(s.state)
      const active = s.state === 'ACTIVE'

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

      // Pleine largeur = seuil auto × SPAN. Sans seuil auto connu (gesture tout
      // juste supprimée), on retombe sur le seuil effectif : jamais de division
      // par zéro, jamais de barre qui disparaît.
      const auto = autoOf(s.gestureId) ?? s.threshold ?? 1
      const full = (auto || 1) * SPAN
      const T_X = Math.min(cssW - 2, (s.threshold / full) * cssW)
      this.hit[i] = { gestureId: s.gestureId, auto: auto || 1, top: y, x: T_X }

      const barY = y + 18
      ctx.fillStyle = track
      this.bar(ctx, 0, barY, cssW, BAR_H)
      if (s.dist !== null) {
        const w = Math.max(3, Math.min(cssW, (s.dist / full) * cssW))
        // Une gesture qui déclenche mérite d'être vue du coin de l'œil :
        // c'est le seul moment où la toile s'autorise une lueur.
        if (active) {
          ctx.shadowColor = color
          ctx.shadowBlur = 14
        }
        const grad = ctx.createLinearGradient(0, 0, w, 0)
        grad.addColorStop(0, color + 'bb')
        grad.addColorStop(1, color)
        ctx.fillStyle = grad
        this.bar(ctx, 0, barY, w, BAR_H)
        ctx.shadowBlur = 0
      }

      // Poignée de seuil. Elle ne bouge que si on la bouge — ou si on
      // réenregistre la pose. Épaissie au survol pour dire qu'elle s'attrape.
      const grabbed = this.drag()?.gestureId === s.gestureId
      const hot = grabbed || this.hover() === s.gestureId
      ctx.fillStyle = hot ? color : ink2
      ctx.fillRect(T_X - (hot ? 1 : 0), barY - 7, hot ? 3 : 1.5, BAR_H + 14)
      ctx.strokeStyle = ink3
      ctx.lineWidth = 1
      ctx.setLineDash([2, 3])
      ctx.beginPath()
      const hx = Math.min(cssW - 1, T_X * HYSTERESIS)
      ctx.moveTo(hx, barY - 4)
      ctx.lineTo(hx, barY + BAR_H + 4)
      ctx.stroke()
      ctx.setLineDash([])

      // Pendant le glissement : le pourcentage et le seuil obtenu, au-dessus du
      // curseur. C'est le chiffre qu'affichait l'ancien curseur, rendu là où
      // l'œil est déjà.
      if (grabbed) {
        const sens = s.threshold / (auto || 1)
        const label = `${(sens * 100).toFixed(0)}%  ·  ${s.threshold.toFixed(3)}`
        ctx.font = dataFont
        const tw = ctx.measureText(label).width + 14
        const bx = Math.max(0, Math.min(cssW - tw, T_X - tw / 2))
        ctx.fillStyle = panel
        this.bar(ctx, bx, barY - 30, tw, 20)
        ctx.fillStyle = ink
        ctx.textAlign = 'center'
        ctx.fillText(label, bx + tw / 2, barY - 16)
        ctx.textAlign = 'left'
      }

      // Détail par partie. Comparer un bloc seul au seuil est une heuristique
      // (le seuil porte sur la moyenne) mais c'est ce qui se lit le mieux :
      // « cette partie à elle seule dépasse le budget total ».
      let x = 0
      const chipY = barY + BAR_H + 9
      ctx.font = dataFont
      for (const b of s.blocks ?? []) {
        const label = this.blockLabel(b)
        const text = b.dist === null ? `${label} —` : `${label} ${b.dist.toFixed(2)}`
        const w = ctx.measureText(text).width + 15
        if (x + w > cssW) break // jamais de débordement
        const over = b.dist !== null && b.dist > s.threshold
        const hue =
          b.dist === null
            ? this.token('--st-idle')
            : over
              ? this.token('--st-live')
              : this.token('--st-armed')
        ctx.fillStyle = panel
        this.bar(ctx, x, chipY, w, 18)
        ctx.fillStyle = hue
        ctx.fillRect(x, chipY + 4, 2, 10) // liseré : l'état se lit aussi à la forme
        ctx.fillStyle = b.dist === null ? ink3 : ink2
        ctx.fillText(text, x + 10, chipY + 12.5)
        x += w + 5 // écart de surface entre pastilles
      }
    })
  }
}
