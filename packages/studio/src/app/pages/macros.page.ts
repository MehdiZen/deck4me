import {
  Component,
  OnDestroy,
  computed,
  inject,
  signal,
} from '@angular/core'
import { RouterLink } from '@angular/router'
import {
  MACRO_DEFAULT_WINDOW_MS,
  MACRO_MAX_STEPS,
  MACRO_MIN_STEPS,
  type MacroDef,
} from '@meme4me/core'
import { AssetPicker } from '../components/asset-picker'
import { BindingEditor } from '../components/binding-editor'
import { Icon } from '../components/icon'
import { RangeFill } from '../range-fill'
import { MatcherService } from '../services/matcher.service'
import {
  StoreService,
  type AssetMeta,
  type StoredBinding,
  type StoredGesture,
} from '../services/store.service'

/**
 * Macros : une action déclenchée par un ENCHAÎNEMENT de poses.
 *
 * L'intérêt profond n'est pas le confort. Le nombre de poses distinguables est
 * fini — au-delà d'une douzaine, le wizard refuse tout parce que les seuils se
 * resserrent mutuellement. Deux poses parmi six donnent trente combinaisons
 * sans rien ajouter à distinguer. Et une séquence ne part jamais par accident,
 * ce qui en fait le seul endroit sûr pour une action qu'on regretterait.
 */
@Component({
  selector: 'app-macros-page',
  imports: [Icon, RangeFill, AssetPicker, BindingEditor, RouterLink],
  template: `
    <div class="head">
      <div>
        <h1>Macros</h1>
        <p class="lbl sub">
          {{ store.macros().length }} enchaînement(s) dans
          « {{ store.activeProfile()?.name }} »
        </p>
      </div>
      <span class="spacer"></span>
      <button class="primary" [disabled]="store.gestures().length < 2" (click)="create()">
        <app-icon name="plus" [size]="16" /> Nouvelle macro
      </button>
    </div>

    @if (store.gestures().length < 2) {
      <div class="card empty">
        <span class="bigmark"><app-icon name="zap" [size]="30" /></span>
        <b>Il faut au moins deux gestures.</b>
        <p class="lbl">
          Une macro enchaîne des poses existantes.
          <a routerLink="/gestures">Enregistres-en deux</a>, puis reviens ici.
        </p>
      </div>
    } @else if (!store.macros().length) {
      <div class="card empty">
        <span class="bigmark"><app-icon name="zap" [size]="30" /></span>
        <b>Aucune macro pour l'instant.</b>
        <p class="lbl">
          Enchaîne deux poses très différentes — un poing puis trois doigts, par
          exemple. Deux gestes volontaires d'affilée, c'est hors d'atteinte d'une
          gesticulation ordinaire : c'est là que doivent aller les actions que tu
          ne confierais jamais à une pose seule.
        </p>
      </div>
    }

    <div class="list">
      @for (m of store.macros(); track m.id) {
        <article class="card mac" [class.off]="!m.enabled">
          <div class="top">
            <label class="switch">
              <input
                type="checkbox"
                [checked]="m.enabled"
                (change)="toggle(m, $event)"
                [attr.aria-label]="'Activer ' + m.name"
              />
            </label>
            <input
              class="nm"
              [value]="m.name"
              (change)="rename(m, $any($event.target).value)"
              [attr.aria-label]="'Nom de ' + m.name"
            />
            <span class="spacer"></span>
            @if (progressOf(m.id); as p) {
              <span class="badge ok"><i class="led on"></i>{{ p }}/{{ m.steps.length }} en cours</span>
            }
            <button class="sm" (click)="matcher.testTrigger(m.id)" title="Affiche le meme dans OBS">
              <app-icon name="zap" [size]="14" /> Tester
            </button>
            <button class="ghost sm" (click)="remove(m)" [attr.aria-label]="'Supprimer ' + m.name">
              <app-icon name="trash" [size]="15" />
            </button>
          </div>

          <!-- Enchaînement -->
          <div class="chain">
            @for (step of m.steps; track $index) {
              <div class="step" [class.lit]="(progressOf(m.id) ?? 0) > $index">
                <span class="ord num">{{ $index + 1 }}</span>
                <select
                  [value]="step"
                  (change)="setStep(m, $index, $any($event.target).value)"
                  [attr.aria-label]="'Pose ' + ($index + 1)"
                >
                  @for (g of store.gestures(); track g.id) {
                    <option [value]="g.id">{{ g.name }}</option>
                  }
                </select>
                @if (m.steps.length > MIN) {
                  <button class="ghost sm" (click)="removeStep(m, $index)" aria-label="Retirer ce maillon">
                    <app-icon name="close" [size]="13" />
                  </button>
                }
              </div>
              @if (!$last) {
                <span class="arrow" aria-hidden="true">›</span>
              }
            }
            @if (m.steps.length < MAX) {
              <button class="sm addstep" (click)="addStep(m)">
                <app-icon name="plus" [size]="13" /> Maillon
              </button>
            }
          </div>

          <div class="opts">
            <div class="win">
              <span class="lbl">Délai max entre deux poses</span>
              <div class="row">
                <input
                  type="range"
                  min="500"
                  max="4000"
                  step="100"
                  [value]="m.windowMs"
                  (input)="setWindow(m, +$any($event.target).value)"
                  [attr.aria-label]="'Fenêtre de ' + m.name"
                />
                <span class="pct num">{{ (m.windowMs / 1000).toFixed(1) }}s</span>
              </div>
            </div>

            <div class="bind">
              @if (asset(m.id); as a) {
                <div class="thumbrow">
                  <img [src]="store.assetUrl(a)" alt="" class="thumb alpha-grid" />
                  <span class="fname">{{ a.filename }}</span>
                  <button class="sm" (click)="edit(m)">
                    <app-icon name="sliders" [size]="14" /> Régler
                  </button>
                </div>
              } @else {
                <app-asset-picker label="Meme de cette macro" (picked)="attach(m, $event)" />
              }
            </div>
          </div>

          @if (warning(m); as w) {
            <p class="badge warn block">{{ w }}</p>
          }
        </article>
      }
    </div>

    @if (store.macros().length) {
      <div class="card tip">
        <app-icon name="target" [size]="18" />
        <div>
          <b>Les poses d'un enchaînement déclenchent aussi leur propre meme.</b>
          <p class="lbl">
            Si tu ne veux pas voir le meme du premier maillon apparaître au
            passage, marque cette pose <b>« maillon seulement »</b> sur sa carte
            dans <a routerLink="/gestures">Gestures</a>. Elle restera reconnue et
            continuera d'alimenter les macros, sans rien afficher seule.
          </p>
        </div>
      </div>
    }

    @if (editing(); as e) {
      <app-binding-editor
        [gesture]="e.gesture"
        [binding]="e.binding"
        (cancel)="editing.set(null)"
        (saved)="editing.set(null)"
      />
    }
  `,
  styles: `
    .head { display: flex; align-items: flex-start; gap: 14px; margin-bottom: 20px; }
    .head h1 { margin: 0 0 4px; }
    .sub { margin: 0; text-transform: none; letter-spacing: 0; }

    .empty { text-align: center; padding: 46px 24px; }
    .bigmark {
      display: grid; place-items: center;
      width: 58px; height: 58px; margin: 0 auto 16px;
      border-radius: 18px; color: var(--accent-hi);
      background: var(--accent-wash); border: 1px solid #8b5cf644;
    }
    .empty b { display: block; margin-bottom: 7px; font-weight: 620; font-size: 15px; }
    .empty .lbl { max-width: 54ch; margin: 0 auto; }

    .list { display: flex; flex-direction: column; gap: 14px; }
    .mac { padding: 15px 17px; }
    .mac.off { opacity: 0.55; }

    .top { display: flex; align-items: center; gap: 11px; margin-bottom: 14px; }
    .nm {
      font-weight: 600; font-size: 14.5px; letter-spacing: -0.01em;
      background: none; border-color: transparent; padding: 5px 8px; max-width: 280px;
    }
    .nm:hover { border-color: var(--line); background: var(--void); }

    /* La chaîne se lit de gauche à droite, comme on l'exécute. Le maillon
       validé s'allume : sans ça on ne sait pas si le premier geste a pris. */
    .chain {
      display: flex; align-items: center; gap: 7px; flex-wrap: wrap;
      padding: 12px 13px; margin-bottom: 13px;
      background: var(--void); border: 1px solid var(--line-soft);
      border-radius: var(--r-control);
    }
    .step {
      display: flex; align-items: center; gap: 7px;
      padding: 5px 7px; border-radius: 7px;
      border: 1px solid transparent;
      transition: background 200ms var(--ease), border-color 200ms var(--ease);
    }
    .step.lit { background: #17a26818; border-color: #17a26855; }
    .ord {
      display: grid; place-items: center;
      width: 19px; height: 19px; flex: none; border-radius: 50%;
      background: var(--panel-3); color: var(--ink-2); font-size: 10.5px;
    }
    .step.lit .ord { background: var(--st-armed); color: #06130d; }
    .step select { font-size: 12.5px; padding: 6px 26px 6px 9px; max-width: 190px; }
    .arrow { color: var(--ink-3); font-size: 17px; }
    .addstep { padding: 5px 10px; font-size: 11.5px; }

    .opts { display: flex; gap: 18px; flex-wrap: wrap; align-items: flex-start; }
    .win { flex: 1 1 260px; min-width: 220px; }
    .win .row { display: flex; align-items: center; gap: 11px; margin-top: 6px; }
    .win input[type='range'] { flex: 1; min-width: 0; }
    .pct { flex: none; width: 38px; text-align: right; font-size: 12px; color: var(--ink-2); }

    .bind { flex: 1 1 300px; min-width: 260px; }
    .thumbrow { display: flex; align-items: center; gap: 10px; }
    .thumb {
      height: 44px; width: 62px; object-fit: contain; flex: none;
      border-radius: 6px; border: 1px solid var(--line);
    }
    .fname {
      flex: 1; min-width: 0; font-size: 12px; color: var(--ink-2);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }

    .block { display: block; white-space: normal; line-height: 1.5; padding: 9px 12px; margin-top: 12px; }

    .tip {
      display: flex; align-items: flex-start; gap: 12px; margin-top: 14px;
      border-color: #38bdf844; background: #38bdf80e;
    }
    .tip app-icon { color: var(--cyan); margin-top: 1px; }
    .tip b { font-weight: 600; }
    .tip .lbl { margin: 4px 0 0; text-transform: none; letter-spacing: 0; font-size: 12.5px; }
  `,
})
export class MacrosPage implements OnDestroy {
  protected store = inject(StoreService)
  protected matcher = inject(MatcherService)
  protected readonly MIN = MACRO_MIN_STEPS
  protected readonly MAX = MACRO_MAX_STEPS

  editing = signal<{ gesture: StoredGesture; binding: StoredBinding } | null>(null)
  /** Rafraîchi à 10 Hz : le retour visuel doit suivre la main, pas la seconde. */
  private tick = signal(0)
  private timer = window.setInterval(() => this.tick.update((t) => t + 1), 100)

  private readonly live = computed(() => {
    this.tick()
    return new Map(this.matcher.progress().map((p) => [p.macroId, p.done]))
  })

  ngOnDestroy(): void {
    clearInterval(this.timer)
  }

  progressOf(macroId: string): number | null {
    return this.live().get(macroId) ?? null
  }

  asset(macroId: string): AssetMeta | null {
    return this.store.asset(this.store.binding(macroId)?.assetId)
  }

  /** Ce qui empêcherait la macro de fonctionner, dit avant l'échec en live. */
  warning(m: MacroDef): string | null {
    const known = new Set(this.store.gestures().map((g) => g.id))
    if (m.steps.some((s) => !known.has(s))) {
      return "Une des poses n'existe plus dans ce profil — remplace-la."
    }
    const disabled = m.steps.filter((s) =>
      this.store.gestures().some((g) => g.id === s && !g.enabled),
    )
    if (disabled.length) {
      return 'Une des poses est désactivée : la macro ne pourra jamais se compléter.'
    }
    // Deux maillons identiques d'affilée sont irréalisables : le cooldown de la
    // gesture empêche un second déclenchement dans la fenêtre.
    for (let i = 1; i < m.steps.length; i++) {
      if (m.steps[i] === m.steps[i - 1]) {
        return 'Deux fois la même pose à la suite : le temps de repos de la gesture empêchera le second déclenchement.'
      }
    }
    return null
  }

  async create(): Promise<void> {
    const gs = this.store.gestures()
    await this.store.saveMacro({
      id: crypto.randomUUID(),
      profileId: this.store.activeProfile()?.id ?? 'default',
      name: `Macro ${this.store.macros().length + 1}`,
      enabled: true,
      steps: [gs[0]!.id, gs[1]!.id],
      windowMs: MACRO_DEFAULT_WINDOW_MS,
    })
  }

  private async patch(m: MacroDef, p: Partial<MacroDef>): Promise<void> {
    await this.store.saveMacro({ ...m, ...p })
  }

  toggle(m: MacroDef, ev: Event): void {
    void this.patch(m, { enabled: (ev.target as HTMLInputElement).checked })
  }

  rename(m: MacroDef, name: string): void {
    const t = name.trim()
    if (t && t !== m.name) void this.patch(m, { name: t })
  }

  setStep(m: MacroDef, i: number, gestureId: string): void {
    const steps = [...m.steps]
    steps[i] = gestureId
    void this.patch(m, { steps })
  }

  addStep(m: MacroDef): void {
    const gs = this.store.gestures()
    const next = gs.find((g) => g.id !== m.steps[m.steps.length - 1]) ?? gs[0]!
    void this.patch(m, { steps: [...m.steps, next.id] })
  }

  removeStep(m: MacroDef, i: number): void {
    if (m.steps.length <= MACRO_MIN_STEPS) return
    void this.patch(m, { steps: m.steps.filter((_, k) => k !== i) })
  }

  setWindow(m: MacroDef, windowMs: number): void {
    void this.patch(m, { windowMs })
  }

  /** Une macro emprunte le binding des gestures : son identifiant tient lieu
   *  de `gestureId`. L'éditeur de rendu marche donc tel quel. */
  async attach(m: MacroDef, meta: AssetMeta): Promise<void> {
    const binding = await this.store.bindAsset(m.id, meta.id)
    this.editing.set({ gesture: this.asGesture(m), binding })
  }

  edit(m: MacroDef): void {
    const binding = this.store.binding(m.id)
    if (binding) this.editing.set({ gesture: this.asGesture(m), binding })
  }

  /** L'éditeur n'a besoin que d'un nom et d'un mode d'affichage : une macro est
   *  toujours en durée fixe, elle n'a pas de notion de « pose tenue ». */
  private asGesture(m: MacroDef): StoredGesture {
    return { name: m.name, holdMode: 'fixed_duration' } as StoredGesture
  }

  async remove(m: MacroDef): Promise<void> {
    if (confirm(`Supprimer la macro « ${m.name} » ?`)) await this.store.deleteMacro(m.id)
  }
}
