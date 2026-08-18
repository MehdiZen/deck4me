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
  describeAction,
  type MacroDef,
} from '@deck4me/core'
import { ActionList } from '../components/action-list'
import { AssetPicker } from '../components/asset-picker'
import { BindingEditor } from '../components/binding-editor'
import { Icon } from '../components/icon'
import { Wizard } from '../components/wizard'
import { RangeFill } from '../range-fill'
import { ConfirmService } from '../services/confirm.service'
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
  imports: [Icon, RangeFill, AssetPicker, BindingEditor, RouterLink, ActionList, Wizard],
  template: `
    <div class="head">
      <div>
        <h1>Macros</h1>
        <p class="lbl sub">
          {{ store.macros().length }} macro(s) dans
          « {{ store.activeProfile()?.name }} »
        </p>
      </div>
      <span class="spacer"></span>
      @if (store.freeLinkGestures().length >= MIN) {
        <!-- Des maillons attendent d'être reliés : c'est le geste évident, il
             passe devant l'enregistrement d'un nouvel enchaînement. -->
        <button class="primary" (click)="create()">
          <app-icon name="layers" [size]="16" />
          Relier mes {{ store.freeLinkGestures().length }} maillons libres
        </button>
      } @else if (store.gestures().length >= 2) {
        <button
          [disabled]="!store.calibration()"
          [title]="store.calibration() ? 'Assembler une macro avec des poses déjà enregistrées' : whyLocked"
          (click)="create()"
        >
          <app-icon name="layers" [size]="16" /> Depuis mes poses
        </button>
      }
      <button
        [class.primary]="store.freeLinkGestures().length < MIN"
        [disabled]="!store.calibration()"
        [title]="store.calibration() ? 'Faire les poses à la suite, en une seule session' : whyLocked"
        (click)="record()"
      >
        <app-icon name="hand" [size]="16" /> Enregistrer une macro
      </button>
    </div>

    <!-- Des maillons enregistrés que rien n'utilise, c'est presque toujours une
         macro qu'on a commencée sans la finir. Le dire ici évite de les chercher
         dans Gestures en se demandant pourquoi rien ne se déclenche. -->
    @if (store.freeLinkGestures().length && store.calibration()) {
      <div class="notice rise">
        <app-icon name="zap" [size]="18" />
        <div>
          <b>
            {{ store.freeLinkGestures().length }} maillon(s) enregistré(s) n'arment
            aucune macro.
          </b>
          <p class="lbl">
            @for (g of store.freeLinkGestures(); track g.id) {
              <span class="badge">{{ g.name }}</span>
            }
            @if (store.freeLinkGestures().length >= MIN) {
              — « Relier mes maillons libres » en fait une macro d'un clic, dans
              leur ordre d'enregistrement.
            } @else {
              — il en faut au moins {{ MIN }} pour former une macro.
            }
          </p>
        </div>
      </div>
    }

    @if (!store.calibration()) {
      <div class="card empty">
        <span class="bigmark"><app-icon name="target" [size]="30" /></span>
        <b>Il faut d'abord se calibrer.</b>
        <p class="lbl">
          Le seuil d'une pose se mesure par rapport à ton visage au repos.
          <a routerLink="/reglages">Fais la calibration</a>, puis reviens.
        </p>
      </div>
    } @else if (!store.macros().length) {
      <div class="card empty">
        <span class="bigmark"><app-icon name="zap" [size]="30" /></span>
        <b>Aucune macro pour l'instant.</b>
        <p class="lbl">
          <b>Enregistrer une macro</b> te fait faire les poses à la suite,
          en une seule session — c'est le chemin normal. Elles n'auront pas de
          meme à elles : elles ne servent qu'à déclencher la macro.
          <b>Depuis mes poses</b> réutilise au contraire des poses qui
          existent déjà.
        </p>
        <p class="lbl">
          Enchaîne deux poses très différentes — un poing puis trois doigts, par
          exemple. Deux gestes volontaires d'affilée, c'est hors d'atteinte d'une
          gesticulation ordinaire : c'est là que doivent aller les actions que tu
          ne confierais jamais à une pose seule. Et une macro n'est pas obligée
          d'afficher quoi que ce soit — elle peut se contenter d'ouvrir une app,
          de lancer un morceau ou d'appeler un webhook.
        </p>
      </div>
    }

    <!-- Filtre : au-delà de quelques macros, retrouver la bonne à l'œil coûte
         plus cher que de taper trois lettres. Il cherche aussi dans les noms de
         poses et d'actions — on se souvient souvent de ce que la macro FAIT
         plutôt que du nom qu'on lui a donné. -->
    @if (store.macros().length > 3) {
      <div class="filter">
        <app-icon name="target" [size]="15" />
        <input
          [value]="q()"
          (input)="q.set($any($event.target).value)"
          placeholder="Filtrer par nom, pose ou action…"
          aria-label="Filtrer les macros"
        />
        @if (q()) {
          <button class="ghost sm" (click)="q.set('')" aria-label="Effacer le filtre">
            <app-icon name="close" [size]="14" />
          </button>
        }
      </div>
    }

    @if (store.macros().length && !visible().length) {
      <p class="lbl none">Aucune macro ne correspond à « {{ q() }} ».</p>
    }

    <!-- Grille de cartes, et le détail dans une modale.
         La liste dépliable faisait cohabiter deux choses qui ne se lisent pas
         de la même façon : parcourir ses macros, et en régler une. Déplier
         poussait tout le reste vers le bas, si bien qu'on perdait sa place à
         chaque ouverture. Une carte répond à « laquelle ? », la modale à
         « comment ? », et rien ne bouge derrière. -->
    <div class="grid">
      @for (m of visible(); track m.id) {
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
            <button class="nmbtn" (click)="openId.set(m.id)">{{ m.name }}</button>
            <span class="spacer"></span>
            @if (progressOf(m.id); as p) {
              <span class="badge ok"><i class="led on"></i>{{ p }}/{{ m.steps.length }}</span>
            }
          </div>

          <!-- L'enchaînement EST l'identité de la macro : c'est lui qu'on
               cherche des yeux, avant le nom. Il occupe donc le corps de la
               carte, et sert aussi de zone de clic. -->
          <button class="sum" (click)="openId.set(m.id)" [attr.aria-label]="'Ouvrir ' + m.name">
            @for (s of m.steps; track $index) {
              @if (!$first) {
                <span class="arrow" aria-hidden="true">›</span>
              }
              <span class="chip" [class.lit]="(progressOf(m.id) ?? 0) > $index">
                {{ shortName(s) }}
              </span>
            }
          </button>

          <div class="foot">
            @if (asset(m.id)) {
              <span class="badge" title="Cette macro affiche un meme">
                <app-icon name="image" [size]="12" /> meme
              </span>
            }
            @if (store.actionsOf(m.id).length; as n) {
              <span class="badge" [title]="actionSummary(m.id)">
                <app-icon name="terminal" [size]="12" /> {{ n }}
              </span>
            }
            @if (warning(m)) {
              <span class="badge warn" [title]="warning(m) ?? ''">!</span>
            }
            <span class="spacer"></span>
            <button
              class="ghost sm"
              (click)="matcher.testTrigger(m.id)"
              title="Joue la macro entière : meme et actions"
            >
              <app-icon name="zap" [size]="15" />
            </button>
            <button class="ghost sm" (click)="openId.set(m.id)" [attr.aria-label]="'Régler ' + m.name">
              <app-icon name="sliders" [size]="15" />
            </button>
            <button class="ghost sm" (click)="remove(m)" [attr.aria-label]="'Supprimer ' + m.name">
              <app-icon name="trash" [size]="15" />
            </button>
          </div>
        </article>
      }
    </div>

    <!-- Fermeture au fond ET à Échap : une modale dont on ne sait pas sortir
         est pire que le panneau qu'elle remplace. -->
    @if (openMacro(); as m) {
      <div
        class="modal-bg"
        (click)="onBackdrop($event)"
        (window:keydown.escape)="openId.set(null)"
      >
        <div class="card modal" role="dialog" aria-modal="true" [attr.aria-label]="m.name">
          <div class="mhead">
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
            <button class="sm" (click)="matcher.testTrigger(m.id)" title="Joue la macro entière">
              <app-icon name="zap" [size]="14" /> Tester
            </button>
            <button class="ghost sm" (click)="openId.set(null)" aria-label="Fermer">
              <app-icon name="close" [size]="16" />
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
                <!-- Les maillons d'abord : c'est ce qu'on cherche ici neuf
                     fois sur dix. Une pose à meme reste choisissable, mais
                     elle affichera son meme au passage de l'enchaînement. -->
                @if (store.linkGestures().length) {
                  <optgroup label="Maillons">
                    @for (g of store.linkGestures(); track g.id) {
                      <option [value]="g.id" [selected]="g.id === step">{{ g.name }}</option>
                    }
                  </optgroup>
                }
                @if (store.memeGestures().length) {
                  <optgroup label="Poses à meme">
                    @for (g of store.memeGestures(); track g.id) {
                      <option [value]="g.id" [selected]="g.id === step">{{ g.name }}</option>
                    }
                  </optgroup>
                }
                <!-- Enregistrer une pose SANS quitter la macro : c'est ce qui
                     permet de la construire en plusieurs fois. -->
                <option [value]="RECORD">＋ Enregistrer une nouvelle pose…</option>
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
            <button class="sm addstep" (click)="addStep(m)" title="Enregistrer une pose de plus">
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
                <button class="ghost sm" (click)="detach(m)" aria-label="Retirer le meme">
                  <app-icon name="close" [size]="14" />
                </button>
              </div>
            } @else {
              <app-asset-picker label="Meme (facultatif)" (picked)="attach(m, $event)" />
            }
          </div>
        </div>

        <app-action-list [ownerId]="m.id" />

        @if (warning(m); as w) {
          <p class="badge warn block">{{ w }}</p>
        }
        </div>
      </div>
    }

    @if (store.macros().length) {
      <div class="card tip">
        <app-icon name="target" [size]="18" />
        <div>
          <b>Une pose enregistrée ici ne coûte pas la même chose qu'une pose à meme.</b>
          <p class="lbl">
            Les poses créées par « Enregistrer une macro » sont marquées
            <b>« maillon seulement »</b> : elles n'affichent rien toutes seules,
            donc un faux positif ne fait rien tant que la pose suivante n'arrive
            pas derrière. Tu peux les faire moins appuyées qu'une pose à meme.
          </p>
          <p class="lbl">
            En revanche elles comptent toujours dans le budget de collisions :
            chaque nouvelle pose resserre le seuil de ses voisines. Si tu réutilises
            au contraire une pose qui a déjà un meme, pense à la marquer
            « maillon seulement » sur sa carte dans
            <a routerLink="/gestures">Poses</a>, sinon son meme apparaîtra au
            passage.
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

    @if (recording(); as r) {
      <app-wizard
        [mode]="r.kind"
        (cancel)="recording.set(null)"
        (savedChain)="onChainRecorded($event)"
        (saved)="onLinkRecorded($event)"
      />
    }
  `,
  styles: `
    .head { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 20px; }
    .head h1 { margin: 0 0 4px; }
    .sub { margin: 0; text-transform: none; letter-spacing: 0; }

    .notice {
      display: flex; align-items: flex-start; gap: 11px;
      padding: 13px 16px; margin-bottom: 16px;
      border-radius: var(--r-panel); font-size: 13px; line-height: 1.55;
      background: #38bdf80e; border: 1px solid #38bdf844;
      box-shadow: var(--edge);
    }
    .notice app-icon { color: var(--cyan); margin-top: 1px; }
    .notice b { font-weight: 620; }
    .notice .lbl {
      display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
      margin: 6px 0 0; text-transform: none; letter-spacing: 0;
    }

    .empty { text-align: center; padding: 46px 24px; }
    .bigmark {
      display: grid; place-items: center;
      width: 58px; height: 58px; margin: 0 auto 16px;
      border-radius: 18px; color: var(--accent-hi);
      background: var(--accent-wash); border: 1px solid #8b5cf644;
    }
    .empty b { display: block; margin-bottom: 7px; font-weight: 620; font-size: 15px; }
    .empty .lbl { max-width: 54ch; margin: 0 auto; }

    /* Barre de filtre — discrète, elle ne doit pas peser autant qu'une carte. */
    .filter {
      display: flex; align-items: center; gap: 9px;
      padding: 7px 12px; margin-bottom: 14px;
      border-radius: var(--r-control);
      background: var(--void); border: 1px solid var(--line-soft);
    }
    .filter app-icon { color: var(--ink-3); }
    .filter input {
      flex: 1; min-width: 0;
      background: none; border-color: transparent; padding: 4px 2px;
      font-size: 13px;
    }
    .none { margin: 0 0 14px; text-transform: none; letter-spacing: 0; }

    /* Grille libre : la largeur de carte est fixée par le contenu qu'elle doit
       tenir — un enchaînement de quatre pastilles —, pas par un nombre de
       colonnes décidé à l'avance. */
    .grid {
      display: grid; gap: 14px;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    }
    .mac { padding: 14px 16px; display: flex; flex-direction: column; gap: 11px; }
    .mac.off { opacity: 0.55; }

    .top { display: flex; align-items: center; gap: 11px; }

    .nmbtn {
      flex: none; max-width: 220px;
      background: none; border: none; padding: 5px 4px;
      color: var(--ink); font-size: 14px; font-weight: 600; letter-spacing: -0.01em;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .nmbtn:hover { color: var(--accent-hi); }

    /* Le corps de la carte : l'enchaînement, et la zone de clic principale.
       Un bouton, pour que le clavier y arrive comme la souris. */
    .sum {
      display: flex; align-items: center; gap: 5px; flex-wrap: wrap;
      width: 100%; min-height: 46px; padding: 8px 10px;
      background: var(--void); border: 1px solid var(--line);
      border-radius: var(--r-control); cursor: pointer; text-align: left;
    }
    .sum:hover { border-color: var(--accent-dim, var(--line)); background: var(--panel-2); }
    .sum .chip {
      padding: 3px 8px; border-radius: 6px; flex: none;
      background: var(--panel-3); color: var(--ink-2);
      font-size: 11px; max-width: 130px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .sum .chip.lit { background: #17a26822; color: var(--st-armed); }
    .sum .arrow { font-size: 14px; }

    .foot { display: flex; align-items: center; gap: 6px; }

    /* La modale reprend la largeur du wizard : deux boîtes de dialogue de
       tailles différentes dans la même app, ça se remarque. */
    .modal-bg {
      position: fixed; inset: 0; z-index: 50;
      background: #07060acc; backdrop-filter: blur(5px);
      display: grid; place-items: center; padding: 24px;
      animation: fade 160ms ease-out;
    }
    @keyframes fade { from { opacity: 0 } }
    .modal {
      width: 680px; max-width: 100%; max-height: 88vh; overflow-y: auto;
      padding: 16px 18px 18px;
      border-radius: var(--r-big);
      box-shadow: var(--edge), 0 40px 90px -20px #000d;
      animation: pop 220ms var(--spring) both;
    }
    @keyframes pop { from { opacity: 0; transform: translateY(10px) scale(.985) } }
    .mhead { display: flex; align-items: center; gap: 10px; margin-bottom: 15px; }
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
  protected readonly whyLocked =
    'Calibration requise : elle est dans Réglages, et ne prend que vingt secondes.'
  protected matcher = inject(MatcherService)
  private confirm = inject(ConfirmService)
  protected readonly MIN = MACRO_MIN_STEPS
  protected readonly MAX = MACRO_MAX_STEPS

  protected readonly RECORD = '__record'

  /**
   * Macros dépliées. Repliées par défaut : une carte ouverte fait trois cents
   * pixels, et on passe l'essentiel de son temps à PARCOURIR la liste, pas à
   * régler une macro précise. La ligne repliée porte donc ce qu'on cherche en
   * parcourant — l'enchaînement, s'il y a un meme, combien d'actions.
   *
   * L'état n'est pas persisté : il est juste de la session en cours, et une
   * macro qu'on vient de créer s'ouvre d'elle-même.
   */
  /** La macro ouverte dans la modale. Un seul id : on ne règle qu'une macro à
   *  la fois, là où l'ancien dépliage en autorisait douze simultanément. */
  readonly openId = signal<string | null>(null)
  readonly openMacro = computed(() => this.store.macros().find((m) => m.id === this.openId()) ?? null)
  /** Filtre libre — nom, poses ou actions. */
  q = signal('')

  readonly visible = computed(() => {
    const needle = this.q().trim().toLowerCase()
    if (!needle) return this.store.macros()
    return this.store.macros().filter((m) => this.haystack(m).includes(needle))
  })

  /** Nom, noms des poses, étiquettes des actions : on se souvient plus souvent
   *  de ce qu'une macro FAIT que du nom qu'on lui a donné. */
  private haystack(m: MacroDef): string {
    const steps = m.steps.map((s) => this.shortName(s)).join(' ')
    const actions = this.store
      .actionsOf(m.id)
      .map((a) => describeAction(a))
      .join(' ')
    return `${m.name} ${steps} ${actions}`.toLowerCase()
  }



  /** Ouvre la modale. Une macro qu'on vient de créer s'ouvre : on la crée pour
   *  la régler, pas pour la regarder dans une grille. */
  private open(id: string): void {
    this.openId.set(id)
  }

  /** Le fond ferme, l'intérieur non — sans ce test, un clic dans la modale
   *  remonterait jusqu'au fond et la refermerait. */
  onBackdrop(ev: MouseEvent): void {
    if (ev.target === ev.currentTarget) this.openId.set(null)
  }


  /** Nom de la pose d'un maillon, ou un repère lisible si elle a disparu. */
  shortName(gestureId: string): string {
    return this.store.gestures().find((g) => g.id === gestureId)?.name ?? '— manquante —'
  }

  /** Résumé des actions, pour l'infobulle de la pastille en vue repliée. */
  actionSummary(macroId: string): string {
    return this.store
      .actionsOf(macroId)
      .map((a) => describeAction(a))
      .join('\n')
  }

  editing = signal<{ gesture: StoredGesture; binding: StoredBinding } | null>(null)
  /** Enregistrement en cours : soit tout un enchaînement, soit un seul maillon
   *  destiné à une place précise dans une macro existante. */
  recording = signal<
    { kind: 'chain' } | { kind: 'link'; macroId: string; index: number } | null
  >(null)
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
        return 'Deux fois la même pose à la suite : le temps de repos de la pose empêchera le second déclenchement.'
      }
    }
    return null
  }

  /**
   * Monte une macro à partir de poses déjà enregistrées.
   *
   * Les maillons libres passent d'abord, TOUS et dans leur ordre
   * d'enregistrement : quelqu'un qui vient d'enregistrer trois poses pour une
   * macro les a déjà désignées en les enregistrant — les lui faire re-choisir
   * une par une dans des listes déroulantes n'apporte rien. On ne retombe sur
   * des poses à meme que s'il n'y a pas assez de maillons libres.
   */
  async create(): Promise<void> {
    const free = this.store.freeLinkGestures()
    const freeIds = new Set(free.map((g) => g.id))
    // Complément : tout le reste du profil, maillons déjà employés compris —
    // réutiliser un maillon dans deux macros est parfaitement légitime.
    const rest = this.store.gestures().filter((g) => !freeIds.has(g.id))
    const steps =
      free.length >= MACRO_MIN_STEPS
        ? free.slice(0, MACRO_MAX_STEPS).map((g) => g.id)
        : [...free, ...rest].slice(0, MACRO_MIN_STEPS).map((g) => g.id)
    if (steps.length < MACRO_MIN_STEPS) return
    const id = crypto.randomUUID()
    await this.store.saveMacro({
      id,
      profileId: this.store.activeProfile()?.id ?? 'default',
      name: this.defaultName(free.length >= MACRO_MIN_STEPS ? free[0]!.name : null),
      enabled: true,
      steps,
      windowMs: MACRO_DEFAULT_WINDOW_MS,
    })
    // Une macro qu'on vient de créer s'ouvre : on la crée pour la régler.
    this.open(id)
    this.q.set('')
  }

  /**
   * « Truc ① » donne une macro nommée « Truc » : le nom a été saisi une fois, au
   * moment de l'enregistrement de l'enchaînement, autant le reprendre.
   *
   * Le chiffre cerclé est exigé — c'est LUI qui atteste que la pose vient d'un
   * enregistrement d'enchaînement. Sans cette vérification, une pose nommée
   * « poing » à la main baptiserait la macro « poing », ce qui n'a aucun sens.
   */
  private defaultName(firstLinkName: string | null): string {
    const fallback = `Macro ${this.store.macros().length + 1}`
    if (!firstLinkName || !/[①②③④]\s*$/.test(firstLinkName)) return fallback
    return firstLinkName.replace(/\s*[①②③④]\s*$/, '').trim() || fallback
  }

  /** Chemin normal : on enregistre les poses de l'enchaînement à la suite. */
  record(): void {
    this.recording.set({ kind: 'chain' })
  }

  /** Le wizard a rendu ses poses, dans l'ordre — il ne reste qu'à les relier.
   *  Le nom de la macro est celui donné au wizard, porté par les maillons. */
  async onChainRecorded(ids: string[]): Promise<void> {
    this.recording.set(null)
    if (ids.length < MACRO_MIN_STEPS) return
    const first = this.store.allGestures().find((g) => g.id === ids[0])
    // Les maillons s'appellent « <nom> ① » : on retire le chiffre cerclé pour
    // retrouver le nom que l'utilisateur a réellement tapé.
    const name = (first?.name ?? 'Macro').replace(/\s*[①②③④]\s*$/, '')
    const id = crypto.randomUUID()
    await this.store.saveMacro({
      id,
      profileId: this.store.activeProfile()?.id ?? 'default',
      name,
      enabled: true,
      steps: ids,
      windowMs: MACRO_DEFAULT_WINDOW_MS,
    })
    this.open(id)
    this.q.set('')
  }

  /** Un maillon enregistré seul vient prendre sa place dans la macro visée.
   *  C'est ce qui permet de construire un enchaînement en plusieurs fois. */
  async onLinkRecorded(gestureId: string): Promise<void> {
    const r = this.recording()
    this.recording.set(null)
    if (!r || r.kind !== 'link') return
    const m = this.store.macros().find((x) => x.id === r.macroId)
    if (!m) return
    const steps = [...m.steps]
    if (r.index >= steps.length) steps.push(gestureId)
    else steps[r.index] = gestureId
    await this.store.saveMacro({ ...m, steps })
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
    if (gestureId === this.RECORD) {
      this.recording.set({ kind: 'link', macroId: m.id, index: i })
      return
    }
    const steps = [...m.steps]
    steps[i] = gestureId
    void this.patch(m, { steps })
  }

  /**
   * Ajouter un maillon consomme d'abord un maillon LIBRE s'il en reste un —
   * il a été enregistré pour ça. Sinon on ouvre le wizard.
   *
   * Recycler une pose à meme serait le mauvais défaut : elle afficherait son
   * meme au passage de l'enchaînement, ce que personne ne demande ici.
   */
  addStep(m: MacroDef): void {
    const free = this.store.freeLinkGestures().find((g) => g.id !== m.steps.at(-1))
    if (free) {
      void this.patch(m, { steps: [...m.steps, free.id] })
      return
    }
    this.recording.set({ kind: 'link', macroId: m.id, index: m.steps.length })
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

  /** Retirer le meme d'une macro qui ne sert qu'à exécuter des actions. Sans ce
   *  bouton, une image choisie par curiosité resterait à l'écran pour toujours. */
  async detach(m: MacroDef): Promise<void> {
    await this.store.unbind(m.id)
  }

  /** L'éditeur n'a besoin que d'un nom et d'un mode d'affichage : une macro est
   *  toujours en durée fixe, elle n'a pas de notion de « pose tenue ». */
  private asGesture(m: MacroDef): StoredGesture {
    return { name: m.name, holdMode: 'fixed_duration' } as StoredGesture
  }

  async remove(m: MacroDef): Promise<void> {
    const n = this.store.actionsOf(m.id).length
    const ok = await this.confirm.ask({
      title: `Supprimer la macro « ${m.name} » ?`,
      // Les poses survivent — c'est LA question qu'on se pose avant de
      // supprimer une macro, autant y répondre sans qu'on la pose.
      body: n
        ? `Ses ${n} action(s) partent avec elle. Les poses de la macro restent dans Poses.`
        : "Les poses de la macro restent dans Poses.",
      danger: true,
    })
    if (ok) await this.store.deleteMacro(m.id)
  }
}
