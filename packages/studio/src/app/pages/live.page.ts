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
import { RangeFill } from '../range-fill'
import { DetectionService } from '../services/detection.service'
import { MatcherService } from '../services/matcher.service'
import { StoreService, effectiveThreshold, type StoredGesture } from '../services/store.service'

/**
 * Écran Live : ce qu'on regarde pendant qu'on stream.
 * Les barres de distance sont en canvas, PAS en DOM — elles se redessinent à
 * 30 Hz et feraient tourner la change detection sur chaque frame.
 * Les curseurs de sensibilité restent en DOM : ils ne bougent qu'à la main.
 */
@Component({
  selector: 'app-live-page',
  imports: [CameraView, Icon, RangeFill],
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
              gradué par seuil · trait plein = seuil · pointillé = relâche (×{{ HYSTERESIS }})
            </span>
          </div>
          <canvas #bars></canvas>
        </div>

        <!-- Repliable, et replié par défaut : régler la sensibilité est une
             activité de préparation, pas de direct. Déplié, ce panneau fait la
             hauteur du nombre de poses et repousse tout le reste hors écran. -->
        <div class="card">
          <button class="cardhead fold" (click)="toggleSens()" [attr.aria-expanded]="sensOpen()">
            <h2>Sensibilité</h2>
            <span class="cnt num">{{ store.gestures().length }}</span>
            <span class="spacer"></span>
            @if (tuned(); as n) {
              <span class="badge" [title]="n + ' pose(s) réglée(s) à la main'">{{ n }} réglée(s)</span>
            }
            <app-icon [name]="sensOpen() ? 'up' : 'down'" [size]="16" />
          </button>

          @if (sensOpen()) {
          <p class="lbl hint">
            Vers la droite, la pose déclenche plus facilement — et les faux positifs
            arrivent plus vite. Prends la pose, regarde où s'arrête la barre, puis
            amène le seuil juste au-delà.
          </p>
          @if (store.gestures().length > 6) {
            <div class="filter">
              <app-icon name="target" [size]="14" />
              <input
                [value]="q()"
                (input)="q.set($any($event.target).value)"
                placeholder="Filtrer les poses…"
                aria-label="Filtrer les poses"
              />
              @if (q()) {
                <button class="ghost sm" (click)="q.set('')" aria-label="Effacer">
                  <app-icon name="close" [size]="13" />
                </button>
              }
            </div>
          }
          @if (!store.gestures().length) {
            <p class="empty">Aucune gesture enregistrée pour l'instant.</p>
          }
          <!-- Les deux familles sont groupées, pas mélangées — mais les maillons
               restent ici : c'est la seule surface où l'on règle une pose en la
               regardant réagir, et une macro qui ne part pas se diagnostique
               exactement comme une gesture. -->
          <div class="sens">
            @for (grp of groups(); track grp.key) {
              @if (grp.rows.length) {
                @if (showGroupTitles() && !q()) {
                  <p class="grp lbl">{{ grp.title }}</p>
                }
                @for (g of grp.rows; track g.id) {
                  <div class="sensrow">
                    <span class="nm" [title]="g.name">{{ g.name }}</span>
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
                    <button
                      class="ghost sm"
                      (click)="resetSens(g)"
                      [disabled]="(g.sensitivity ?? 1) === 1"
                    >
                      Auto
                    </button>
                  </div>
                }
              }
            }
          </div>
          }
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

    /* En-tête cliquable : toute la ligne est la cible, pas seulement la flèche. */
    .fold {
      display: flex; align-items: center; gap: 9px; width: 100%;
      background: none; border: none; padding: 0; text-align: left;
    }
    .fold h2 { margin: 0; }
    .fold app-icon { color: var(--ink-3); }
    .fold:hover app-icon { color: var(--ink); }
    .cnt {
      padding: 1px 7px; border-radius: 99px;
      background: var(--panel-3); color: var(--ink-2); font-size: 10.5px;
    }

    .filter {
      display: flex; align-items: center; gap: 8px;
      padding: 5px 10px; margin-bottom: 8px;
      border-radius: var(--r-control);
      background: var(--void); border: 1px solid var(--line-soft);
    }
    .filter app-icon { color: var(--ink-3); }
    .filter input {
      flex: 1; min-width: 0; background: none; border-color: transparent;
      padding: 3px 2px; font-size: 12.5px;
    }

    /* Plafond de hauteur : le panneau défile en interne au lieu de repousser
       le reste de la page hors de l'écran. */
    .sens {
      display: flex; flex-direction: column; gap: 2px;
      max-height: 46vh; overflow-y: auto;
      margin-right: -6px; padding-right: 6px;
    }
    .grp {
      margin: 10px 0 3px; padding: 0 9px;
      border-top: 1px solid var(--line-soft); padding-top: 10px;
    }
    .grp:first-child { margin-top: 0; border-top: 0; padding-top: 0; }
    .sensrow {
      display: flex; align-items: center; gap: 12px;
      padding: 6px 9px; border-radius: var(--r-control);
      transition: background 140ms var(--ease);
    }
    .sensrow:hover { background: #ffffff07; }
    .sensrow .nm {
      flex: 0 0 122px; font-size: 13px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .sensrow input[type='range'] { flex: 1; min-width: 80px; }
    .sensrow .pct { flex: 0 0 40px; text-align: right; font-size: 12px; }
    .sensrow .thr { flex: 0 0 46px; text-align: right; font-size: 12px; color: var(--ink-3); }
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

  /** Filtre du panneau de sensibilité. */
  q = signal('')

  /** Panneau replié par défaut. L'état survit à la navigation : quelqu'un en
   *  train de régler ses poses ne doit pas le rouvrir à chaque aller-retour.
   *  localStorage et pas le store : c'est une préférence d'affichage, pas une
   *  donnée du profil, et elle n'a rien à faire dans db.json. */
  sensOpen = signal(localStorage.getItem('m4m.sens') === '1')

  toggleSens(): void {
    this.sensOpen.update((v) => !v)
    localStorage.setItem('m4m.sens', this.sensOpen() ? '1' : '0')
  }

  /** Poses réglées à la main — ce qui mérite d'être signalé panneau fermé :
   *  un seuil bidouillé et oublié explique beaucoup de comportements bizarres. */
  readonly tuned = computed(
    () => this.store.gestures().filter((g) => (g.sensitivity ?? 1) !== 1).length || null,
  )

  private match(g: StoredGesture): boolean {
    const needle = this.q().trim().toLowerCase()
    return !needle || g.name.toLowerCase().includes(needle)
  }

  /** Poses à meme et maillons de macro, groupés et jamais entrelacés. */
  readonly groups = computed(() => [
    { key: 'meme', title: 'Poses à meme', rows: this.store.memeGestures().filter((g) => this.match(g)) },
    { key: 'link', title: 'Maillons de macro', rows: this.store.linkGestures().filter((g) => this.match(g)) },
  ])

  /** Les titres n'apparaissent que s'il y a bien deux familles à distinguer :
   *  sur un profil sans macro, « Poses à meme » ne dirait rien à personne. */
  readonly showGroupTitles = computed(() => this.store.linkGestures().length > 0)
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
    const ROW = 66
    const BAR_H = 12
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

    // Chaque ligne est graduée en MULTIPLES DE SON PROPRE SEUIL, pas en
    // distance absolue. Le trait de seuil tombe donc toujours au même x, sur
    // toutes les lignes : il forme une colonne fixe, et la seule question qui
    // compte — « ma barre a-t-elle passé le trait ? » — se lit d'un coup d'œil.
    //
    // L'échelle commune adaptative d'avant recalculait le facteur à partir de
    // la plus grande distance affichée : dès qu'une pose s'éloignait, TOUS les
    // traits de seuil glissaient à l'écran alors qu'aucune valeur n'avait
    // changé. Une référence qui bouge n'est pas une référence.
    //
    // Ce qu'on perd : comparer deux distances absolues entre lignes. Ça n'avait
    // aucun sens, chaque gesture ayant son propre seuil.
    const T_X = cssW * 0.42 // ratio 1.0 — le seuil
    const MAX_RATIO = cssW / T_X

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

      const barY = y + 18
      ctx.fillStyle = track
      this.bar(ctx, 0, barY, cssW, BAR_H)
      if (s.dist !== null) {
        const ratio = Math.min(MAX_RATIO, s.dist / (s.threshold || 1))
        const w = Math.max(3, ratio * T_X)
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

      // Repères FIXES : seuil (plein) et sortie d'hystérésis (pointillé).
      // Leur position ne dépend plus d'aucune valeur mesurée.
      ctx.fillStyle = ink2
      ctx.fillRect(T_X, barY - 4, 1.5, BAR_H + 8)
      ctx.strokeStyle = ink3
      ctx.lineWidth = 1
      ctx.setLineDash([2, 3])
      ctx.beginPath()
      const hx = Math.min(cssW - 1, T_X * HYSTERESIS)
      ctx.moveTo(hx, barY - 4)
      ctx.lineTo(hx, barY + BAR_H + 4)
      ctx.stroke()
      ctx.setLineDash([])

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
