import { Component, computed, inject, signal } from '@angular/core'
import { RouterLink } from '@angular/router'
import { type HoldMode } from '@meme4me/core'
import { ActionList } from '../components/action-list'
import { AssetPicker } from '../components/asset-picker'
import { BindingEditor } from '../components/binding-editor'
import { Icon } from '../components/icon'
import { Wizard } from '../components/wizard'
import { MatcherService } from '../services/matcher.service'
import {
  StoreService,
  effectiveThreshold,
  type AssetMeta,
  type StoredBinding,
  type StoredGesture,
} from '../services/store.service'

/**
 * Bibliothèque de gestures. Chaque carte porte une miniature du cadre OBS à
 * l'échelle : on voit la position et la taille réelles du meme sans ouvrir
 * l'éditeur. C'est le seul écran où le meme est le sujet, il occupe donc la
 * plus grande surface de la carte.
 */
@Component({
  selector: 'app-gestures-page',
  imports: [Wizard, RouterLink, Icon, BindingEditor, AssetPicker, ActionList],
  template: `
    <div class="head">
      <div>
        <h1>Gestures</h1>
        <p class="lbl sub">
          {{ store.gestures().length }} pose(s) dans « {{ store.activeProfile()?.name }} » ·
          <span class="num">{{ bound() }}</span> avec un meme
        </p>
      </div>
      <span class="spacer"></span>
      <button class="primary" [disabled]="!store.calibration()" (click)="newGesture()">
        <app-icon name="plus" [size]="16" /> Enregistrer une gesture
      </button>
    </div>

    @if (!store.calibration() && store.loaded()) {
      <div class="notice warn rise">
        <app-icon name="target" [size]="18" />
        <div>
          <b>Commence par la calibration.</b>
          <a routerLink="/reglages">Vingt secondes de visage neutre</a> : elles absorbent
          ta morphologie et tes lunettes, et servent de garde-fou contre les
          déclenchements involontaires.
        </div>
      </div>
    }
    @if (store.staleGestures().length) {
      <div class="notice err rise">
        <app-icon name="pulse" [size]="18" />
        <div>
          <b>{{ store.staleGestures().length }} gesture(s) à réenregistrer.</b>
          Elles viennent d'une version antérieure et n'ont plus les données nécessaires.
          Utilise l'icône <b>main</b> sur la carte : la pose est refaite, le meme
          et son cadrage restent en place.
        </div>
      </div>
    }

    @if (!store.gestures().length && store.calibration()) {
      <div class="card empty">
        <span class="bigmark"><app-icon name="hand" [size]="30" /></span>
        <b>Aucune gesture dans ce profil.</b>
        <p class="lbl">
          Vise huit à quinze poses volontaires et exagérées, lisibles à la caméra.
          Une pose que le viewer ne devine pas ne fait pas un bon bit.
        </p>
      </div>
    }

    <div class="grid">
      @for (g of store.gestures(); track g.id) {
        <article class="card interactive tile" [class.off]="!g.enabled">
          <!-- Miniature du cadre OBS, à l'échelle exacte -->
          <div class="mini alpha-grid" (click)="edit(g)" [title]="'Régler le rendu de ' + g.name">
            @if (asset(g); as a) {
              <div
                class="mitem"
                [style.left.%]="render(g).x"
                [style.top.%]="render(g).y"
                [style.width.%]="render(g).sizePct"
              >
                <img [src]="store.assetUrl(a)" alt="" />
              </div>
              @if (render(g).sound) {
                <span class="chip snd"><app-icon name="volume" [size]="12" /></span>
              }
            } @else {
              <span class="nomeme">
                <app-icon name="image" [size]="22" />
                Aucun meme — clique pour en choisir un
              </span>
            }
            <label class="sw switch" (click)="$event.stopPropagation()">
              <input
                type="checkbox"
                [checked]="g.enabled"
                (change)="toggle(g, $event)"
                [attr.aria-label]="'Activer ' + g.name"
              />
            </label>
            <span class="chip src">{{ srcLabel(g.source) }}</span>
          </div>

          <div class="meta">
            <b class="nm" [title]="g.name">{{ g.name }}</b>
            <div class="stats lbl">
              seuil <span class="num">{{ effective(g).toFixed(3) }}</span>
              @if ((g.sensitivity ?? 1) !== 1) {
                <span class="num sens">{{ ((g.sensitivity ?? 1) * 100).toFixed(0) }}%</span>
              }
              · <span class="num">{{ g.rawSamples.length }}</span> prises
              @if (needsPosition(g)) {
                <span class="badge warn" title="Enregistrée avant la prise en compte de la position des mains">
                  sans position
                </span>
              }
            </div>
          </div>

          @if (store.gesturesInMacros().has(g.id)) {
            <label class="chainopt" [title]="'Utilisée dans un enchaînement'">
              <span class="switch">
                <input
                  type="checkbox"
                  [checked]="!!g.sequenceOnly"
                  (change)="setSequenceOnly(g, $event)"
                />
              </span>
              <span>
                Maillon seulement
                <span class="lbl">
                  Reconnue et comptée dans les macros, mais n'affiche pas son
                  meme toute seule.
                </span>
              </span>
            </label>
          }

          <div class="ctrl">
            <select
              [value]="g.holdMode"
              (change)="setHoldMode(g, $event)"
              title="Affichage du meme"
              [attr.aria-label]="'Mode d\\'affichage de ' + g.name"
            >
              <option value="fixed_duration">
                durée fixe{{ render(g).durationMs ? ' · ' + (render(g).durationMs / 1000).toFixed(1) + 's' : '' }}
              </option>
              <option value="while_held">tant que tenue</option>
            </select>
          </div>

          <div class="acts">
            @if (asset(g)) {
              <button class="sm" (click)="edit(g)">
                <app-icon name="sliders" [size]="14" /> Régler
              </button>
            }
            <button
              class="sm"
              (click)="matcher.testTrigger(g.id)"
              title="Joue le déclenchement complet : meme et actions"
            >
              <app-icon name="zap" [size]="14" /> Tester
            </button>
            <button
              class="ghost sm"
              (click)="rerecord(g)"
              title="Refaire la pose en gardant le meme, le cadrage et le son"
            >
              <app-icon name="hand" [size]="15" />
            </button>
            <span class="spacer"></span>
            <button class="ghost sm" (click)="remove(g)" [attr.aria-label]="'Supprimer ' + g.name">
              <app-icon name="trash" [size]="15" />
            </button>
          </div>

          <!-- Import direct : ne s'affiche que si rien n'est encore lié -->
          @if (!asset(g)) {
            <div class="drop">
              <app-asset-picker (picked)="attach(g, $event)" />
            </div>
          }

          <app-action-list [ownerId]="g.id" />
        </article>
      }
    </div>

    @if (wizardOpen()) {
      <app-wizard
        [replacing]="rerecording()"
        (cancel)="closeWizard()"
        (saved)="closeWizard()"
      />
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
    .sub { margin: 0; }

    .notice {
      display: flex; align-items: flex-start; gap: 11px;
      padding: 13px 16px; margin-bottom: 12px;
      border-radius: var(--r-panel); font-size: 13px; line-height: 1.55;
      border: 1px solid var(--line);
      box-shadow: var(--edge);
    }
    .notice app-icon { margin-top: 1px; }
    .notice b { font-weight: 620; }
    .notice.warn { border-color: #d9901255; background: #d9901214; color: #f0cd94; }
    .notice.warn app-icon { color: var(--st-candidate); }
    .notice.err { border-color: #e03e4e55; background: #e03e4e14; color: #f3b6bc; }
    .notice.err app-icon { color: var(--st-live); }

    .empty { text-align: center; padding: 46px 24px; }
    .bigmark {
      display: grid; place-items: center;
      width: 58px; height: 58px; margin: 0 auto 16px;
      border-radius: 18px; color: var(--accent-hi);
      background: var(--accent-wash); border: 1px solid #8b5cf644;
    }
    .empty b { display: block; margin-bottom: 7px; font-weight: 620; font-size: 15px; }
    .empty .lbl { max-width: 50ch; margin: 0 auto; }

    .grid {
      display: grid; gap: 14px;
      grid-template-columns: repeat(auto-fill, minmax(298px, 1fr));
    }
    .tile { padding: 0; overflow: hidden; display: flex; flex-direction: column; }
    .tile.off { opacity: 0.55; }
    .tile.off .mini { filter: saturate(0.25); }

    /* Miniature : rapport 16:9 comme le cadre OBS, mêmes % de placement que
       l'overlay — la carte est un aperçu, pas une vignette décorative. */
    .mini {
      position: relative; aspect-ratio: 16 / 9; cursor: pointer;
      border-bottom: 1px solid var(--line);
      overflow: hidden;
    }
    .mitem { position: absolute; transform: translate(-50%, -50%); }
    .mitem img { display: block; width: 100%; height: auto; }
    .nomeme {
      position: absolute; inset: 0; display: flex;
      flex-direction: column; align-items: center; justify-content: center; gap: 8px;
      color: var(--ink-3); font-size: 12px; text-align: center; padding: 16px;
    }
    .mini:hover .nomeme { color: var(--ink-2); }

    .sw { position: absolute; top: 9px; left: 9px; }
    .chip {
      position: absolute; top: 10px; right: 10px;
      display: inline-flex; align-items: center; gap: 4px;
      padding: 3px 8px; border-radius: 99px;
      font-size: 10.5px; font-weight: 550; letter-spacing: 0.03em;
      background: #0c0b1099; color: var(--ink-2);
      border: 1px solid #ffffff14; backdrop-filter: blur(6px);
    }
    .chip.snd { top: auto; bottom: 10px; right: 10px; color: var(--cyan); }

    .meta { padding: 13px 15px 0; }
    .nm {
      display: block; font-weight: 600; font-size: 14.5px; letter-spacing: -0.01em;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .stats {
      display: flex; align-items: center; flex-wrap: wrap; gap: 6px;
      margin-top: 5px; text-transform: none; letter-spacing: 0; font-size: 11.5px;
    }
    .stats .num { color: var(--ink); }
    .stats .sens { color: var(--accent-hi); }

    /* N'apparaît que si la pose sert dans un enchaînement : hors de ce cas,
       l'option n'aurait aucun sens et n'ajouterait que du bruit. */
    .chainopt {
      display: flex; align-items: flex-start; gap: 10px;
      margin: 12px 15px 0; padding: 9px 11px;
      background: #38bdf80e; border: 1px solid #38bdf833;
      border-radius: var(--r-control);
      cursor: pointer; font-size: 12.5px;
    }
    .chainopt .lbl {
      display: block; margin-top: 2px;
      text-transform: none; letter-spacing: 0; font-size: 11px;
    }

    .ctrl { padding: 11px 15px 0; }
    .ctrl select { width: 100%; font-size: 12.5px; padding: 7px 28px 7px 10px; }

    .acts { display: flex; align-items: center; gap: 6px; padding: 11px 13px 13px; }

    .drop { margin: 0 13px 13px; }
  `,
})
export class GesturesPage {
  protected store = inject(StoreService)
  protected matcher = inject(MatcherService)
  wizardOpen = signal(false)
  /** Gesture dont on refait la pose ; null = création. */
  rerecording = signal<StoredGesture | null>(null)
  editing = signal<{ gesture: StoredGesture; binding: StoredBinding } | null>(null)

  /** Refaire la pose sans toucher au reste — c'est aussi la façon de repasser
   *  une vieille gesture au featurizer courant sans relier son meme. */
  rerecord(g: StoredGesture): void {
    this.rerecording.set(g)
    this.wizardOpen.set(true)
  }

  newGesture(): void {
    this.rerecording.set(null)
    this.wizardOpen.set(true)
  }

  closeWizard(): void {
    this.wizardOpen.set(false)
    this.rerecording.set(null)
  }

  readonly bound = computed(
    () => this.store.gestures().filter((g) => this.store.binding(g.id)).length,
  )

  effective(g: StoredGesture): number {
    return effectiveThreshold(g)
  }

  render(g: StoredGesture): StoredBinding {
    return (
      this.store.binding(g.id) ??
      ({ x: 50, y: 50, sizePct: 25, durationMs: 0 } as StoredBinding)
    )
  }

  asset(g: StoredGesture) {
    return this.store.asset(this.store.binding(g.id)?.assetId)
  }

  /** Gesture à main enregistrée sans ancre visage : la position ne peut pas
   *  la distinguer d'une autre pose de même forme. */
  needsPosition(g: StoredGesture): boolean {
    if (g.source === 'face') return false
    return !g.rawSamples.some((r) => r.faceAnchor)
  }

  srcLabel(s: string): string {
    return s === 'face' ? 'visage' : s === 'hand' ? 'main' : 'visage + main'
  }

  async toggle(g: StoredGesture, ev: Event): Promise<void> {
    await this.store.saveGesture({ ...g, enabled: (ev.target as HTMLInputElement).checked })
  }

  async setSequenceOnly(g: StoredGesture, ev: Event): Promise<void> {
    await this.store.saveGesture({
      ...g,
      sequenceOnly: (ev.target as HTMLInputElement).checked,
    })
  }

  async setHoldMode(g: StoredGesture, ev: Event): Promise<void> {
    const holdMode = (ev.target as HTMLSelectElement).value as HoldMode
    await this.store.saveGesture({ ...g, holdMode })
  }

  /** Sans meme, l'éditeur n'a rien à cadrer : on demande d'abord l'image. */
  async edit(g: StoredGesture): Promise<void> {
    const binding = this.store.binding(g.id)
    if (!binding) return
    this.editing.set({ gesture: g, binding })
  }

  /** Enchaîne sur le cadrage : c'est la question suivante dans tous les cas. */
  async attach(g: StoredGesture, meta: AssetMeta): Promise<void> {
    const binding = await this.store.bindAsset(g.id, meta.id)
    this.editing.set({ gesture: g, binding })
  }

  async remove(g: StoredGesture): Promise<void> {
    if (confirm(`Supprimer « ${g.name} » ?`)) await this.store.deleteGesture(g.id)
  }
}
