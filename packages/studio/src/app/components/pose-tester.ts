import {
  Component,
  EventEmitter,
  Input,
  OnDestroy,
  OnInit,
  Output,
  inject,
  signal,
} from '@angular/core'
import {
  advise,
  frameDistance,
  type Advice,
  type BlockDiag,
  type FeatureBlocks,
} from '@deck4me/core'
import { DetectionService } from '../services/detection.service'
import { MatcherService } from '../services/matcher.service'
import { StoreService, type StoredGesture } from '../services/store.service'
import { CameraView } from './camera-view'
import { Icon } from './icon'

/**
 * Mesure en continu si une pose est reconnue, et dit ce qu'il reste à corriger.
 *
 * N'établit aucune mesure propre : tout vient de `matcher.lastSnapshots` et
 * `matcher.lastBlocks`. Ce composant accumule et raconte.
 *
 * Il sépare deux questions qu'on confond à l'œil. Être reconnue, c'est passer
 * sous son seuil. Déclencher, c'est en plus être la plus proche de toutes
 * (le matcher est en winner-take-all) et le rester `framesToTrigger` images.
 * Une pose peut donc être parfaitement reconnue et ne jamais partir ; le
 * testeur nomme alors la rivale.
 */

/** Fenêtre glissante des statistiques. Deux secondes : assez pour lisser le
 *  tremblement d'une main, assez court pour qu'une correction se voie. */
const WINDOW_MS = 2000
/** Cadence de rafraîchissement des chiffres affichés. Au-delà, on ferait
 *  tourner la détection de changement d'Angular pour des décimales que l'œil ne
 *  suit pas. */
const REFRESH_MS = 150
/** Cadence de renouvellement des consignes. Nettement plus lent : une phrase
 *  qui change pendant qu'on la lit ne se lit pas. */
const ADVICE_MS = 900

interface Tick {
  t: number
  /** null = bloc requis absent de la frame (main hors champ, visage perdu). */
  dist: number | null
  fired: boolean
  active: boolean
  blocks: BlockDiag[] | null
  /** La gesture la plus proche sur cette frame, si ce n'est pas la nôtre. */
  rival: string | null
}

interface BlockStat {
  label: string
  mean: number
}

@Component({
  selector: 'app-pose-tester',
  imports: [CameraView, Icon],
  template: `
    <div class="modal-bg" (click)="close.emit()">
      <div class="modal" (click)="$event.stopPropagation()">
        <header>
          <h2>Tester « {{ gesture.name }} »</h2>
          <span class="spacer"></span>
          <button class="ghost sm" (click)="close.emit()">
            <app-icon name="close" [size]="15" /> Fermer
          </button>
        </header>

        <app-camera-view />

        @if (!detection.running()) {
          <p class="hint">Démarrage de la caméra…</p>
        } @else if (!measured()) {
          <p class="badge err verdict">
            Rien à mesurer : le bloc dont cette pose a besoin n'est pas visible.
            Main hors du champ, ou visage perdu.
          </p>
        } @else {
          <!-- La jauge est le cœur de l'écran : c'est elle qu'on regarde en se
               corrigeant, pas les décimales. -->
          <div class="gauge">
            <div class="track">
              <i [style.width.%]="rate() * 100" [class.good]="rate() >= GOOD"></i>
            </div>
            <div class="read">
              <b class="num big" [class.ok]="rate() >= GOOD">{{ (rate() * 100).toFixed(0) }}%</b>
              <span class="lbl">reconnue · 2 dernières secondes</span>
              <span class="spacer"></span>
              @if (active()) {
                <span class="badge ok">déclenchée</span>
              }
            </div>
          </div>

          <ul>
            <li>
              Distance <span class="num">{{ dist() === null ? '—' : dist()!.toFixed(3) }}</span>
              · meilleure <span class="num">{{ best().toFixed(3) }}</span>
              · seuil <b class="num">{{ threshold().toFixed(3) }}</b>
            </li>
            @if (missing()) {
              <li class="lbl">{{ missing() }} frame(s) sans mesure sur la fenêtre.</li>
            }
          </ul>

          <!-- Les consignes. C'est la seule partie de cet écran qui dise quoi
               FAIRE ; tout le reste dit où ça coince. -->
          @if (advice().length) {
            <div class="todo">
              <h3>Pour t'en rapprocher</h3>
              <ol>
                @for (a of advice(); track a.text) {
                  <li>{{ a.text }}</li>
                }
              </ol>
              <!-- Dire ce qu'on ne saura JAMAIS conseiller évite d'aller
                   corriger une chose qui n'entre pas dans le calcul. -->
              <p class="lbl note">
                Inutile de chercher du côté de l'angle de ta main ou de
                l'inclinaison de ta tête : ni l'un ni l'autre n'entre dans la
                comparaison.
              </p>
            </div>
          } @else if (rate() >= GOOD) {
            <p class="badge ok verdict">
              Pose fiable. Elle passe le seuil sur la quasi-totalité des frames.
            </p>
          }

          @if (thief(); as t) {
            <p class="badge err verdict">
              « {{ t.name }} » est plus proche que la tienne sur
              <b class="num">{{ (t.share * 100).toFixed(0) }}%</b>
              des frames. Tant qu'elle gagne, ta pose ne peut pas partir même
              reconnue : une seule gesture à la fois progresse, la plus proche.
              Différencie les deux, ou réduis la sensibilité de « {{ t.name }} ».
            </p>
          }

          <!-- Détail par bloc. Comparer un bloc seul au seuil est une
               heuristique — le seuil porte sur la MOYENNE des blocs — mais
               c'est ce qui se lit le mieux : « cette partie à elle seule
               dépasse le budget total ». -->
          <div class="blocks">
            @for (b of blocks(); track b.label) {
              <span class="chip" [class.over]="b.mean > threshold()">
                {{ b.label }}
                <span class="num">{{ b.mean.toFixed(3) }}</span>
              </span>
            }
          </div>
        }
      </div>
    </div>
  `,
  styles: `
    .modal {
      width: min(560px, 100%);
      max-height: 90vh; overflow-y: auto;
      background: var(--panel); border: 1px solid var(--line);
      border-radius: var(--r-panel); padding: 20px;
      box-shadow: var(--edge), 0 30px 80px #000000a0;
    }
    header { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
    header h2 { margin: 0; font-size: 17px; }
    app-camera-view { display: block; margin-bottom: 14px; border-radius: 10px; overflow: hidden; }
    .hint { color: var(--ink-3); font-size: 13px; line-height: 1.55; margin: 12px 0; }
    ul { margin: 12px 0; padding: 0; list-style: none; font-size: 13px; line-height: 1.9; }
    .verdict { display: block; padding: 11px 13px; line-height: 1.55; white-space: normal; margin: 12px 0; }
    .ok { color: var(--st-armed); }

    .gauge { margin: 14px 0 6px; }
    .track { height: 8px; border-radius: 4px; overflow: hidden; background: var(--void); }
    /* La barre change de couleur au franchissement du seuil de fiabilité :
       l'information passe par la forme ET par la teinte, elle se capte donc du
       coin de l'œil pendant qu'on tient la pose. */
    .track i {
      display: block; height: 100%; background: var(--st-candidate);
      transition: width 120ms linear, background 200ms ease;
    }
    .track i.good { background: var(--st-armed); }
    .read { display: flex; align-items: baseline; gap: 8px; margin-top: 7px; }
    .big { font-size: 19px; font-weight: 700; }

    .todo {
      margin: 14px 0;
      padding: 12px 14px;
      border-radius: 10px;
      background: var(--panel-2);
      border: 1px solid var(--line-soft);
    }
    .todo h3 { margin: 0 0 8px; font-size: 13px; }
    .todo ol { margin: 0; padding-left: 20px; font-size: 13.5px; line-height: 1.75; }
    .note { display: block; margin: 10px 0 0; text-transform: none; letter-spacing: 0; line-height: 1.5; }
    .blocks { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
    .chip {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 5px 10px; border-radius: 8px;
      background: var(--panel-2); border: 1px solid var(--line-soft);
      font-size: 12px; color: var(--ink-2);
    }
    .chip.over { border-color: #b4453f80; color: var(--st-live); }
  `,
})
export class PoseTester implements OnInit, OnDestroy {
  @Input({ required: true }) gesture!: StoredGesture
  @Output() close = new EventEmitter<void>()

  protected detection = inject(DetectionService)
  private matcher = inject(MatcherService)
  private store = inject(StoreService)
  protected readonly GOOD = 0.8

  protected measured = signal(0)
  protected missing = signal(0)
  protected rate = signal(0)
  protected dist = signal<number | null>(null)
  protected best = signal(0)
  protected threshold = signal(0)
  protected active = signal(false)
  protected blocks = signal<BlockStat[]>([])
  protected thief = signal<{ name: string; share: number } | null>(null)
  protected advice = signal<Advice[]>([])

  private raf = 0
  private ticks: Tick[] = []
  private lastRefresh = 0
  private lastAdvice = 0
  /** Meilleure tentative de l'intervalle de consigne en cours. Remise à zéro à
   *  chaque renouvellement : les consignes doivent décrire ce qu'on vient de
   *  faire, pas le meilleur essai depuis l'ouverture. */
  private bestFrame: FeatureBlocks | null = null
  private bestSample: FeatureBlocks | null = null
  private bestDist = Infinity

  ngOnInit(): void {
    // La caméra est indispensable ici : sans elle il n'y a rien à mesurer, et un
    // testeur qui affiche « aucune mesure » parce que personne n'a démarré la
    // détection serait une fausse panne de plus.
    if (!this.detection.running()) void this.detection.start()
    this.raf = requestAnimationFrame(() => this.tick())
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.raf)
  }

  /** Les samples re-featurisés avec la baseline courante — jamais le cache
   *  persisté, qui peut dater d'une autre calibration. */
  private samples(): FeatureBlocks[] {
    return this.store.runtimeGestures().find((g) => g.id === this.gesture.id)?.samples ?? []
  }

  private tick(): void {
    const now = performance.now()
    const snaps = this.matcher.lastSnapshots
    const mine = snaps.find((s) => s.gestureId === this.gesture.id)

    if (mine) {
      let rival: string | null = null
      let bd = Infinity
      for (const s of snaps) {
        if (s.dist !== null && s.dist < bd) {
          bd = s.dist
          rival = s.gestureId
        }
      }
      this.ticks.push({
        t: now,
        dist: mine.dist,
        fired: mine.dist !== null && mine.dist <= mine.threshold,
        active: mine.state === 'ACTIVE',
        blocks: mine.blocks,
        rival: rival === this.gesture.id ? null : rival,
      })
      // On retient la frame la plus proche de l'intervalle : c'est elle qui
      // décrira le mieux ce qu'il reste à corriger.
      const live = this.matcher.lastBlocks
      if (mine.dist !== null && mine.dist < this.bestDist && live) {
        let near: FeatureBlocks | null = null
        let nd = Infinity
        for (const s of this.samples()) {
          const d = frameDistance(s, live, this.gesture.source)
          if (d !== null && d < nd) {
            nd = d
            near = s
          }
        }
        if (near) {
          this.bestDist = mine.dist
          this.bestFrame = live
          this.bestSample = near
        }
      }
    }

    // Fenêtre glissante : tout ce qui a plus de deux secondes ne décrit plus la
    // pose qu'on est en train de tenir.
    const cut = now - WINDOW_MS
    while (this.ticks.length && this.ticks[0]!.t < cut) this.ticks.shift()

    if (now - this.lastRefresh >= REFRESH_MS) {
      this.lastRefresh = now
      this.publish(mine?.threshold ?? this.gesture.threshold)
    }
    if (now - this.lastAdvice >= ADVICE_MS) {
      this.lastAdvice = now
      this.advice.set(
        this.bestSample && this.bestFrame
          ? advise(this.bestSample, this.bestFrame, this.gesture.source)
          : [],
      )
      this.bestDist = Infinity
      this.bestFrame = null
      this.bestSample = null
    }

    this.raf = requestAnimationFrame(() => this.tick())
  }

  /** Recalcule tout depuis la fenêtre et pousse dans les signaux. */
  private publish(threshold: number): void {
    const withDist = this.ticks.filter((t) => t.dist !== null)
    const n = withDist.length
    this.measured.set(n)
    this.missing.set(this.ticks.length - n)
    this.threshold.set(threshold)
    const last = this.ticks[this.ticks.length - 1]
    this.dist.set(last?.dist ?? null)
    this.active.set(this.ticks.some((t) => t.active))
    if (!n) {
      this.rate.set(0)
      this.best.set(0)
      this.blocks.set([])
      this.thief.set(null)
      return
    }
    this.rate.set(withDist.filter((t) => t.fired).length / n)
    this.best.set(Math.min(...withDist.map((t) => t.dist!)))

    const acc = new Map<string, { sum: number; n: number }>()
    for (const t of withDist) {
      for (const b of t.blocks ?? []) {
        if (b.dist === null) continue
        const label = this.blockLabel(b)
        const cur = acc.get(label) ?? { sum: 0, n: 0 }
        cur.sum += b.dist
        cur.n++
        acc.set(label, cur)
      }
    }
    this.blocks.set([...acc].map(([label, v]) => ({ label, mean: v.sum / v.n })))

    const wins = new Map<string, number>()
    for (const t of withDist) if (t.rival) wins.set(t.rival, (wins.get(t.rival) ?? 0) + 1)
    let id: string | null = null
    let best = 0
    for (const [k, v] of wins) if (v > best) ((best = v), (id = k))
    // En dessous d'un tiers des frames, la rivale n'est pas le problème : la
    // nommer ferait chercher une collision là où il n'y a qu'une pose mal tenue.
    if (!id || best / n < 1 / 3) {
      this.thief.set(null)
      return
    }
    const g = this.store.allGestures().find((x) => x.id === id)
    this.thief.set({ name: g?.name ?? '—', share: best / n })
  }

  /** « main G » = ta main gauche : le flux n'est pas mirroré, la handedness
   *  MediaPipe est donc anatomique. */
  private blockLabel(b: BlockDiag): string {
    if (b.kind === 'face') return 'visage'
    const side = b.slot === 0 ? 'G' : 'D'
    return b.kind === 'hand' ? `main ${side}` : `pos ${side}`
  }
}
