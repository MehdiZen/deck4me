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
import { FormsModule } from '@angular/forms'
import {
  FEATURIZER_VERSION,
  MACRO_MAX_STEPS,
  MACRO_MIN_STEPS,
  blocksToJson,
  computeThreshold,
  featurizeRaw,
  filterOutlierIndices,
  type FeatureBlocks,
  type GestureSource,
  type HoldMode,
  type RawFrame,
  type ThresholdVerdict,
} from '@deck4me/core'
import { DetectionService } from '../services/detection.service'
import { StoreService, type StoredGesture } from '../services/store.service'
import { CameraView } from './camera-view'
import { Icon } from './icon'

type Step = 'config' | 'countdown' | 'capture' | 'between' | 'result'

/**
 * `gesture` — une pose ordinaire, qui affichera un meme.
 * `link`    — une pose destinée à un enchaînement existant : pas de mode
 *             « tenue » (un maillon se lit sur un déclenchement, pas sur une
 *             durée) et le faux positif ne l'inquiète pas.
 * `chain`   — plusieurs poses à la suite, plus la macro qui les relie.
 */
export type WizardMode = 'gesture' | 'link' | 'chain'

const TAKES = 3 // 3 prises séparées : la variance intra-classe d'une prise
const SAMPLES_PER_TAKE = 8 // unique est artificiellement basse → seuil irréaliste

/** Chiffres cerclés pour nommer les maillons — lisibles d'un coup d'œil dans la
 *  liste des gestures, où ils voisinent avec des noms libres. */
/** Temps de relâche entre deux prises, avant que la suivante s'arme d'elle-même.
 *  Il s'ajoute aux 3 s de décompte de la prise : 5,5 s en tout pour lâcher la
 *  pose, bouger, et la reprendre. */
const RELAX_MS = 2500

const CIRCLED = ['①', '②', '③', '④']

/** Identifiant provisoire d'un maillon pas encore écrit sur le disque. Il ne
 *  sort jamais du wizard : il ne sert qu'à nommer une collision détectée entre
 *  deux poses de la même session. */
const DRAFT_PREFIX = 'draft:'

/**
 * Maillon enregistré mais pas encore écrit sur le disque.
 *
 * Rien n'est persisté avant la fin de l'enchaînement : abandonner au maillon 2
 * ne doit pas laisser derrière une demi-macro et une gesture orpheline que
 * personne n'ira nettoyer.
 */
interface LinkDraft {
  name: string
  source: GestureSource
  keptRaw: RawFrame[]
  /** Featurisés — servent à détecter une collision avec les maillons SUIVANTS,
   *  qui ne sont pas encore dans le store. */
  kept: FeatureBlocks[]
  threshold: number
}

/** Wizard d'enregistrement. Le seuil est auto — le réglage manuel viendra en
 *  mode avancé, jamais en premier. */
@Component({
  selector: 'app-wizard',
  imports: [FormsModule, CameraView, Icon],
  template: `
    <div class="modal-bg">
      <div class="modal card">
        @switch (step()) {
          @case ('config') {
            <h2>{{ configTitle() }}</h2>
            @if (replacing) {
              <p class="keep">
                <app-icon name="check" [size]="15" />
                <span>
                  Le meme, son cadrage, son son et sa sensibilité sont conservés.
                  Seule la pose qui le déclenche est remplacée.
                </span>
              </p>
            }
            <p>
              <label class="lbl">{{ isChain ? "Nom de la macro" : 'Nom' }}</label><br />
              <input
                [(ngModel)]="name"
                [placeholder]="isChain ? 'ex. Changer de scène' : 'ex. Sourire forcé'"
                style="width:100%"
              />
            </p>

            @if (isChain) {
              <p>
                <label class="lbl">Nombre de poses à enchaîner</label><br />
                <span class="linkpick">
                  @for (n of LINK_CHOICES; track n) {
                    <button class="kbtn" [class.on]="links() === n" (click)="links.set(n)">
                      {{ n }} poses
                    </button>
                  }
                </span>
              </p>
            }

            <p>
              <label class="lbl">Source</label><br />
              <select [(ngModel)]="source">
                <option value="face">Visage</option>
                <option value="hand">Main(s)</option>
                <option value="both">Visage + main(s)</option>
              </select>
              <!-- Un maillon n'a pas de mode « tenue » : un enchaînement se lit
                   sur des déclenchements, pas sur une durée. -->
              @if (!isLink) {
                <select [(ngModel)]="holdMode" style="margin-left:8px">
                  <option value="fixed_duration">Durée fixe</option>
                  <option value="while_held">Tant que tenue</option>
                </select>
              }
            </p>

            @if (isChain) {
              <p class="keep">
                <app-icon name="check" [size]="15" />
                <span>
                  Les {{ links() }} poses seront enregistrées <b>à la suite</b>, 3 prises
                  chacune, puis marquées <b>« maillon seulement »</b> — elles
                  déclenchent la macro sans rien afficher toutes seules.
                  Elles s'appelleront « {{ chainName() }} {{ CIRCLED[0] }} »,
                  « {{ chainName() }} {{ CIRCLED[1] }} »… et restent renommables
                  ensuite dans Poses.
                </span>
              </p>
            }

            <p class="lbl">
              3 prises de 2 s. Entre chaque prise, relâche la pose puis reprends-la :
              c'est ce qui rend le seuil réaliste. Pose volontaire, exagérée, lisible caméra.
            </p>
            <p style="display:flex; gap:8px; justify-content:flex-end">
              <button (click)="cancel.emit()">Annuler</button>
              <button class="primary" [disabled]="!name.trim() || starting()" (click)="start()">
                {{ starting() ? 'Caméra…' : startLabel() }}
              </button>
            </p>
          }
          @case ('countdown') {
            <h2>{{ linkPrefix() }}Prise {{ take() + 1 }}/3 — prends la pose</h2>
            <app-camera-view />
            <div class="count">{{ countdown() }}</div>
          }
          @case ('capture') {
            <h2>{{ linkPrefix() }}Prise {{ take() + 1 }}/3 — TIENS la pose</h2>
            <app-camera-view />
            <div class="progress"><div [style.width.%]="captureProgress()"></div></div>
            @if (missing()) {
              <p class="badge err">{{ missing() }}</p>
            }
          }
          @case ('between') {
            <h2>{{ linkPrefix() }}Prise {{ take() }}/3 capturée</h2>
            <app-camera-view />
            <p>Relâche complètement la pose, bouge un peu, puis reprends-la.</p>
            <!-- Ça repart tout seul : un bouton ici obligerait à lâcher la
                 pose pour aller chercher la souris, ce qui est impossible sur
                 une pose à deux mains. -->
            <div class="progress auto"><div [style.width.%]="relaxProgress()"></div></div>
            <p class="lbl relax">
              Reprise automatique — le décompte de la prise {{ take() + 1 }} suit.
            </p>
            <p style="text-align:right">
              <button class="primary" (click)="beginTake()">Prise {{ take() + 1 }}/3 tout de suite</button>
            </p>
          }
          @case ('result') {
            <h2>{{ isChain ? linkPrefix() + 'analyse' : 'Analyse' }}</h2>
            @if (isChain && drafts().length) {
              <ol class="recap">
                @for (d of drafts(); track $index) {
                  <li><app-icon name="check" [size]="13" /> {{ d.name }}</li>
                }
              </ol>
            }
            @if (verdict(); as v) {
              <!-- Le verdict AVANT les chiffres.
                   L'ordre inverse était l'ordre de la lecture inversé : quatre
                   lignes de mesures d'abord, puis la seule phrase qu'on soit
                   venu chercher — « c'est bon ou pas ? ». Les mesures ne
                   disparaissent pas, elles attendent qu'on les demande. -->
              @switch (v.verdict) {
                @case ('collision') {
                  <!-- Avertissement, plus refus. Le détail de ce qui arrive
                       vraiment vaut mieux qu'un mur : le matcher désigne la
                       pose la plus proche, donc les deux ne partiront pas
                       ensemble — c'est LAQUELLE des deux qui devient
                       imprévisible. C'est un choix, pas une erreur. -->
                  <p class="badge warn verdict">
                    Trop proche de « {{ nameOf(v.collidesWith!) }} ». Les deux ne partiront pas
                    en même temps — c'est laquelle des deux qui part qui devient une loterie.
                    Différencie la pose, ou enregistre quand même et règle la sensibilité
                    des deux ensuite.
                  </p>
                }
                @case ('false_positive_risk') {
                  @if (isLink) {
                    <!-- Un faux positif sur un maillon isolé ne déclenche rien :
                         il faut la pose SUIVANTE dans la foulée. L'avertissement
                         qui fait sens pour une gesture seule serait ici un
                         mensonge par excès de prudence. -->
                    <p class="badge ok verdict">
                      Cette pose ressemble à ta tête en parlant normalement — sans
                      importance dans une macro : rien ne part tant que la
                      pose suivante n'arrive pas derrière.
                    </p>
                  } @else {
                    <p class="badge warn verdict">
                      Cette pose ressemble à ta tête en parlant normalement : risque de
                      déclenchement involontaire en live. Exagère-la davantage, ou assume.
                    </p>
                  }
                }
                @case ('ok') {
                  <p class="badge ok verdict">Pose propre, seuil fiable.</p>
                }
              }
              <details class="detail">
                <summary>Le détail des mesures</summary>
                <ul>
                  <li>Images retenues : {{ keptCount() }} / {{ TAKES * SAMPLES_PER_TAKE }}</li>
                  <li>
                    Écart entre tes 3 prises : {{ v.maxIntra.toFixed(3) }}
                    <span class="lbl">— plus c'est bas, plus tu refais la pose à l'identique</span>
                  </li>
                  <li>Seuil retenu : <b>{{ v.threshold.toFixed(3) }}</b></li>
                  @if (v.nearestOther; as n) {
                    <li>Pose la plus proche : « {{ nameOf(n.gestureId) }} » à {{ n.dist.toFixed(3) }}</li>
                  }
                  @if (v.nearestNegative !== null) {
                    <li>Ta tête en parlant normalement : {{ v.nearestNegative!.toFixed(3) }}</li>
                  }
                </ul>
              </details>
            }
            <p style="display:flex; gap:8px; justify-content:flex-end">
              <button (click)="retry()">Refaire les prises</button>
              <button (click)="cancel.emit()">Abandonner</button>
              @if (isChain && !lastLink()) {
                <button class="primary" (click)="nextLink()">
                  Maillon {{ link() + 2 }}/{{ links() }} ›
                </button>
              } @else {
                <button class="primary" (click)="save()">
                  {{ saveLabel() }}
                </button>
              }
            </p>
          }
        }
      </div>
    </div>
  `,
  styles: `
    .modal {
      width: 580px; max-height: 90vh; overflow-y: auto;
      border-radius: var(--r-big);
      box-shadow: var(--edge), 0 40px 90px -20px #000d;
      animation: pop 220ms var(--spring) both;
    }
    @keyframes pop { from { opacity: 0; transform: translateY(10px) scale(.985) } }
    .modal h2 { margin-bottom: 14px; font-size: 17px; }
    app-camera-view {
      display: block; border-radius: var(--r-control); overflow: hidden;
      border: 1px solid var(--line);
    }
    /* Compte à rebours : un relevé d'instrument, pas un titre.
       Il pulse à chaque seconde — sans ça, on ne sait pas s'il tourne. */
    .count {
      font-family: var(--font-data);
      font-variant-numeric: tabular-nums;
      font-size: 68px; font-weight: 600; line-height: 1.05;
      text-align: center; margin: 16px 0 4px;
      color: var(--accent-hi);
      text-shadow: 0 0 40px var(--accent-glow);
      animation: tickpulse 1s infinite var(--ease);
    }
    @keyframes tickpulse { 0% { transform: scale(1.14); opacity: .75 } 30%, 100% { transform: none; opacity: 1 } }
    .progress {
      height: 9px; background: var(--void); border-radius: 99px;
      margin: 16px 0; overflow: hidden; border: 1px solid var(--line-soft);
    }
    .progress > div {
      height: 100%; border-radius: 99px;
      background: linear-gradient(90deg, var(--accent-lo), var(--accent-hi));
      box-shadow: 0 0 16px var(--accent-glow);
      transition: width .1s linear;
    }
    ul { margin: 12px 0; padding: 0; list-style: none; font-size: 13px; }
    li {
      display: flex; align-items: baseline; gap: 10px;
      padding: 7px 0; border-bottom: 1px solid var(--line-soft);
    }
    li:last-child { border-bottom: 0; }
    li b { font-family: var(--font-data); font-variant-numeric: tabular-nums; }
    .verdict { display: block; padding: 11px 13px; line-height: 1.55; white-space: normal; }

    /* Les mesures, repliees. Elles restent accessibles d'un clic — un chiffre
       qu'on ne peut plus retrouver est un chiffre qu'on n'ose plus supprimer. */
    /* La barre de relache se distingue de celle de capture : l'une mesure un
       effort en cours, l'autre un compte a rebours qu'on peut devancer. */
    .progress.auto > div { background: var(--ink-3); }
    .relax { margin: 6px 0 0; text-transform: none; letter-spacing: 0; font-size: 11.5px; }

    .detail { margin: 12px 0 0; }
    .detail summary {
      cursor: pointer; font-size: 12px; color: var(--ink-3);
      padding: 4px 0; user-select: none;
    }
    .detail summary:hover { color: var(--ink-2); }
    .detail ul { margin: 6px 0 0; padding-left: 20px; font-size: 12.5px; line-height: 1.7; }
    .detail .lbl { text-transform: none; letter-spacing: 0; font-size: 11.5px; }
    /* Ce qui est conservé mérite d'être dit avant la première prise : sans ça,
       on hésite à réenregistrer de peur de tout perdre. */
    .keep {
      display: flex; align-items: flex-start; gap: 9px;
      padding: 10px 12px; margin-bottom: 14px;
      font-size: 12.5px; line-height: 1.55; color: #a6e3c6;
      background: #17a26814; border: 1px solid #17a26840;
      border-radius: var(--r-control);
    }
    .keep app-icon { color: var(--st-armed); margin-top: 1px; }

    .linkpick { display: inline-flex; gap: 6px; margin-top: 4px; }
    .kbtn {
      padding: 6px 13px; border-radius: 7px;
      font-size: 12.5px; font-weight: 520;
      background: var(--panel-3); border: 1px solid transparent; color: var(--ink-2);
    }
    .kbtn.on { background: var(--accent-wash); border-color: #8b5cf655; color: var(--ink); }

    /* Récapitulatif des maillons déjà pris : sans lui, on perd le fil au
       troisième et on ne sait plus ce qu'on est en train de construire. */
    .recap { margin: 0 0 12px; padding: 0; list-style: none; }
    .recap li {
      display: flex; align-items: center; gap: 8px;
      padding: 5px 0; border-bottom: 0; font-size: 12.5px; color: var(--ink-2);
    }
    .recap app-icon { color: var(--st-armed); }
  `,
})
export class Wizard implements OnInit, OnDestroy {
  /** Gesture dont on refait la pose. Null = création.
   *  Tout ce qui n'est pas la pose elle-même est conservé : identité, meme lié,
   *  cadrage, son, sensibilité. Sans ça, corriger une pose qui déclenche mal
   *  obligeait à supprimer puis tout refaire, y compris relier l'image. */
  @Input() replacing: StoredGesture | null = null
  /**
   * Mode enchaînement : enregistre plusieurs poses À LA SUITE dans une seule
   * session, et renvoie leurs identifiants.
   *
   * Sans lui, monter une macro imposait d'aller créer chaque pose dans Gestures
   * puis de revenir les choisir dans des listes déroulantes — trois écrans pour
   * une idée qui en tient dans un seul geste. Les poses ainsi créées sont
   * marquées « maillon seulement » : elles servent l'enchaînement, pas un meme.
   */
  @Input() mode: WizardMode = 'gesture'
  @Output() cancel = new EventEmitter<void>()
  /** Identifiant de la gesture écrite — l'appelant en a besoin pour la relier
   *  (deviner « la dernière du tableau » marcherait aujourd'hui et casserait
   *  le jour où l'ordre de stockage change). */
  @Output() saved = new EventEmitter<string>()
  /** Identifiants des gestures créées, dans l'ordre de l'enchaînement. */
  @Output() savedChain = new EventEmitter<string[]>()

  protected readonly TAKES = TAKES
  protected readonly SAMPLES_PER_TAKE = SAMPLES_PER_TAKE
  protected readonly CIRCLED = CIRCLED
  protected readonly LINK_CHOICES = Array.from(
    { length: MACRO_MAX_STEPS - MACRO_MIN_STEPS + 1 },
    (_, i) => MACRO_MIN_STEPS + i,
  )

  private detection = inject(DetectionService)
  private store = inject(StoreService)

  name = ''
  source: GestureSource = 'face'
  holdMode: HoldMode = 'fixed_duration'

  /** Nombre de maillons voulus (mode enchaînement). */
  links = signal(MACRO_MIN_STEPS)
  /** Maillon en cours, 0-indexé. */
  link = signal(0)
  drafts = signal<LinkDraft[]>([])

  step = signal<Step>('config')
  take = signal(0)
  countdown = signal(3)
  relaxProgress = signal(0)
  captureProgress = signal(0)
  missing = signal('')
  starting = signal(false)
  verdict = signal<ThresholdVerdict | null>(null)
  keptCount = signal(0)

  private takes: RawFrame[][] = []
  private keptRaw: RawFrame[] = []
  /** Version featurisée des mêmes samples — gardée pour comparer le maillon
   *  suivant à celui-ci, qui n'est pas encore en base. */
  private keptBlocks: FeatureBlocks[] = []
  /** Désabonnement de la prise en cours. Fermer le wizard pendant une capture
   *  laissait l'écouteur branché à vie : il continuait à copier des frames
   *  30 fois par seconde, pour un composant qui n'existe plus. */
  private unsub: (() => void) | null = null
  private countdownTimer = 0
  private relaxTimer = 0

  ngOnDestroy(): void {
    this.unsub?.()
    this.unsub = null
    clearInterval(this.countdownTimer)
    clearInterval(this.relaxTimer)
  }

  ngOnInit(): void {
    const g = this.replacing
    if (!g) return
    this.name = g.name
    this.source = g.source
    this.holdMode = g.holdMode
  }

  /** Résout aussi les maillons de la session en cours, qui n'ont pas encore
   *  d'identifiant en base — sinon une collision entre deux poses du MÊME
   *  enchaînement s'afficherait sous forme d'identifiant technique. */
  nameOf(id: string): string {
    const draft = id.startsWith(DRAFT_PREFIX)
      ? this.drafts()[+id.slice(DRAFT_PREFIX.length)]
      : null
    if (draft) return draft.name
    return this.store.gestures().find((g) => g.id === id)?.name ?? id
  }

  // ---- Libellés ----

  /** Enchaînement complet : plusieurs poses ET la macro qui les relie. */
  get isChain(): boolean {
    return this.mode === 'chain'
  }

  /** Pose destinée à un enchaînement — seule ou en série, même traitement. */
  get isLink(): boolean {
    return this.mode !== 'gesture'
  }

  chainName(): string {
    return this.name.trim() || 'Enchaînement'
  }

  private linkName(i: number): string {
    return `${this.chainName()} ${CIRCLED[i] ?? i + 1}`
  }

  configTitle(): string {
    if (this.isChain) return 'Enregistrer une macro'
    if (this.isLink) return 'Nouvelle pose de maillon'
    return this.replacing ? 'Réenregistrer la pose' : 'Nouvelle pose'
  }

  /** « Maillon 2/3 — » devant chaque titre de prise, pour ne jamais se demander
   *  quelle pose on est en train de faire. */
  linkPrefix(): string {
    return this.isChain ? `Maillon ${this.link() + 1}/${this.links()} — ` : ''
  }

  startLabel(): string {
    return this.isChain ? `Enregistrer la pose 1/${this.links()}` : 'Démarrer la prise 1/3'
  }

  lastLink(): boolean {
    return this.link() >= this.links() - 1
  }

  saveLabel(): string {
    // « Quand même » : le bouton dit ce qu'on fait, à savoir passer outre un
    // avertissement qu'on vient de lire. Sans ça, un clic distrait ne se
    // distingue plus d'un enregistrement propre.
    if (this.verdict()?.verdict === 'collision') return 'Enregistrer quand même'
    if (this.isChain) return "Créer l'enchaînement"
    if (this.isLink) return 'Ajouter ce maillon'
    return this.replacing ? 'Remplacer la pose' : 'Enregistrer'
  }

  async start(): Promise<void> {
    this.starting.set(true)
    try {
      await this.detection.start()
      this.drafts.set([])
      this.link.set(0)
      this.takes = []
      this.take.set(0)
      this.beginTake()
    } finally {
      this.starting.set(false)
    }
  }

  /** Fige le maillon courant et enchaîne sur le suivant, sans repasser par la
   *  configuration : c'est tout l'intérêt d'enregistrer « d'affilée ». */
  nextLink(): void {
    const v = this.verdict()
    if (!v) return
    this.drafts.update((d) => [
      ...d,
      {
        name: this.linkName(d.length),
        source: this.source,
        keptRaw: this.keptRaw,
        kept: this.keptBlocks,
        threshold: v.threshold,
      },
    ])
    this.link.update((i) => i + 1)
    this.takes = []
    this.take.set(0)
    this.verdict.set(null)
    this.beginTake()
  }

  beginTake(): void {
    // Qu'on soit arrivé par le minuteur ou par le bouton, il ne doit pas
    // rester un intervalle qui relancerait une prise déjà lancée.
    clearInterval(this.relaxTimer)
    this.step.set('countdown')
    this.countdown.set(3)
    clearInterval(this.countdownTimer)
    this.countdownTimer = window.setInterval(() => {
      this.countdown.update((c) => c - 1)
      if (this.countdown() <= 0) {
        clearInterval(this.countdownTimer)
        this.capture()
      }
    }, 1000)
  }

  private capture(): void {
    this.step.set('capture')
    this.captureProgress.set(0)
    const frames: RawFrame[] = []
    const started = performance.now()
    const DURATION = 2000
    let lastSampleAt = 0

    this.unsub?.()
    this.unsub = this.detection.onFrame((raw, _viz, ts) => {
      const elapsed = ts - started
      this.captureProgress.set(Math.min(100, (elapsed / DURATION) * 100))
      const usable =
        (this.source === 'face' || this.source === 'both' ? !!raw.face : true) &&
        (this.source === 'hand' || this.source === 'both' ? raw.hands.length > 0 : true)
      this.missing.set(
        usable ? '' : this.source === 'face' ? 'visage non détecté' : 'main non détectée',
      )
      if (usable && ts - lastSampleAt >= DURATION / SAMPLES_PER_TAKE) {
        lastSampleAt = ts
        // copie défensive : MediaPipe réutilise ses buffers
        frames.push(JSON.parse(JSON.stringify(raw)) as RawFrame)
      }
      if (elapsed >= DURATION) {
        this.unsub?.()
        this.unsub = null
        this.endTake(frames)
      }
    })
  }

  private endTake(frames: RawFrame[]): void {
    this.takes.push(frames)
    this.take.set(this.takes.length)
    if (this.takes.length < TAKES) {
      this.step.set('between')
      this.startRelax()
    } else {
      this.analyze()
    }
  }

  /** Le temps de relâche, matérialisé.
   *
   *  Une barre qui se remplit plutôt qu'un simple délai : on doit voir venir
   *  la reprise, sinon l'enchaînement automatique surprend au lieu d'aider.
   *  Le bouton reste, il ne fait plus que devancer l'échéance. */
  private startRelax(): void {
    clearInterval(this.relaxTimer)
    const started = Date.now()
    this.relaxProgress.set(0)
    this.relaxTimer = window.setInterval(() => {
      const p = Math.min(100, ((Date.now() - started) / RELAX_MS) * 100)
      this.relaxProgress.set(p)
      if (p >= 100) this.beginTake()
    }, 50)
  }

  private analyze(): void {
    const allRaw = this.takes.flat()
    const baseline = this.store.baseline()
    const featurized = allRaw.map((r) => featurizeRaw(r, baseline))
    const keptIdx = filterOutlierIndices(featurized, this.source, 8)
    const kept = keptIdx.map((i) => featurized[i]!)
    this.keptRaw = keptIdx.map((i) => allRaw[i]!)
    this.keptBlocks = kept
    this.keptCount.set(kept.length)

    // La gesture qu'on réenregistre est exclue de la comparaison : sinon elle
    // entrerait en collision avec sa PROPRE ancienne pose, et refaire une pose
    // à peine corrigée serait toujours refusé.
    const others = this.store
      .runtimeGestures()
      .filter((g) => g.id !== this.replacing?.id)
      .map((g) => ({ gestureId: g.id, samples: g.samples, source: g.source }))
    // Les maillons déjà pris dans cette session comptent aussi : deux poses
    // indistinguables au sein du MÊME enchaînement le rendraient inexécutable,
    // et rien en base ne les aurait signalées puisqu'elles n'y sont pas encore.
    for (const [i, d] of this.drafts().entries()) {
      others.push({ gestureId: `${DRAFT_PREFIX}${i}`, samples: d.kept, source: d.source })
    }
    const v = computeThreshold(kept, this.source, others, this.store.negatives())
    this.verdict.set(v)
    this.step.set('result')
  }

  /** Ne refait QUE le maillon courant : les précédents restent acquis. */
  retry(): void {
    this.takes = []
    this.take.set(0)
    this.beginTake()
  }

  async save(): Promise<void> {
    const v = this.verdict()
    // Une collision avertit mais n'interdit pas : le matcher étant en
    // winner-take-all, deux poses proches ne partent pas ensemble, seule
    // l'identité de la gagnante devient incertaine.
    //
    // Le seuil retenu est `base`, non raboté sur le voisin — le même que celui
    // qu'écrit la migration, pour que les deux chemins ne divergent pas.
    if (!v) return
    if (this.isChain) return this.saveChain(v.threshold)
    const baseline = this.store.baseline()
    const old = this.replacing
    const gesture: StoredGesture = {
      // Réenregistrement : on garde l'identité et tous les réglages qui ne
      // décrivent pas la pose. L'identifiant surtout — c'est lui qui relie le
      // meme, son cadrage et son son.
      ...old,
      id: old?.id ?? crypto.randomUUID(),
      // La gesture naît dans le profil affiché : c'est celui que l'utilisateur
      // regardait en cliquant « Enregistrer ».
      profileId: old?.profileId ?? this.store.activeProfile()?.id ?? 'default',
      name: this.name.trim(),
      enabled: old?.enabled ?? true,
      source: this.source,
      samples: this.keptRaw.map((r) => blocksToJson(featurizeRaw(r, baseline))),
      rawSamples: this.keptRaw,
      // Le seuil suit forcément la nouvelle pose ; le multiplicateur de
      // sensibilité, lui, reste celui que l'utilisateur avait réglé à la main.
      threshold: v.threshold,
      thresholdAuto: v.threshold,
      sensitivity: old?.sensitivity ?? 1,
      framesToTrigger: old?.framesToTrigger ?? 5,
      cooldownMs: old?.cooldownMs ?? 1500,
      holdMode: this.isLink ? 'fixed_duration' : this.holdMode,
      featurizerVersion: FEATURIZER_VERSION,
      // Une pose enregistrée POUR un enchaînement ne doit rien afficher seule.
      // Le drapeau est posé ici et pas par l'appelant : c'est le wizard qui sait
      // dans quelle intention la pose vient d'être prise.
      sequenceOnly: this.isLink ? true : old?.sequenceOnly,
    }
    await this.store.saveGesture(gesture)
    this.saved.emit(gesture.id)
  }

  /**
   * Écrit les maillons d'un coup, à la toute fin. Rien n'a été persisté avant :
   * abandonner au maillon 2 sur 3 ne laisse aucune trace, là où un enregistrement
   * au fil de l'eau aurait semé des gestures orphelines que personne ne relie
   * plus à rien.
   */
  private async saveChain(lastThreshold: number): Promise<void> {
    const baseline = this.store.baseline()
    const profileId = this.store.activeProfile()?.id ?? 'default'
    const all: LinkDraft[] = [
      ...this.drafts(),
      {
        name: this.linkName(this.drafts().length),
        source: this.source,
        keptRaw: this.keptRaw,
        kept: this.keptBlocks,
        threshold: lastThreshold,
      },
    ]

    const ids: string[] = []
    for (const d of all) {
      const id = crypto.randomUUID()
      ids.push(id)
      await this.store.saveGesture({
        id,
        profileId,
        name: d.name,
        enabled: true,
        source: d.source,
        samples: d.keptRaw.map((r) => blocksToJson(featurizeRaw(r, baseline))),
        rawSamples: d.keptRaw,
        threshold: d.threshold,
        thresholdAuto: d.threshold,
        sensitivity: 1,
        framesToTrigger: 5,
        cooldownMs: 1500,
        // Une pose de maillon n'est jamais « tenue » : un enchaînement se lit
        // sur des déclenchements, pas sur une durée.
        holdMode: 'fixed_duration',
        featurizerVersion: FEATURIZER_VERSION,
        // Le point de toute l'affaire : ces poses servent l'enchaînement et
        // n'affichent rien seules.
        sequenceOnly: true,
      })
    }
    this.savedChain.emit(ids)
  }
}
