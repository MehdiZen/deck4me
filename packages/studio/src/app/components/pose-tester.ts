import {
  Component,
  EventEmitter,
  Input,
  OnDestroy,
  OnInit,
  Output,
  computed,
  inject,
  signal,
} from '@angular/core'
import type { BlockDiag } from '@deck4me/core'
import { DetectionService } from '../services/detection.service'
import { MatcherService } from '../services/matcher.service'
import { StoreService, type StoredGesture } from '../services/store.service'
import { CameraView } from './camera-view'
import { Icon } from './icon'

/**
 * Testeur de pose : « pourquoi ça ne part pas ? », répondu par un chiffre.
 *
 * ─── Ce qu'il remplace ──────────────────────────────────────────────────────
 * Jusqu'ici, comprendre l'échec d'une pose demandait de lire les pastilles de
 * l'écran Live en direct, tout en tenant la pose, en sachant déjà ce que
 * chaque bloc veut dire. Autant dire : à deux, avec quelqu'un qui connaît le
 * code. Ici on tient la pose cinq secondes et l'application raconte.
 *
 * ─── Il ne mesure rien de nouveau ───────────────────────────────────────────
 * Tout vient de `matcher.lastSnapshots`, qui porte déjà pour CHAQUE gesture sa
 * distance, son seuil, son état et le détail par bloc. Le testeur accumule et
 * conclut, il ne calcule pas.
 *
 * ─── Les deux questions sont distinctes ─────────────────────────────────────
 * « Est-ce que ma pose est reconnue ? » et « est-ce qu'elle déclenche ? » ne
 * sont PAS la même question, et c'est là que le testeur gagne sa place :
 *
 *  · la reconnaissance se lit sur la distance contre le seuil ;
 *  · le déclenchement passe en plus par l'exclusivité (seule la pose la plus
 *    proche progresse) et par `framesToTrigger` (il faut tenir plusieurs
 *    frames d'affilée).
 *
 * Une pose peut donc être parfaitement reconnue et ne jamais partir, parce
 * qu'une AUTRE est encore plus proche et rafle la mise à chaque frame. Ce cas
 * est indétectable à l'œil et le testeur le nomme.
 */

const DURATION_MS = 5000
/** Au-dessus, la pose est tenue pour fiable. En dessous de la moitié, elle est
 *  déclarée en échec ; entre les deux, elle est « juste ». */
const GOOD = 0.8
const POOR = 0.5

interface BlockStat {
  label: string
  sum: number
  max: number
  n: number
}

@Component({
  selector: 'app-pose-tester',
  imports: [CameraView, Icon],
  template: `
    <div class="modal-bg" (click)="close.emit()">
      <div class="modal" (click)="$event.stopPropagation()">
        <h2>Tester « {{ gesture.name }} »</h2>

        <app-camera-view />

        @switch (step()) {
          @case ('aim') {
            <p class="hint">
              Prends la pose comme tu la ferais en live, puis lance le test. Cinq
              secondes suffisent — inutile de figer, tiens-la normalement.
            </p>
            <p style="display:flex; gap:8px; justify-content:flex-end">
              <button (click)="close.emit()">Fermer</button>
              <button class="primary" [disabled]="!detection.running()" (click)="start()">
                <app-icon name="target" [size]="15" /> Lancer le test
              </button>
            </p>
          }

          @case ('run') {
            <!-- Une barre plutôt qu'un compte à rebours chiffré : on tient une
                 pose, on ne doit pas avoir à lire. -->
            <div class="track"><i [style.width.%]="progress()"></i></div>
            <p class="hint">Tiens la pose…</p>
          }

          @case ('done') {
            @if (!measured()) {
              <p class="badge err verdict">
                Aucune mesure sur cinq secondes. Le bloc dont cette pose a besoin
                n'était jamais visible — main hors du champ, ou visage perdu.
                Recadre-toi et recommence.
              </p>
            } @else {
              <ul>
                <li>
                  Frames sous le seuil :
                  <b class="num">{{ (rate() * 100).toFixed(0) }}%</b>
                  <span class="lbl">({{ fired() }} / {{ measured() }})</span>
                </li>
                <li>
                  Distance la meilleure : <span class="num">{{ best().toFixed(3) }}</span>
                  · moyenne <span class="num">{{ mean().toFixed(3) }}</span>
                  · seuil <b class="num">{{ threshold().toFixed(3) }}</b>
                </li>
                @if (missing()) {
                  <li class="lbl">
                    {{ missing() }} frame(s) sans mesure — bloc requis absent.
                  </li>
                }
                <li>
                  A réellement déclenché :
                  <b [class.ok]="triggered()">{{ triggered() ? 'oui' : 'non' }}</b>
                </li>
              </ul>

              @if (rate() >= GOOD) {
                <p class="badge ok verdict">
                  Pose fiable. Elle passe le seuil sur la quasi-totalité des frames.
                </p>
              } @else {
                <p class="badge warn verdict">{{ diagnosis() }}</p>
              }

              <!-- Le voleur : la pose qui a gagné l'exclusivité à notre place.
                   C'est LE cas qu'on ne peut pas voir autrement. -->
              @if (thief(); as t) {
                <p class="badge err verdict">
                  « {{ t.name }} » était plus proche que la tienne sur
                  <b class="num">{{ ((t.wins / measured()) * 100).toFixed(0) }}%</b>
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
                  <span class="chip" [class.over]="b.sum / b.n > threshold()">
                    {{ b.label }}
                    <span class="num">{{ (b.sum / b.n).toFixed(3) }}</span>
                  </span>
                }
              </div>
            }

            <p style="display:flex; gap:8px; justify-content:flex-end">
              <button (click)="close.emit()">Fermer</button>
              <button class="primary" (click)="start()">Refaire</button>
            </p>
          }
        }
      </div>
    </div>
  `,
  styles: `
    .modal-bg {
      position: fixed; inset: 0; z-index: 50;
      background: #000000b8;
      display: flex; align-items: center; justify-content: center;
      padding: 24px;
    }
    .modal {
      width: min(560px, 100%);
      max-height: 90vh; overflow-y: auto;
      background: var(--panel); border: 1px solid var(--line);
      border-radius: var(--r-panel); padding: 20px;
      box-shadow: var(--edge), 0 30px 80px #000000a0;
    }
    .modal h2 { margin: 0 0 14px; font-size: 17px; }
    app-camera-view { display: block; margin-bottom: 14px; border-radius: 10px; overflow: hidden; }
    .hint { color: var(--ink-3); font-size: 13px; line-height: 1.55; margin: 12px 0; }
    ul { margin: 12px 0; padding: 0; list-style: none; font-size: 13px; line-height: 1.9; }
    .verdict { display: block; padding: 11px 13px; line-height: 1.55; white-space: normal; margin: 12px 0; }
    .ok { color: var(--st-armed); }
    /* Barre de progression : la seule animation de l'écran, et elle dit la
       seule chose qu'on ait besoin de savoir pendant qu'on tient la pose. */
    .track {
      height: 6px; border-radius: 3px; overflow: hidden;
      background: var(--void); margin: 16px 0 8px;
    }
    .track i { display: block; height: 100%; background: var(--st-armed); }
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
  protected readonly GOOD = GOOD

  protected step = signal<'aim' | 'run' | 'done'>('aim')
  protected progress = signal(0)

  protected measured = signal(0)
  protected missing = signal(0)
  protected fired = signal(0)
  protected best = signal(0)
  protected mean = signal(0)
  protected threshold = signal(0)
  protected triggered = signal(false)
  protected blocks = signal<BlockStat[]>([])
  /** La gesture qui a raflé l'exclusivité à notre place, si elle l'a fait
   *  souvent. En dessous d'un tiers des frames, ce n'est pas elle le problème. */
  protected thief = signal<{ name: string; wins: number } | null>(null)

  protected rate = computed(() => (this.measured() ? this.fired() / this.measured() : 0))

  private raf = 0

  ngOnInit(): void {
    // La caméra est indispensable ici : sans elle il n'y a rien à mesurer, et un
    // testeur qui affiche « aucune mesure » parce que personne n'a démarré la
    // détection serait une fausse panne de plus.
    if (!this.detection.running()) void this.detection.start()
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.raf)
  }

  start(): void {
    cancelAnimationFrame(this.raf)
    this.step.set('run')
    this.progress.set(0)

    let measured = 0
    let missing = 0
    let fired = 0
    let best = Infinity
    let sum = 0
    let triggered = false
    let threshold = 0
    const blocks = new Map<string, BlockStat>()
    const wins = new Map<string, number>()
    const t0 = performance.now()

    const tick = () => {
      const dt = performance.now() - t0
      this.progress.set(Math.min(100, (dt / DURATION_MS) * 100))

      const snaps = this.matcher.lastSnapshots
      const mine = snaps.find((s) => s.gestureId === this.gesture.id)
      if (mine) {
        threshold = mine.threshold
        if (mine.dist === null) {
          missing++
        } else {
          measured++
          sum += mine.dist
          if (mine.dist < best) best = mine.dist
          if (mine.dist <= mine.threshold) fired++
          // L'état vient de la vraie machine à états : c'est la seule preuve
          // que la pose a franchi TOUT le chemin, exclusivité et frames
          // consécutives comprises.
          if (mine.state === 'ACTIVE') triggered = true
          for (const b of mine.blocks ?? []) {
            if (b.dist === null) continue
            const label = this.blockLabel(b)
            const cur = blocks.get(label) ?? { label, sum: 0, max: 0, n: 0 }
            cur.sum += b.dist
            cur.n++
            if (b.dist > cur.max) cur.max = b.dist
            blocks.set(label, cur)
          }
          // Qui était le plus proche sur cette frame ? Si ce n'est pas nous,
          // c'est cette gesture-là qui empêche la nôtre de progresser.
          let winner: string | null = null
          let bestDist = Infinity
          for (const s of snaps) {
            if (s.dist !== null && s.dist < bestDist) {
              bestDist = s.dist
              winner = s.gestureId
            }
          }
          if (winner && winner !== this.gesture.id) {
            wins.set(winner, (wins.get(winner) ?? 0) + 1)
          }
        }
      }

      if (dt >= DURATION_MS) {
        this.measured.set(measured)
        this.missing.set(missing)
        this.fired.set(fired)
        this.best.set(best === Infinity ? 0 : best)
        this.mean.set(measured ? sum / measured : 0)
        this.threshold.set(threshold || this.gesture.threshold)
        this.triggered.set(triggered)
        this.blocks.set([...blocks.values()])
        this.thief.set(this.worstRival(wins, measured))
        this.step.set('done')
        return
      }
      this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
  }

  /** La rivale la plus gênante, si elle l'est assez pour valoir d'être nommée. */
  private worstRival(wins: Map<string, number>, measured: number): { name: string; wins: number } | null {
    let id: string | null = null
    let n = 0
    for (const [k, v] of wins) if (v > n) ((n = v), (id = k))
    if (!id || !measured || n / measured < 1 / 3) return null
    const g = this.store.allGestures().find((x) => x.id === id)
    const m = this.store.macros().find((x) => x.id === id)
    return { name: g?.name ?? m?.name ?? '—', wins: n }
  }

  /** Le bloc qui coûte le plus cher, nommé avec son chiffre contre son budget.
   *  Nommer sans chiffrer ne servirait à rien : « c'est la main » ne dit pas
   *  s'il manque un cheveu ou un monde. */
  protected diagnosis(): string {
    const t = this.threshold()
    const worst = this.blocks().reduce<BlockStat | null>(
      (acc, b) => (!acc || b.sum / b.n > acc.sum / acc.n ? b : acc),
      null,
    )
    const part = this.rate() < POOR ? 'ne passe presque jamais' : 'passe une fois sur deux'
    if (!worst) return `La pose ${part} le seuil.`
    return (
      `La pose ${part} le seuil. C'est « ${worst.label} » qui coûte le plus cher : ` +
      `${(worst.sum / worst.n).toFixed(3)} en moyenne pour un budget total de ${t.toFixed(3)}. ` +
      `Soit tu exagères davantage cette partie de la pose, soit tu la réenregistres, ` +
      `soit tu élargis son seuil dans l'écran Live.`
    )
  }

  /** « main G » = ta main gauche : le flux n'est pas mirroré, la handedness
   *  MediaPipe est donc anatomique. */
  private blockLabel(b: BlockDiag): string {
    if (b.kind === 'face') return 'visage'
    const side = b.slot === 0 ? 'G' : 'D'
    return b.kind === 'hand' ? `main ${side}` : `pos ${side}`
  }
}
