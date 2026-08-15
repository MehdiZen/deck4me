import {
  Component,
  ElementRef,
  EventEmitter,
  Input,
  Output,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core'
import { ENTER_FX, EXIT_FX, type EnterFx, type ExitFx } from '@meme4me/core'
import { RangeFill } from '../range-fill'
import {
  DEFAULT_RENDER,
  StoreService,
  isAudio,
  type StoredBinding,
  type StoredGesture,
} from '../services/store.service'
import { Icon } from './icon'

/** Repères d'aimantation, en % du cadre : centre, tiers, et marge de sécurité
 *  (les 5 % de bord où une source OBS est souvent rognée par un cadre). */
const SNAP_X = [5, 25, 33.333, 50, 66.667, 75, 95]
const SNAP_Y = [5, 25, 33.333, 50, 66.667, 75, 95]
const SNAP_TOL = 1.4

const FX_LABEL: Record<string, string> = {
  pop: 'Pop',
  fade: 'Fondu',
  slide: 'Glissé',
  drop: 'Chute',
  shake: 'Secousse',
  spin: 'Toupie',
  shrink: 'Aspiré',
}

/**
 * Éditeur de rendu (phase 4). Le plateau est une maquette au 1:1 du cadre
 * OBS : la même formule place le média ici et dans l'overlay (centre et
 * largeur en % du cadre), donc ce qu'on voit est ce qui sortira — c'était le
 * défaut du modèle v1, où « scale 1 » ne voulait rien dire tant qu'on n'avait
 * pas mesuré la source de navigateur.
 */
@Component({
  selector: 'app-binding-editor',
  imports: [Icon, RangeFill],
  template: `
    <div class="bg" (click)="cancel.emit()"></div>
    <div class="panel card" role="dialog" aria-label="Réglage du rendu">
      <header>
        <div>
          <h2>{{ gesture.name }}</h2>
          <p class="lbl sub">Cadre OBS 16:9 — glisse le meme, tire le coin pour la taille.</p>
        </div>
        <button class="ghost" (click)="cancel.emit()" aria-label="Fermer">
          <app-icon name="close" />
        </button>
      </header>

      <div class="body">
        <!-- Plateau -->
        <div class="stagewrap">
          <div
            #stage
            class="stage alpha-grid"
            (pointermove)="onMove($event)"
            (pointerup)="onUp($event)"
            (pointercancel)="onUp($event)"
          >
            @if (showGuides()) {
              <div class="guides">
                <i style="left:33.333%"></i><i style="left:50%" class="mid"></i>
                <i style="left:66.667%"></i>
                <i class="h" style="top:33.333%"></i><i class="h mid" style="top:50%"></i>
                <i class="h" style="top:66.667%"></i>
              </div>
            }

            <div
              class="item"
              [style.left.%]="draft().x"
              [style.top.%]="draft().y"
              [style.width.%]="draft().sizePct"
              (pointerdown)="startMove($event)"
            >
              @if (isVideo()) {
                <video [src]="mediaUrl()" autoplay loop muted playsinline></video>
              } @else {
                <img [src]="mediaUrl()" alt="" draggable="false" />
              }
              <span class="frame"></span>
              <span class="grip" (pointerdown)="startResize($event)" title="Redimensionner"></span>
            </div>
          </div>
          <div class="stagebar">
            <span class="badge">1920 × 1080</span>
            <span class="lbl readpos">
              x <b class="num">{{ draft().x.toFixed(1) }}</b> ·
              y <b class="num">{{ draft().y.toFixed(1) }}</b> ·
              largeur <b class="num">{{ draft().sizePct.toFixed(1) }}</b>%
              <span class="px num">≈ {{ (draft().sizePct * 19.2).toFixed(0) }} px</span>
            </span>
            <span class="spacer"></span>
            <button class="sm" (click)="center()">Recentrer</button>
          </div>
        </div>

        <!-- Réglages -->
        <div class="side">
          <section>
            <h3>Taille</h3>
            <div class="row">
              <input
                type="range"
                min="3"
                max="100"
                step="0.5"
                [value]="draft().sizePct"
                (input)="patch({ sizePct: +$any($event.target).value })"
                aria-label="Largeur du meme"
              />
              <span class="pct num">{{ draft().sizePct.toFixed(0) }}%</span>
            </div>
          </section>

          <section>
            <h3>Entrée</h3>
            <div class="seg">
              @for (fx of ENTER_FX; track fx) {
                <button
                  [class.on]="draft().enter === fx"
                  (click)="patch({ enter: fx }); replay()"
                >
                  {{ label(fx) }}
                </button>
              }
            </div>
          </section>

          <section>
            <h3>Sortie</h3>
            <div class="seg">
              @for (fx of EXIT_FX; track fx) {
                <button [class.on]="draft().exit === fx" (click)="patch({ exit: fx })">
                  {{ label(fx) }}
                </button>
              }
            </div>
          </section>

          <section>
            <h3>Durée</h3>
            @if (gesture.holdMode === 'while_held') {
              <p class="lbl note">
                Cette gesture est en « tant que tenue » : le meme reste affiché tant
                que tu tiens la pose. La durée ne s'applique pas.
              </p>
            } @else {
              <div class="row">
                <input
                  type="range"
                  min="0.3"
                  max="15"
                  step="0.1"
                  [value]="draft().durationMs / 1000"
                  (input)="patch({ durationMs: Math.round(+$any($event.target).value * 1000) })"
                  aria-label="Durée d'affichage"
                />
                <span class="pct num">{{ (draft().durationMs / 1000).toFixed(1) }}s</span>
              </div>
            }
          </section>

          <section>
            <h3>Son</h3>
            @if (soundAsset(); as s) {
              <div class="soundrow">
                <app-icon name="volume" [size]="16" />
                <span class="fname">{{ s.filename }}</span>
                <button class="ghost sm" (click)="playSound()" title="Écouter">
                  <app-icon name="play" [size]="14" />
                </button>
                <button class="ghost sm" (click)="patch({ sound: null })" title="Retirer le son">
                  <app-icon name="close" [size]="14" />
                </button>
              </div>
              <div class="row">
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  [value]="draft().sound?.volume ?? 0.8"
                  (input)="setVolume(+$any($event.target).value)"
                  aria-label="Volume du son"
                />
                <span class="pct num">{{ ((draft().sound?.volume ?? 0.8) * 100).toFixed(0) }}%</span>
              </div>
            } @else {
              <div class="soundpick">
                <label class="file">
                  <app-icon name="plus" [size]="15" /> Importer un son
                  <input type="file" accept=".mp3,.wav,.ogg" hidden (change)="uploadSound($event)" />
                </label>
                @if (store.soundAssets().length) {
                  <select (change)="pickSound($event)" aria-label="Son déjà importé">
                    <option value="">— déjà importé —</option>
                    @for (a of store.soundAssets(); track a.id) {
                      <option [value]="a.id">{{ a.filename }}</option>
                    }
                  </select>
                }
              </div>
              <p class="lbl note">
                mp3, wav ou ogg. Dans OBS, coche « Contrôler l'audio via OBS » sur la
                source navigateur, sinon le son sort de ton casque et pas du stream.
              </p>
            }
          </section>

          <section>
            <h3>Calque</h3>
            <div class="row">
              <input
                type="number"
                min="-10"
                max="10"
                style="width:74px"
                [value]="draft().layer"
                (change)="patch({ layer: +$any($event.target).value })"
                aria-label="Calque"
              />
              <span class="lbl note flat">Au-dessus des calques inférieurs si deux memes se superposent.</span>
            </div>
          </section>
        </div>
      </div>

      <footer>
        <button (click)="preview()">
          <app-icon name="zap" [size]="15" /> Aperçu dans OBS
        </button>
        <span class="spacer"></span>
        <button (click)="cancel.emit()">Annuler</button>
        <button class="primary" (click)="save()">
          <app-icon name="check" [size]="15" /> Enregistrer
        </button>
      </footer>
    </div>
  `,
  styles: `
    :host { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; }
    .bg {
      position: absolute; inset: 0;
      background: #07060acc; backdrop-filter: blur(5px);
      animation: fadein 160ms ease-out;
    }
    @keyframes fadein { from { opacity: 0 } }
    .panel {
      position: relative;
      width: min(1060px, 94vw); max-height: 92vh;
      display: flex; flex-direction: column;
      padding: 0; overflow: hidden;
      border-radius: var(--r-big);
      box-shadow: var(--edge), 0 40px 90px -20px #000d;
      animation: pop 220ms var(--spring) both;
    }
    @keyframes pop { from { opacity: 0; transform: translateY(10px) scale(.985) } }

    header {
      display: flex; align-items: flex-start; gap: 12px;
      padding: 18px 20px 14px; border-bottom: 1px solid var(--line-soft);
    }
    header h2 { margin: 0; font-size: 17px; }
    .sub { margin: 3px 0 0; }
    header button { margin-left: auto; }

    .body { display: flex; gap: 0; min-height: 0; overflow: hidden; }

    /* --- plateau --- */
    .stagewrap { flex: 1 1 auto; min-width: 0; padding: 18px 18px 14px; }
    .stage {
      position: relative; width: 100%; aspect-ratio: 16 / 9;
      border-radius: 10px; overflow: hidden;
      border: 1px solid var(--line);
      box-shadow: inset 0 0 0 1px #00000060, inset 0 20px 50px -30px #000;
      touch-action: none;
    }
    .guides i {
      position: absolute; top: 0; bottom: 0; width: 1px;
      background: #a78bfa4d; pointer-events: none;
    }
    .guides i.h { left: 0; right: 0; top: auto; height: 1px; width: auto; }
    .guides i.mid { background: #a78bfa99; }

    .item { position: absolute; transform: translate(-50%, -50%); cursor: grab; }
    .item:active { cursor: grabbing; }
    .item img, .item video { display: block; width: 100%; height: auto; pointer-events: none; }
    .frame {
      position: absolute; inset: -3px; border-radius: 4px;
      border: 1px dashed #a78bfa77; pointer-events: none;
      opacity: 0; transition: opacity 140ms var(--ease);
    }
    .item:hover .frame, .item:active .frame { opacity: 1; }
    .grip {
      position: absolute; right: -7px; bottom: -7px;
      width: 15px; height: 15px; border-radius: 4px;
      background: var(--accent-hi); border: 2px solid #14121b;
      box-shadow: 0 2px 8px #0009; cursor: nwse-resize;
      opacity: 0; transition: opacity 140ms var(--ease), transform 140ms var(--spring);
    }
    .item:hover .grip, .item:active .grip { opacity: 1; }
    .grip:hover { transform: scale(1.2); }

    .stagebar { display: flex; align-items: center; gap: 12px; margin-top: 11px; }
    .readpos { text-transform: none; letter-spacing: 0; font-size: 12px; }
    .readpos b { color: var(--ink); }
    .px { color: var(--ink-3); margin-left: 6px; }

    /* --- colonne de réglages --- */
    .side {
      flex: 0 0 296px; min-width: 0; overflow-y: auto;
      padding: 18px 20px 20px; border-left: 1px solid var(--line-soft);
      background: #131219;
    }
    section { margin-bottom: 20px; }
    section:last-child { margin-bottom: 0; }
    .row { display: flex; align-items: center; gap: 11px; }
    .row input[type='range'] { flex: 1; min-width: 0; }
    .pct { flex: none; width: 42px; text-align: right; font-size: 12px; color: var(--ink-2); }

    /* Sélecteur segmenté : tous les choix visibles, pas repliés dans une liste */
    .seg { display: flex; flex-wrap: wrap; gap: 4px; }
    .seg button {
      flex: 1 0 auto; padding: 6px 10px; font-size: 12px;
      background: var(--void); border-color: var(--line-soft); color: var(--ink-2);
      box-shadow: none;
    }
    .seg button:hover { color: var(--ink); }
    .seg button.on {
      background: var(--accent-wash); border-color: #8b5cf680; color: var(--ink);
      font-weight: 600;
    }

    .note { margin: 8px 0 0; font-size: 11.5px; text-transform: none; letter-spacing: 0; }
    .note.flat { margin: 0; flex: 1; }

    .soundrow {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 10px; margin-bottom: 10px;
      background: var(--void); border: 1px solid var(--line-soft);
      border-radius: var(--r-control); color: var(--ink-2);
    }
    .fname {
      flex: 1; min-width: 0; font-size: 12px; color: var(--ink);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .soundpick { display: flex; flex-direction: column; gap: 7px; }
    .file {
      display: flex; align-items: center; justify-content: center; gap: 7px;
      cursor: pointer; font-size: 12.5px; color: var(--ink-2);
      border: 1px dashed var(--line); border-radius: var(--r-control);
      padding: 10px 12px; text-align: center;
      transition: border-color 160ms var(--ease), color 160ms var(--ease), background 160ms var(--ease);
    }
    .file:hover { border-color: var(--accent); color: var(--ink); background: var(--accent-wash); }

    footer {
      display: flex; align-items: center; gap: 9px;
      padding: 14px 20px; border-top: 1px solid var(--line-soft);
      background: #131219;
    }
  `,
})
export class BindingEditor {
  @Input({ required: true }) gesture!: StoredGesture
  @Input({ required: true }) binding!: StoredBinding
  @Output() cancel = new EventEmitter<void>()
  @Output() saved = new EventEmitter<void>()

  protected store = inject(StoreService)
  protected readonly ENTER_FX = ENTER_FX
  protected readonly EXIT_FX = EXIT_FX
  protected readonly Math = Math

  @ViewChild('stage') stageRef!: ElementRef<HTMLDivElement>

  /** Brouillon local : rien n'est écrit tant qu'« Enregistrer » n'est pas
   *  cliqué. Le plateau reste donc explorable sans conséquence. */
  readonly draft = signal<StoredBinding>({ ...DEFAULT_RENDER } as StoredBinding)
  readonly showGuides = signal(false)

  /** dx/dy : écart constant entre le curseur et le centre du média, capturé au
   *  début du geste — sans lui le média sauterait sous le curseur au clic. */
  private drag: { mode: 'move' | 'size'; dx: number; dy: number } | null = null

  ngOnInit(): void {
    this.draft.set({ ...DEFAULT_RENDER, ...this.binding })
  }

  label(fx: string): string {
    return FX_LABEL[fx] ?? fx
  }

  mediaUrl(): string {
    const a = this.store.asset(this.draft().assetId)
    return a ? this.store.assetUrl(a) : ''
  }

  isVideo(): boolean {
    return this.store.asset(this.draft().assetId)?.ext === 'webm'
  }

  readonly soundAsset = computed(() => this.store.asset(this.draft().sound?.assetId))

  patch(p: Partial<StoredBinding>): void {
    this.draft.update((d) => ({ ...d, ...p }))
  }

  center(): void {
    this.patch({ x: 50, y: 50 })
  }

  setVolume(volume: number): void {
    const assetId = this.draft().sound?.assetId
    if (assetId) this.patch({ sound: { assetId, volume } })
  }

  // ---- Déplacement / redimensionnement ------------------------------------
  // Le pointeur est capturé sur le PLATEAU, pas sur le média : sortir du
  // média pendant le glissement ne doit pas interrompre le geste.

  startMove(ev: PointerEvent): void {
    ev.preventDefault()
    const r = this.stageRef.nativeElement.getBoundingClientRect()
    const d = this.draft()
    this.drag = {
      mode: 'move',
      dx: d.x - ((ev.clientX - r.left) / r.width) * 100,
      dy: d.y - ((ev.clientY - r.top) / r.height) * 100,
    }
    this.stageRef.nativeElement.setPointerCapture(ev.pointerId)
    this.showGuides.set(true)
  }

  startResize(ev: PointerEvent): void {
    ev.preventDefault()
    ev.stopPropagation() // sinon le déplacement démarre aussi
    this.drag = { mode: 'size', dx: 0, dy: 0 }
    this.stageRef.nativeElement.setPointerCapture(ev.pointerId)
  }

  onMove(ev: PointerEvent): void {
    if (!this.drag) return
    const r = this.stageRef.nativeElement.getBoundingClientRect()
    if (this.drag.mode === 'move') {
      const raw = {
        x: ((ev.clientX - r.left) / r.width) * 100 + this.drag.dx,
        y: ((ev.clientY - r.top) / r.height) * 100 + this.drag.dy,
      }
      // Alt enfoncé = placement libre : l'aimantation aide au cadrage propre
      // mais empêcherait un décalage volontaire de 0,5 %.
      const x = ev.altKey ? raw.x : snap(raw.x, SNAP_X)
      const y = ev.altKey ? raw.y : snap(raw.y, SNAP_Y)
      // On autorise le débordement : un meme à moitié hors cadre est un effet
      // recherché. Au-delà, il deviendrait introuvable.
      this.patch({ x: clamp(x, -20, 120), y: clamp(y, -20, 120) })
    } else {
      // La largeur suit la distance horizontale au centre : la poignée reste
      // sous le curseur quel que soit le rapport d'image du média.
      const centerX = r.left + (this.draft().x / 100) * r.width
      const half = Math.abs(ev.clientX - centerX)
      this.patch({ sizePct: clamp((half * 2 * 100) / r.width, 3, 200) })
    }
  }

  onUp(ev: PointerEvent): void {
    if (!this.drag) return
    this.drag = null
    this.showGuides.set(false)
    this.stageRef.nativeElement.releasePointerCapture?.(ev.pointerId)
  }

  // ---- Son ----------------------------------------------------------------

  async uploadSound(ev: Event): Promise<void> {
    const file = (ev.target as HTMLInputElement).files?.[0]
    if (!file) return
    const meta = await this.store.uploadAsset(file)
    if (!isAudio(meta)) {
      // sniff() côté Rust a reconnu autre chose : on ne l'attache pas comme son
      return
    }
    this.patch({ sound: { assetId: meta.id, volume: 0.8 } })
  }

  pickSound(ev: Event): void {
    const id = (ev.target as HTMLSelectElement).value
    if (id) this.patch({ sound: { assetId: id, volume: 0.8 } })
  }

  playSound(): void {
    const a = this.soundAsset()
    if (!a) return
    const audio = new Audio(this.store.assetUrl(a))
    audio.volume = this.draft().sound?.volume ?? 0.8
    void audio.play().catch(() => {})
  }

  // ---- Sortie -------------------------------------------------------------

  /** Rejoue l'effet d'entrée dans OBS quand on en essaie un. */
  replay(): void {
    void this.preview()
  }

  async preview(): Promise<void> {
    await this.store.previewBinding(this.draft())
  }

  async save(): Promise<void> {
    await this.store.saveBinding(this.draft())
    this.saved.emit()
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

function snap(v: number, points: number[]): number {
  for (const p of points) if (Math.abs(v - p) < SNAP_TOL) return p
  return v
}
