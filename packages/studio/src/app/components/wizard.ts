import { Component, EventEmitter, Input, OnInit, Output, inject, signal } from '@angular/core'
import { FormsModule } from '@angular/forms'
import {
  FEATURIZER_VERSION,
  blocksToJson,
  computeThreshold,
  featurizeRaw,
  filterOutlierIndices,
  type GestureSource,
  type HoldMode,
  type RawFrame,
  type ThresholdVerdict,
} from '@meme4me/core'
import { DetectionService } from '../services/detection.service'
import { StoreService, type StoredGesture } from '../services/store.service'
import { CameraView } from './camera-view'
import { Icon } from './icon'

type Step = 'config' | 'countdown' | 'capture' | 'between' | 'result'

const TAKES = 3 // 3 prises séparées : la variance intra-classe d'une prise
const SAMPLES_PER_TAKE = 8 // unique est artificiellement basse → seuil irréaliste

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
            <h2>{{ replacing ? 'Réenregistrer la pose' : 'Nouvelle gesture' }}</h2>
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
              <label class="lbl">Nom</label><br />
              <input [(ngModel)]="name" placeholder="ex. Sourire forcé" style="width:100%" />
            </p>
            <p>
              <label class="lbl">Source</label><br />
              <select [(ngModel)]="source">
                <option value="face">Visage</option>
                <option value="hand">Main(s)</option>
                <option value="both">Visage + main(s)</option>
              </select>
              <select [(ngModel)]="holdMode" style="margin-left:8px">
                <option value="fixed_duration">Durée fixe</option>
                <option value="while_held">Tant que tenue</option>
              </select>
            </p>
            <p class="lbl">
              3 prises de 2 s. Entre chaque prise, relâche la pose puis reprends-la :
              c'est ce qui rend le seuil réaliste. Pose volontaire, exagérée, lisible caméra.
            </p>
            <p style="display:flex; gap:8px; justify-content:flex-end">
              <button (click)="cancel.emit()">Annuler</button>
              <button class="primary" [disabled]="!name.trim() || starting()" (click)="start()">
                {{ starting() ? 'Caméra…' : 'Démarrer la prise 1/3' }}
              </button>
            </p>
          }
          @case ('countdown') {
            <h2>Prise {{ take() + 1 }}/3 — prends la pose</h2>
            <app-camera-view />
            <div class="count">{{ countdown() }}</div>
          }
          @case ('capture') {
            <h2>Prise {{ take() + 1 }}/3 — TIENS la pose</h2>
            <app-camera-view />
            <div class="progress"><div [style.width.%]="captureProgress()"></div></div>
            @if (missing()) {
              <p class="badge err">{{ missing() }}</p>
            }
          }
          @case ('between') {
            <h2>Prise {{ take() }}/3 capturée</h2>
            <app-camera-view />
            <p>Relâche complètement la pose, bouge un peu, puis reprends-la.</p>
            <p style="text-align:right">
              <button class="primary" (click)="beginTake()">Prise {{ take() + 1 }}/3</button>
            </p>
          }
          @case ('result') {
            <h2>Analyse</h2>
            @if (verdict(); as v) {
              <ul>
                <li>Samples retenus : {{ keptCount() }} / {{ TAKES * SAMPLES_PER_TAKE }}</li>
                <li>Dispersion intra-pose max : {{ v.maxIntra.toFixed(3) }}</li>
                <li>Seuil auto : <b>{{ v.threshold.toFixed(3) }}</b></li>
                @if (v.nearestOther; as n) {
                  <li>Gesture la plus proche : « {{ nameOf(n.gestureId) }} » à {{ n.dist.toFixed(3) }}</li>
                }
                @if (v.nearestNegative !== null) {
                  <li>Parole normale la plus proche : {{ v.nearestNegative!.toFixed(3) }}</li>
                }
              </ul>
              @switch (v.verdict) {
                @case ('collision') {
                  <p class="badge err verdict">
                    Trop proche de « {{ nameOf(v.collidesWith!) }} » — enregistrement refusé.
                    Choisis une pose plus différenciée, ou réenregistre l'autre gesture.
                  </p>
                }
                @case ('false_positive_risk') {
                  <p class="badge warn verdict">
                    Cette pose ressemble à ta tête en parlant normalement : risque de
                    déclenchement involontaire en live. Exagère-la davantage, ou assume.
                  </p>
                }
                @case ('ok') {
                  <p class="badge ok verdict">Pose propre, seuil fiable.</p>
                }
              }
            }
            <p style="display:flex; gap:8px; justify-content:flex-end">
              <button (click)="retry()">Refaire les prises</button>
              <button (click)="cancel.emit()">Abandonner</button>
              @if (verdict()?.verdict !== 'collision') {
                <button class="primary" (click)="save()">
                  {{ replacing ? 'Remplacer la pose' : 'Enregistrer' }}
                </button>
              }
            </p>
          }
        }
      </div>
    </div>
  `,
  styles: `
    .modal-bg {
      position: fixed; inset: 0; z-index: 50;
      background: #07060acc;
      backdrop-filter: blur(5px);
      display: grid; place-items: center;
      animation: fade 160ms ease-out;
    }
    @keyframes fade { from { opacity: 0 } }
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
  `,
})
export class Wizard implements OnInit {
  /** Gesture dont on refait la pose. Null = création.
   *  Tout ce qui n'est pas la pose elle-même est conservé : identité, meme lié,
   *  cadrage, son, sensibilité. Sans ça, corriger une pose qui déclenche mal
   *  obligeait à supprimer puis tout refaire, y compris relier l'image. */
  @Input() replacing: StoredGesture | null = null
  @Output() cancel = new EventEmitter<void>()
  @Output() saved = new EventEmitter<void>()

  protected readonly TAKES = TAKES
  protected readonly SAMPLES_PER_TAKE = SAMPLES_PER_TAKE

  private detection = inject(DetectionService)
  private store = inject(StoreService)

  name = ''
  source: GestureSource = 'face'
  holdMode: HoldMode = 'fixed_duration'

  step = signal<Step>('config')
  take = signal(0)
  countdown = signal(3)
  captureProgress = signal(0)
  missing = signal('')
  starting = signal(false)
  verdict = signal<ThresholdVerdict | null>(null)
  keptCount = signal(0)

  private takes: RawFrame[][] = []
  private keptRaw: RawFrame[] = []

  ngOnInit(): void {
    const g = this.replacing
    if (!g) return
    this.name = g.name
    this.source = g.source
    this.holdMode = g.holdMode
  }

  nameOf(id: string): string {
    return this.store.gestures().find((g) => g.id === id)?.name ?? id
  }

  async start(): Promise<void> {
    this.starting.set(true)
    try {
      await this.detection.start()
      this.takes = []
      this.take.set(0)
      this.beginTake()
    } finally {
      this.starting.set(false)
    }
  }

  beginTake(): void {
    this.step.set('countdown')
    this.countdown.set(3)
    const iv = setInterval(() => {
      this.countdown.update((c) => c - 1)
      if (this.countdown() <= 0) {
        clearInterval(iv)
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

    const unsub = this.detection.onFrame((raw, _viz, ts) => {
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
        unsub()
        this.endTake(frames)
      }
    })
  }

  private endTake(frames: RawFrame[]): void {
    this.takes.push(frames)
    this.take.set(this.takes.length)
    if (this.takes.length < TAKES) {
      this.step.set('between')
    } else {
      this.analyze()
    }
  }

  private analyze(): void {
    const allRaw = this.takes.flat()
    const baseline = this.store.baseline()
    const featurized = allRaw.map((r) => featurizeRaw(r, baseline))
    const keptIdx = filterOutlierIndices(featurized, this.source, 8)
    const kept = keptIdx.map((i) => featurized[i]!)
    this.keptRaw = keptIdx.map((i) => allRaw[i]!)
    this.keptCount.set(kept.length)

    // La gesture qu'on réenregistre est exclue de la comparaison : sinon elle
    // entrerait en collision avec sa PROPRE ancienne pose, et refaire une pose
    // à peine corrigée serait toujours refusé.
    const others = this.store
      .runtimeGestures()
      .filter((g) => g.id !== this.replacing?.id)
      .map((g) => ({ gestureId: g.id, samples: g.samples, source: g.source }))
    const v = computeThreshold(kept, this.source, others, this.store.negatives())
    this.verdict.set(v)
    this.step.set('result')
  }

  retry(): void {
    this.takes = []
    this.take.set(0)
    this.beginTake()
  }

  async save(): Promise<void> {
    const v = this.verdict()
    if (!v || v.verdict === 'collision') return
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
      holdMode: this.holdMode,
      featurizerVersion: FEATURIZER_VERSION,
    }
    await this.store.saveGesture(gesture)
    this.saved.emit()
  }
}
