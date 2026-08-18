import { Component, computed, inject, signal } from '@angular/core'
import { RouterLink } from '@angular/router'
import { type HoldMode } from '@deck4me/core'
import { AssetPicker } from '../components/asset-picker'
import { BindingEditor } from '../components/binding-editor'
import { Icon } from '../components/icon'
import { PoseTester } from '../components/pose-tester'
import { Wizard, type WizardMode } from '../components/wizard'
import { ConfirmService } from '../services/confirm.service'
import { MatcherService } from '../services/matcher.service'
import {
  StoreService,
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
  imports: [Wizard, RouterLink, Icon, BindingEditor, AssetPicker, PoseTester],
  template: `
    <div class="head">
      <div>
        <h1>Poses</h1>
        <p class="lbl sub">
          {{ store.gestures().length }} pose(s) dans « {{ store.activeProfile()?.name }} »
          @if (isLink()) {
            · <span class="num">{{ store.linkGestures().length }}</span> maillons
          } @else {
            · <span class="num">{{ bound() }}</span> avec un meme
          }
        </p>
      </div>
      <span class="spacer"></span>
      <button
        class="primary"
        [disabled]="!store.calibration()"
        [title]="store.calibration() ? '' : whyLocked"
        (click)="newGesture()"
      >
        <app-icon name="plus" [size]="16" />
        {{ isLink() ? 'Enregistrer un maillon' : 'Enregistrer une pose' }}
      </button>
    </div>

    <!-- Les deux familles ne partagent ni leurs réglages ni leur raison d'être :
         une pose à meme affiche quelque chose, un maillon arme un enchaînement.
         Le compteur de chaque onglet donne au passage le budget de collisions,
         qui est ce qui plafonne réellement le nombre de poses. -->
    <div class="tabs" role="tablist">
      <button
        class="tab"
        role="tab"
        [class.on]="!isLink()"
        [attr.aria-selected]="!isLink()"
        (click)="tab.set('meme')"
      >
        <app-icon name="image" [size]="15" /> Memes
        <span class="cnt">{{ store.memeGestures().length }}</span>
      </button>
      <button
        class="tab"
        role="tab"
        [class.on]="isLink()"
        [attr.aria-selected]="isLink()"
        (click)="tab.set('link')"
      >
        <app-icon name="zap" [size]="15" /> Maillons de macro
        <span class="cnt">{{ store.linkGestures().length }}</span>
      </button>

      @if (store.gestures().length > 6) {
        <span class="filter">
          <app-icon name="target" [size]="14" />
          <input
            [value]="q()"
            (input)="q.set($any($event.target).value)"
            placeholder="Filtrer…"
            aria-label="Filtrer les poses"
          />
          @if (q()) {
            <button class="ghost sm" (click)="q.set('')" aria-label="Effacer le filtre">
              <app-icon name="close" [size]="13" />
            </button>
          }
        </span>
      }
    </div>

    @if (q() && !list().length && store.gestures().length) {
      <p class="lbl none">Aucune pose ne correspond à « {{ q() }} » dans cet onglet.</p>
    }

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
    @if (store.migrationCollisions().length) {
      <div class="notice err rise">
        <app-icon name="pulse" [size]="18" />
        <div>
          <b
            >{{ store.migrationCollisions().length }} pose(s) sont devenues trop proches d'une
            autre.</b
          >
          Le dernier changement de moteur les a rapprochées au point que c'est ta précision
          d'exécution, et non la pose, qui décidera laquelle part. Réenregistre-en une, ou
          supprime-la.
          @for (c of store.migrationCollisions(); track c.id) {
            <div class="pair"><b>{{ c.name }}</b> ↔ {{ c.withName }}</div>
          }
        </div>
      </div>
    }
    @if (store.staleGestures().length) {
      <div class="notice err rise">
        <app-icon name="pulse" [size]="18" />
        <div>
          <b>{{ store.staleGestures().length }} pose(s) à réenregistrer.</b>
          Elles viennent d'une version antérieure et n'ont plus les données nécessaires.
          Utilise l'icône <b>main</b> sur la carte : la pose est refaite, le meme
          et son cadrage restent en place.
        </div>
      </div>
    }

    @if (!list().length && store.calibration()) {
      <div class="card empty">
        @if (isLink()) {
          <span class="bigmark"><app-icon name="zap" [size]="30" /></span>
          <b>Aucun maillon dans ce profil.</b>
          <p class="lbl">
            Un maillon est une pose qui n'affiche rien toute seule : elle ne sert
            qu'à armer un enchaînement. Le plus simple est de partir de
            <a routerLink="/macros">Macros</a> et d'enregistrer les poses à la
            suite ; celles créées ici restent disponibles pour n'importe quelle
            macro.
          </p>
        } @else {
          <span class="bigmark"><app-icon name="hand" [size]="30" /></span>
          <b>Aucune pose dans ce profil.</b>
          <p class="lbl">
            Vise huit à quinze poses volontaires et exagérées, lisibles à la caméra.
            Une pose que le viewer ne devine pas ne fait pas un bon bit.
          </p>
        }
      </div>
    }

    <!-- ---- Maillons : carte compacte, sans cadre OBS ni actions ----
         Un maillon n'a par définition ni meme ni action propre — le matcher ne
         le déclenche même pas seul. Lui donner la carte des gestures à meme
         afficherait quatre zones vides et un cadre OBS qui ne servira jamais. -->
    @if (isLink()) {
      <div class="links">
        @for (g of list(); track g.id) {
          <article class="card link" [class.off]="!g.enabled">
            <label class="switch">
              <input
                type="checkbox"
                [checked]="g.enabled"
                (change)="toggle(g, $event)"
                [attr.aria-label]="'Activer ' + g.name"
              />
            </label>
            <div class="lmeta">
              <!-- Champ et non libellé : un maillon enregistré depuis Macros
                   s'appelle « Truc ① », un nom de fabrication que personne ne
                   choisit et que tout le monde veut corriger. -->
              <input
                class="nm"
                [value]="g.name"
                (change)="rename(g, $any($event.target).value)"
                [attr.aria-label]="'Nom de ' + g.name"
              />
              <span class="stats lbl">
                {{ srcLabel(g.source) }} ·
                <span class="num">{{ g.rawSamples.length }}</span> prises
              </span>
              <!-- Le même réglage que sur une carte à meme, et pour la même
                   raison : un maillon qui ne part jamais n'apparaît jamais dans
                   la toile de Live, donc n'y était jamais réglable. -->
              <div class="sens">
                <span class="lbl">déclenchement</span>
                <span class="end">strict</span>
                <input
                  type="range"
                  min="0.4"
                  max="3"
                  step="0.05"
                  [value]="g.sensitivity ?? 1"
                  (input)="previewSens(g, +$any($event.target).value)"
                  (change)="commitSens(g)"
                  title="Vers la gauche, la pose doit être plus juste pour partir. Vers la droite, elle part plus facilement — et risque davantage de partir toute seule."
                  [attr.aria-label]="'Facilité de déclenchement de ' + g.name"
                />
                <span class="end">facile</span>
                <b class="num pct" [class.tuned]="(g.sensitivity ?? 1) !== 1">
                  {{ ((g.sensitivity ?? 1) * 100).toFixed(0) }}%
                </b>
                @if ((g.sensitivity ?? 1) !== 1) {
                  <button
                    class="ghost sm"
                    (click)="autoSens(g)"
                    title="Revenir au seuil mesuré à l'enregistrement"
                  >
                    auto
                  </button>
                }
              </div>
          <!-- Les deux reglages que rien ne permettait de toucher.
                   Ils sont poses une fois par le wizard et jamais revus, alors que
                   l'ecran de diagnostic designe nommement « le nombre d'images a tenir » comme
                   la cause quand une courbe plonge sous le seuil sans declencher :
                   il disait le remede sans donner le moyen. Replies, parce que la
                   plupart des poses n'en ont jamais besoin. -->
              <details class="fine">
                <summary>Réglages fins</summary>
                <label class="fl">
                  <span class="lbl">
                    Tenir la pose <b class="num">{{ g.framesToTrigger }}</b> images
                    <span class="dim">(≈ {{ (g.framesToTrigger / 30).toFixed(2) }} s)</span>
                  </span>
                  <input
                    type="range"
                    min="1"
                    max="15"
                    step="1"
                    [value]="g.framesToTrigger"
                    (input)="previewFine(g, { framesToTrigger: +$any($event.target).value })"
                    (change)="commitSens(g)"
                    [attr.aria-label]="'Images à tenir pour ' + g.name"
                  />
                </label>
                <label class="fl">
                  <span class="lbl">
                    Repos après déclenchement
                    <b class="num">{{ (g.cooldownMs / 1000).toFixed(1) }}</b> s
                  </span>
                  <input
                    type="range"
                    min="200"
                    max="5000"
                    step="100"
                    [value]="g.cooldownMs"
                    (input)="previewFine(g, { cooldownMs: +$any($event.target).value })"
                    (change)="commitSens(g)"
                    [attr.aria-label]="'Temps de repos de ' + g.name"
                  />
                </label>
                <p class="lbl hint">
                  La première règle combien de temps la pose doit être tenue avant
                  de partir : monter, c'est moins de faux départs mais une pose plus
                  longue à tenir. La seconde est le temps mort qui suit un
                  déclenchement, pendant lequel la même pose ne repart pas.
                </p>
              </details>
            </div>

            <!-- À quoi il sert : l'info qui manque le plus sur un maillon. -->
            <div class="used">
              @if (store.macrosUsing(g.id).length) {
                @for (m of store.macrosUsing(g.id); track m.id) {
                  <a class="badge ok" routerLink="/macros">{{ m.name }}</a>
                }
              } @else {
                <span class="badge warn" title="Cette pose n'arme aucun enchaînement">
                  aucune macro
                </span>
              }
            </div>

            <!-- Les deux actions qu'on vient vraiment chercher ici portent leur
                 nom. Restent en icône seule celles dont le geste est sans
                 retour possible ou purement structurel. -->
            <button
              class="sm"
              (click)="testing.set(g)"
              title="Tenir la pose devant la caméra et mesurer, en direct, si elle est reconnue"
            >
              <app-icon name="target" [size]="14" /> Vérifier ma pose
            </button>
            <button
              class="ghost sm"
              (click)="rerecord(g)"
              title="Refaire les prises en gardant sa place dans les macros"
            >
              <app-icon name="hand" [size]="15" /> Refaire
            </button>
            <button
              class="ghost sm"
              (click)="promote(g)"
              title="La pose affichera son meme toute seule, sans attendre le reste de la macro"
            >
              <app-icon name="up" [size]="15" /> Rendre autonome
            </button>
            <button class="ghost sm" (click)="remove(g)" [attr.aria-label]="'Supprimer ' + g.name">
              <app-icon name="trash" [size]="15" />
            </button>
          </article>
        }
      </div>
    }

    <div class="grid">
      @for (g of memeList(); track g.id) {
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
            <input
              class="nm"
              [value]="g.name"
              (change)="rename(g, $any($event.target).value)"
              [attr.aria-label]="'Nom de ' + g.name"
            />
            <!-- Le réglage qui n'existait nulle part.
                 Le pourcentage était AFFICHÉ ici et modifiable seulement en
                 glissant un trait sur la toile de Live — laquelle ne montre que
                 les trois poses les plus proches de ce qu'on fait à l'instant.
                 Une pose qui ne se déclenche jamais n'y entrait donc jamais :
                 exactement celle qu'on cherche à assouplir. Le wizard, lui,
                 conseillait « règle la sensibilité des deux ensuite » — une
                 promesse que rien dans l'interface ne savait tenir. -->
            <div class="sens">
              <span class="lbl">déclenchement</span>
              <span class="end">strict</span>
              <input
                type="range"
                min="0.4"
                max="3"
                step="0.05"
                [value]="g.sensitivity ?? 1"
                (input)="previewSens(g, +$any($event.target).value)"
                (change)="commitSens(g)"
                title="Vers la gauche, la pose doit être plus juste pour partir. Vers la droite, elle part plus facilement — et risque davantage de partir toute seule."
                [attr.aria-label]="'Facilité de déclenchement de ' + g.name"
              />
              <span class="end">facile</span>
              <b class="num pct" [class.tuned]="(g.sensitivity ?? 1) !== 1">
                {{ ((g.sensitivity ?? 1) * 100).toFixed(0) }}%
              </b>
              @if ((g.sensitivity ?? 1) !== 1) {
                <button
                  class="ghost sm"
                  (click)="autoSens(g)"
                  title="Revenir au seuil mesuré à l'enregistrement"
                >
                  auto
                </button>
              }
            </div>
            <div class="stats lbl">
              <span class="num">{{ g.rawSamples.length }}</span> prises
              @if (needsPosition(g)) {
                <span
                  class="badge warn"
                  title="Le repère de position de cet enregistrement ne survivait pas à une tête tournée. Il a été abandonné : cette pose est jugée sur la forme de la main seule. Réenregistre-la pour lui rendre sa position."
                >
                  sans position
                </span>
              }
            </div>
          </div>

          <!-- Information, plus commande : la bascule entre familles vit
               maintenant dans un seul bouton, en bas de carte. Deux contrôles
               pour un même drapeau, c'était un de trop.
               Ce qu'il reste ici ne se déduit d'aucun autre élément de la
               carte : cette pose sert AUSSI d'étape à une macro, donc son meme
               s'affichera au passage de l'enchaînement. -->
          @if (store.gesturesInMacros().has(g.id)) {
            <p class="chainopt lbl">
              Étape de
              @for (m of store.macrosUsing(g.id); track m.id) {
                <a class="badge ok" routerLink="/macros">{{ m.name }}</a>
              }
              — son meme s'affichera au passage de l'enchaînement. Le bouton
              <b>↓</b> la rend maillon seulement.
            </p>
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

          <!-- Les deux reglages que rien ne permettait de toucher.
               Ils sont poses une fois par le wizard et jamais revus, alors que
               l'ecran de diagnostic designe nommement « le nombre d'images a tenir » comme
               la cause quand une courbe plonge sous le seuil sans declencher :
               il disait le remede sans donner le moyen. Replies, parce que la
               plupart des poses n'en ont jamais besoin. -->
          <details class="fine">
            <summary>Réglages fins</summary>
            <label class="fl">
              <span class="lbl">
                Tenir la pose <b class="num">{{ g.framesToTrigger }}</b> images
                <span class="dim">(≈ {{ (g.framesToTrigger / 30).toFixed(2) }} s)</span>
              </span>
              <input
                type="range"
                min="1"
                max="15"
                step="1"
                [value]="g.framesToTrigger"
                (input)="previewFine(g, { framesToTrigger: +$any($event.target).value })"
                (change)="commitSens(g)"
                [attr.aria-label]="'Images à tenir pour ' + g.name"
              />
            </label>
            <label class="fl">
              <span class="lbl">
                Repos après déclenchement
                <b class="num">{{ (g.cooldownMs / 1000).toFixed(1) }}</b> s
              </span>
              <input
                type="range"
                min="200"
                max="5000"
                step="100"
                [value]="g.cooldownMs"
                (input)="previewFine(g, { cooldownMs: +$any($event.target).value })"
                (change)="commitSens(g)"
                [attr.aria-label]="'Temps de repos de ' + g.name"
              />
            </label>
            <p class="lbl hint">
              La première règle combien de temps la pose doit être tenue avant
              de partir : monter, c'est moins de faux départs mais une pose plus
              longue à tenir. La seconde est le temps mort qui suit un
              déclenchement, pendant lequel la même pose ne repart pas.
            </p>
          </details>

          <div class="acts">
            @if (asset(g)) {
              <button class="sm" (click)="edit(g)">
                <app-icon name="sliders" [size]="14" /> Régler
              </button>
            }
            <!-- Deux actions voisines, et deux libellés qui disent ce qu'ils
                 FONT plutôt que « tester ». « Tester » ne disait pas quoi : on
                 pouvait aussi bien croire qu'il éprouvait la reconnaissance,
                 et chercher ensuite la panne du mauvais côté. -->
            <button
              class="sm"
              (click)="matcher.testTrigger(g.id)"
              title="Envoie le meme dans OBS tout de suite, sans toucher à la pose"
            >
              <app-icon name="zap" [size]="14" /> Voir dans OBS
            </button>
            <button
              class="sm"
              (click)="testing.set(g)"
              title="Tenir la pose devant la caméra et mesurer, en direct, si elle est reconnue"
            >
              <app-icon name="target" [size]="14" /> Vérifier ma pose
            </button>
            <button
              class="ghost sm"
              (click)="rerecord(g)"
              title="Refaire les prises en gardant le meme, le cadrage et le son"
            >
              <app-icon name="hand" [size]="15" /> Refaire
            </button>
            <!-- Symétrique du bouton « rendre autonome » des maillons. Sans
                 lui, le passage Maillon → Meme était sans retour dès que la
                 pose n'appartenait à aucune macro. -->
            <button
              class="ghost sm"
              (click)="demote(g)"
              title="La pose reste utilisable dans une macro, mais n'affichera plus son meme toute seule"
            >
              <app-icon name="down" [size]="15" /> Maillon seulement
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
        </article>
      }
    </div>

    @if (testing(); as g) {
      <app-pose-tester [gesture]="g" (close)="testing.set(null)" />
    }
    @if (wizardOpen()) {
      <app-wizard
        [replacing]="rerecording()"
        [mode]="wizardMode()"
        (cancel)="closeWizard()"
        (saved)="closeWizard()"
      />
    }
    @if (editing(); as e) {
      <app-binding-editor
        [gesture]="e.gesture"
        [binding]="e.binding"
        [holdEditable]="true"
        (cancel)="editing.set(null)"
        (saved)="editing.set(null)"
      />
    }
  `,
  styles: `
    .head { display: flex; align-items: flex-start; gap: 14px; margin-bottom: 20px; }
    .head h1 { margin: 0 0 4px; }
    .sub { margin: 0; }

    /* Sélecteur de famille. Le compteur fait partie de l'onglet : c'est le
       nombre de poses qui plafonne tout le reste, autant l'avoir sous les yeux. */
    .tabs {
      display: flex; align-items: center; gap: 3px; margin-bottom: 18px;
      padding: 3px; border-radius: 11px;
      background: var(--void); border: 1px solid var(--line-soft);
    }
    .filter {
      display: flex; align-items: center; gap: 7px;
      flex: 1; min-width: 0; margin-left: 8px; padding-left: 10px;
      border-left: 1px solid var(--line-soft);
    }
    .filter app-icon { color: var(--ink-3); }
    .filter input {
      flex: 1; min-width: 0; max-width: 280px;
      background: none; border-color: transparent;
      padding: 5px 2px; font-size: 12.5px;
    }
    .none { margin: -6px 0 16px; text-transform: none; letter-spacing: 0; }
    .tab {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 8px 14px; border-radius: 8px;
      background: none; border: 1px solid transparent;
      color: var(--ink-3); font-size: 13px; font-weight: 520;
      transition: color 160ms var(--ease), background 160ms var(--ease);
    }
    .tab:hover { color: var(--ink-2); }
    .tab.on {
      background: var(--panel-2); border-color: var(--line);
      color: var(--ink); font-weight: 580;
      box-shadow: var(--edge);
    }
    .tab.on app-icon { color: var(--accent-hi); }
    .cnt {
      min-width: 20px; padding: 1px 6px; border-radius: 99px;
      background: var(--panel-3); color: var(--ink-2);
      font-family: var(--font-data); font-variant-numeric: tabular-nums;
      font-size: 10.5px; text-align: center;
    }
    .tab.on .cnt { background: var(--accent-wash); color: var(--accent-hi); }

    /* Maillons : une ligne chacun. Pas de cadre OBS — ils n'afficheront
       jamais rien — donc pas de raison d'occuper la surface d'une tuile. */
    .links { display: flex; flex-direction: column; gap: 8px; }
    /* Passe à la ligne plutôt que de laisser un bouton sortir de la carte. */
    .link {
      display: flex; flex-wrap: wrap; align-items: center; gap: 13px;
      padding: 11px 14px;
    }
    .link button { flex: 0 0 auto; }
    .link.off { opacity: 0.55; }
    .lmeta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
    .lmeta .nm {
      font-size: 13.5px; font-weight: 600; letter-spacing: -0.01em;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      width: 100%; max-width: 240px;
    }
    .lmeta .stats { text-transform: none; letter-spacing: 0; }
    .used { display: flex; gap: 5px; flex-wrap: wrap; justify-content: flex-end; max-width: 45%; }
    .used a { text-decoration: none; }

    .notice {
      display: flex; align-items: flex-start; gap: 11px;
      padding: 13px 16px; margin-bottom: 12px;
      border-radius: var(--r-panel); font-size: 13px; line-height: 1.55;
      border: 1px solid var(--line);
      box-shadow: var(--edge);
    }
    .notice app-icon { margin-top: 1px; }
    .notice b { font-weight: 620; }
    /* Les paires en cause, nommées : « deux poses se ressemblent » sans dire
       lesquelles obligerait à les essayer une par une. */
    .pair { margin-top: 4px; font-size: 12px; color: var(--ink-2); }
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
    /* Le nom est un champ, mais il ne doit pas EN AVOIR l'air tant qu'on ne
       le vise pas : une grille de cartes couverte de rectangles de saisie se
       lit comme un formulaire, pas comme une bibliothèque. Le cadre
       n'apparaît qu'au survol et au focus. */
    .nm {
      display: block; font-weight: 600; font-size: 14.5px; letter-spacing: -0.01em;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      width: 100%; background: none; border-color: transparent; padding: 4px 7px;
      margin-left: -7px;
    }
    .nm:hover { border-color: var(--line); background: var(--void); }
    .nm:focus { background: var(--void); }
    .stats {
      display: flex; align-items: center; flex-wrap: wrap; gap: 6px;
      margin-top: 5px; text-transform: none; letter-spacing: 0; font-size: 11.5px;
    }
    .stats .num { color: var(--ink); }

    /* Le curseur de déclenchement. Rangée unique : la carte est déjà dense, et
       ce reglage doit se lire d'un coup d'oeil sans agrandir la tuile. Les deux
       bouts sont ecrits en toutes lettres — un curseur sans extremites nommees
       ne dit pas dans quel sens il va. */
    .sens {
      display: flex; align-items: center; gap: 7px;
      margin-top: 8px; font-size: 11px;
    }
    .sens .lbl { text-transform: uppercase; letter-spacing: 0.04em; }
    .sens .end { color: var(--ink-3); font-size: 10px; white-space: nowrap; }
    .sens input[type='range'] { flex: 1; min-width: 54px; }
    .sens .pct { color: var(--ink-2); font-size: 11.5px; min-width: 34px; text-align: right; }
    .sens .pct.tuned { color: var(--accent-hi); }
    .sens button { padding: 2px 7px; font-size: 10.5px; }

    /* Repliee : la plupart des poses ne demandent jamais ces deux curseurs, et
       une carte est deja dense sans eux. */
    .fine { margin: 8px 15px 0; }
    .fine > summary {
      cursor: pointer; user-select: none;
      font-size: 11px; color: var(--ink-3); padding: 3px 0;
    }
    .fine > summary:hover { color: var(--ink-2); }
    .fl { display: flex; flex-direction: column; gap: 3px; margin-top: 7px; }
    .fl .lbl { text-transform: none; letter-spacing: 0; font-size: 11px; }
    .fl .num { color: var(--ink); }
    .fl .dim { color: var(--ink-3); }
    .fine .hint {
      margin: 8px 0 0; text-transform: none; letter-spacing: 0;
      font-size: 11px; line-height: 1.55;
    }

    /* N'apparaît que si la pose sert dans un enchaînement : hors de ce cas,
       l'option n'aurait aucun sens et n'ajouterait que du bruit. */
    .chainopt {
      display: flex; align-items: flex-start; gap: 10px;
      margin: 12px 15px 0; padding: 9px 11px;
      background: #38bdf80e; border: 1px solid #38bdf833;
      border-radius: var(--r-control);
      font-size: 12.5px; line-height: 1.5;
    }
    .chainopt .badge { margin: 0 2px; }
    .chainopt .lbl {
      display: block; margin-top: 2px;
      text-transform: none; letter-spacing: 0; font-size: 11px;
    }

    .ctrl { padding: 11px 15px 0; }
    .ctrl select { width: 100%; font-size: 12.5px; padding: 7px 28px 7px 10px; }

    /* La rangée PASSE À LA LIGNE. Sans ça, la corbeille sortait de la carte dès
       que la tuile était un peu étroite : un bouton hors du cadre n'est pas
       « discret », il est introuvable. */
    .acts { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 11px 13px 13px; }
    /* L'espaceur ne pousse que s'il reste de la place sur la ligne. Une fois le
       retour à la ligne fait, il ne doit pas créer une ligne vide. */
    .acts .spacer { flex: 1 1 0; min-width: 0; }

    .drop { margin: 0 13px 13px; }
  `,
})
export class GesturesPage {
  protected store = inject(StoreService)
  protected readonly whyLocked =
    'Calibration requise : elle est dans Réglages, et ne prend que vingt secondes.'
  protected matcher = inject(MatcherService)
  private confirm = inject(ConfirmService)
  wizardOpen = signal(false)
  /** Pose en cours d'épreuve, s'il y en a une. */
  testing = signal<StoredGesture | null>(null)
  /** Gesture dont on refait la pose ; null = création. */
  rerecording = signal<StoredGesture | null>(null)
  editing = signal<{ gesture: StoredGesture; binding: StoredBinding } | null>(null)

  /** Famille affichée. Les deux n'ont ni les mêmes réglages ni le même sens :
   *  une pose à meme affiche quelque chose, un maillon arme un enchaînement. */
  tab = signal<'meme' | 'link'>('meme')

  /** Filtre libre sur le nom. */
  q = signal('')

  readonly isLink = computed(() => this.tab() === 'link')
  readonly list = computed(() => {
    const src = this.isLink() ? this.store.linkGestures() : this.store.memeGestures()
    const needle = this.q().trim().toLowerCase()
    return needle ? src.filter((g) => g.name.toLowerCase().includes(needle)) : src
  })
  /** La grille des cartes à meme ne rend rien sur l'onglet Maillons — ceux-ci
   *  ont leur propre gabarit, sans cadre OBS. */
  readonly memeList = computed(() => (this.isLink() ? [] : this.list()))

  /** Le wizard hérite de l'onglet : enregistrer depuis « Maillons » produit
   *  directement une pose de maillon, sans case à cocher à retrouver après coup.
   *  Un réenregistrement, lui, garde la nature de la pose existante. */
  readonly wizardMode = computed<WizardMode>(() => {
    const g = this.rerecording()
    if (g) return g.sequenceOnly ? 'link' : 'gesture'
    return this.isLink() ? 'link' : 'gesture'
  })

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

  /** Rend un maillon autonome : il repasse dans Memes et pourra afficher un
   *  meme. Il reste dans ses macros — une pose peut très bien faire les deux,
   *  au prix de voir son meme apparaître au passage de l'enchaînement. */
  /**
   * Renomme une pose. Aucune des deux familles ne le permettait, alors que les
   * macros, elles, s'éditent en ligne depuis toujours.
   *
   * C'est le manque qui coûtait le plus cher aux maillons : enregistrés depuis
   * Macros, ils s'appellent « Truc ① », « Truc ② » — un nom de fabrication que
   * personne n'a choisi. Faute de pouvoir le corriger, on cliquait sur le
   * bouton voisin en espérant qu'il serve à ça.
   *
   * Un nom vide est ignoré plutôt que refusé avec un message : le champ
   * retrouve son ancienne valeur au prochain rendu, ce qui dit la même chose
   * sans rien interrompre.
   */
  async rename(g: StoredGesture, name: string): Promise<void> {
    const t = name.trim()
    if (t && t !== g.name) await this.store.saveGesture({ ...g, name: t })
  }

  async promote(g: StoredGesture): Promise<void> {
    await this.store.saveGesture({ ...g, sequenceOnly: false })
    this.tab.set('meme')
  }

  /**
   * Renvoie une pose vers les maillons. Symétrique exact de `promote`.
   *
   * L'interruptrice « Maillon seulement » existait déjà plus bas dans la
   * carte, mais seulement pour les poses employées dans une macro. Une pose
   * rendue autonome par erreur et n'appartenant à aucune macro n'avait donc
   * plus AUCUN chemin de retour : il fallait la supprimer et la réenregistrer.
   * Un aller sans retour dans une bascule à deux états est toujours un bug.
   *
   * Le meme et son cadrage sont conservés : le drapeau ne détruit rien, il
   * décide seulement si la pose s'affiche toute seule. La repromouvoir lui
   * rend son meme intact.
   */
  async demote(g: StoredGesture): Promise<void> {
    await this.store.saveGesture({ ...g, sequenceOnly: true })
    this.tab.set('link')
  }

  readonly bound = computed(
    () => this.store.memeGestures().filter((g) => this.store.binding(g.id)).length,
  )

  /** Pendant le glissement : mémoire seulement. Écrire à chaque pixel ferait
   *  des centaines d'écritures disque pour un seul réglage. */
  previewSens(g: StoredGesture, v: number): void {
    this.store.setSensitivityLocal(g.id, v)
  }

  /** Même contrat que le curseur de déclenchement : mémoire au glissement,
   *  disque au relâchement — `commitSens` sert aux deux. */
  previewFine(g: StoredGesture, patch: Partial<StoredGesture>): void {
    this.store.patchGestureLocal(g.id, patch)
  }

  /** Au relâchement : c'est là, et seulement là, qu'on écrit. */
  async commitSens(g: StoredGesture): Promise<void> {
    await this.store.persistGesture(g.id)
  }

  /** Retour au seuil mesuré à l'enregistrement. Un réglage sans chemin de
   *  retour est un piège : on n'ose plus y toucher. */
  async autoSens(g: StoredGesture): Promise<void> {
    this.store.setSensitivityLocal(g.id, 1)
    await this.store.persistGesture(g.id)
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

  /**
   * Gesture à main que la position ne peut pas distinguer d'une autre pose de
   * même forme.
   *
   * On exige `eyes`, pas seulement `faceAnchor` : le repère d'avant la v7 est
   * bien présent dans ces enregistrements, mais il partait du bout du nez et
   * se mesurait à l'écart entre les yeux — deux grandeurs qui s'effondrent dès
   * qu'on tourne la tête. Il a été abandonné, et il est irrécupérable faute
   * d'avoir persisté les points du visage. Ces poses tournent donc sur la
   * forme seule, ce que le badge doit dire.
   */
  needsPosition(g: StoredGesture): boolean {
    if (g.source === 'face') return false
    return !g.rawSamples.some((r) => r.faceAnchor?.eyes)
  }

  srcLabel(s: string): string {
    return s === 'face' ? 'visage' : s === 'hand' ? 'main' : 'visage + main'
  }

  async toggle(g: StoredGesture, ev: Event): Promise<void> {
    await this.store.saveGesture({ ...g, enabled: (ev.target as HTMLInputElement).checked })
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
    const ok = await this.confirm.ask({
      title: `Supprimer « ${g.name} » ?`,
      body: "L'enregistrement de la pose est perdu. Le meme et le son importés, eux, restent dans la bibliothèque.",
      danger: true,
    })
    if (ok) await this.store.deleteGesture(g.id)
  }
}
