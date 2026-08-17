import { Component, computed, inject, signal } from '@angular/core'
import { listen } from '@tauri-apps/api/event'
import { StoreService } from '../services/store.service'
import { TauriService } from '../services/tauri.service'
import { DECK_LABELS, DECK_LAYOUT } from './deck-layout'

/**
 * Le widget : la forme du pavé numérique, et sur chaque touche ce qu'elle fera.
 *
 * ─── Pourquoi cette vue est le produit ──────────────────────────────────────
 * Le seul avantage réel d'un boîtier à 70 € n'est pas ses boutons, c'est que
 * chaque touche porte son étiquette. Un pavé numérique nu, non : on y met douze
 * actions, on en retient trois. Cette grille est la réponse logicielle à ça —
 * et donc ce qui rend défendable la phrase « plus rien à transporter ».
 *
 * ─── Ce qu'elle N'EST PAS ───────────────────────────────────────────────────
 * Pas un écran du Studio. Elle vit dans sa propre fenêtre, sans rail, sans
 * caméra, sans détection. L'aiguillage se fait dans main.ts, à l'étiquette de
 * la fenêtre, avant même de démarrer le routeur : un widget qui ferait tourner
 * un moteur de détection en arrière-plan serait une aberration.
 */

interface Cell {
  key: number
  label: string
  /** Identifiant du déclencheur posé sur la touche, s'il y en a un. */
  slotId: string | null
  col: number
  row: number
  w: number
  h: number
  name: string
  filled: boolean
  thumb: string | null
}

@Component({
  selector: 'app-deck-hud',
  template: `
    <!-- La préhension est sur l'EN-TÊTE seul : les cases, elles, se cliquent.
         Tauri n'attrape la fenêtre que si le clic tombe sur l'élément portant
         l'attribut LUI-MÊME, d'où les enfants rendus transparents au clic —
         sans quoi le point et le titre le bloquaient, et il ne restait de
         saisissable que quelques pixels de marge.
         Ce déplacement passe par la commande core:window:start-dragging, qui
         exige une capacité déclarée : sans elle, l'appel est refusé sans un
         mot, et la fenêtre paraît simplement collée. -->
    <div class="hud">
      <header data-tauri-drag-region>
        <span class="dot"></span>
        <span class="title">{{ pageName() }}</span>
        <span class="hint">{{ modOf(page()) }}</span>
      </header>


      <div class="pad">
        @for (c of cells(); track c.key) {
          <!-- Une case se déclenche à la souris comme à la touche. Ça rend le
               deck utilisable sans toucher au clavier, et ça permet d'essayer
               une case sans lâcher la souris pendant qu'on la règle. -->
          <div
            class="cell"
            [class.filled]="c.filled"
            [class.fired]="c.slotId && c.slotId === fired()"
            [style.grid-column]="c.col + 1 + ' / span ' + c.w"
            [style.grid-row]="c.row + 1 + ' / span ' + c.h"
            (click)="press(c)"
          >
            <span class="key">{{ c.label }}</span>
            @if (c.filled) {
              @if (c.thumb) {
                <img [src]="c.thumb" alt="" />
              }
              <span class="name">{{ c.name }}</span>
            }
          </div>
        }
      </div>
    </div>
  `,
  styles: `
    :host {
      display: block;
      height: 100vh;
      font-family:
        system-ui,
        -apple-system,
        Segoe UI,
        sans-serif;
      color: #e8ecf2;
      user-select: none;
      -webkit-user-select: none;
    }
    /* Verre : fond translucide, liseré de lumière en haut, bord clair.
       L'opacité tient autour de 0,86 — assez pour qu'on devine ce qu'il y a
       dessous, pas assez pour que les vignettes deviennent illisibles sur un
       fond clair. Le flou est un VRAI flou : WebView2 l'applique à ce que la
       fenêtre recouvre, la transparence de la fenêtre le lui donnant à voir.
       Les coins arrondis n'ont de sens que parce que la fenêtre est
       transparente : sinon Windows peint du blanc derrière eux. */
    .hud {
      height: 100%;
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 12px;
      border-radius: 16px;
      border: 1px solid #ffffff2b;
      background: linear-gradient(160deg, #1b2430db, #0a0e13e0);
      backdrop-filter: blur(14px) saturate(1.15);
      -webkit-backdrop-filter: blur(14px) saturate(1.15);
      box-shadow:
        inset 0 1px 0 #ffffff2e,
        0 18px 50px #00000073;
    }
    /* Les enfants laissent passer le clic jusqu'au panneau, sinon chacun
       redevient un obstacle à la préhension. */
    header > *, .cell > * {
      pointer-events: none;
    }
    header { cursor: grab; }
    header:active { cursor: grabbing; }
    .cell.filled { cursor: pointer; }
    .cell.filled:active { transform: scale(0.96); }
    header {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 0 2px;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.02em;
    }
    /* La couleur est RÉSERVÉE à ce qui se passe maintenant.
       Avant, une case occupée était turquoise en permanence : sur douze cases
       pleines, le widget devenait un aplat de couleur où plus rien ne
       ressortait — et il ne restait aucune teinte disponible pour signaler un
       déclenchement. L'occupation se dit maintenant en clarté (une case pleine
       est plus lumineuse qu'une case vide), et le turquoise ne sert plus qu'à
       deux choses : le point de l'en-tête, et l'éclair d'une case qui part. */
    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #5eead4;
      opacity: 0.75;
    }
    .hint {
      margin-left: auto;
      font-size: 10.5px;
      font-weight: 500;
      color: #94a3b8;
    }
    .pad {
      flex: 1;
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      grid-template-rows: repeat(5, 1fr);
      gap: 6px;
    }
    /* Toutes les touches gardent leur cadre, occupées ou non.
       Une case vide n'est pas un trou : c'est un emplacement libre, et le pavé
       ne se reconnaît que si sa grille est entière. */
    .cell {
      position: relative;
      overflow: hidden;
      border-radius: 10px;
      border: 1px solid #ffffff26;
      background: linear-gradient(#ffffff14, #ffffff08);
      box-shadow: inset 0 1px 0 #ffffff1f;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 2px;
      padding: 3px;
    }
    /* Le numéro de touche reste lisible même sur une case pleine : c'est lui
       qui fait le lien entre l'écran et le doigt. */
    .key {
      position: absolute;
      top: 3px;
      left: 5px;
      font-size: 9.5px;
      font-weight: 700;
      color: #64748b;
    }
    /* Occupée = plus claire. Pas plus colorée. */
    .cell.filled {
      border-color: #ffffff3d;
      background: linear-gradient(#ffffff1c, #ffffff0e);
      box-shadow: inset 0 1px 0 #ffffff30;
    }
    .cell.filled .key {
      color: #94a3b8;
    }

    /* L'éclair d'un déclenchement clavier.
       Court, et surtout DÉCROISSANT : la case s'allume d'un coup puis retombe,
       ce qui se lit du coin de l'œil sans demander qu'on regarde. Une montée
       progressive donnerait l'impression d'un retard sur la touche. */
    .cell.fired {
      animation: eclair 320ms ease-out;
    }
    @keyframes eclair {
      0% {
        border-color: #5eead4;
        background: #5eead457;
        box-shadow:
          inset 0 1px 0 #5eead46b,
          0 0 18px #5eead44d;
        transform: scale(1.05);
      }
      100% {
        border-color: #ffffff3d;
        background: #ffffff14;
        box-shadow: inset 0 1px 0 #ffffff30;
        transform: scale(1);
      }
    }
    /* Quelqu'un qui a demandé moins d'animations reçoit quand même l'accusé de
       réception : il perd le mouvement, pas l'information. */
    @media (prefers-reduced-motion: reduce) {
      .cell.fired {
        animation: eclair-sobre 320ms ease-out;
      }
      .cell.filled:active {
        transform: none;
      }
      @keyframes eclair-sobre {
        0% {
          border-color: #5eead4;
          background: #5eead457;
        }
        100% {
          border-color: #ffffff3d;
          background: #ffffff14;
        }
      }
    }
    .cell img {
      max-width: 76%;
      max-height: 46%;
      object-fit: contain;
      border-radius: 3px;
    }
    .name {
      font-size: 10px;
      line-height: 1.15;
      text-align: center;
      padding: 0 3px;
      /* Deux lignes puis coupe : un nom long ne doit pas pousser la case. */
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      color: #cbd5e1;
    }
  `,
})
export class DeckHudPage {
  private store = inject(StoreService)
  private tauri = inject(TauriService)

  /** Page affichée. Elle SUIT les modificateurs tenus : le Rust les interroge
   *  et l'annonce ici. Pas d'onglets — tenir Ctrl+Alt doit suffire à voir ce
   *  que Ctrl+Alt ferait, c'est tout l'intérêt de l'affichage. */
  protected page = signal<number>(0)

  /** Case en train de s'allumer, s'il y en a une. */
  protected fired = signal<string | null>(null)
  private flashTimer?: ReturnType<typeof setTimeout>

  constructor() {
    // Cette fenêtre n'a ni décoration ni focus : sa console n'est ouvrable par
    // personne. Elle rend donc compte dans le journal du Rust, faute de quoi
    // « le Rust a émis » et « la vue a reçu » restent indiscernables — on les a
    // déjà confondus une fois, au prix de plusieurs allers-retours.
    this.say('widget démarré')
    void this.store
      .load()
      .then(() => this.say(`base chargée — ${this.store.deckSlots().length} case(s)`))
      .catch((e) => this.say(`base illisible : ${e}`))
    void listen<number>('deck-page', (e) => this.page.set(e.payload))
    void listen<string>('deck-fired', (e) => this.flash(e.payload))
  }

  /**
   * Allume une case.
   *
   * Le passage par `null` puis une frame d'attente n'est pas décoratif : une
   * animation CSS ne redémarre pas si la classe est déjà posée. Sans ça, marteler
   * la même touche n'allumerait la case qu'une seule fois — exactement le cas où
   * on a le plus besoin de voir que ça part.
   */
  private flash(slotId: string): void {
    clearTimeout(this.flashTimer)
    this.fired.set(null)
    requestAnimationFrame(() => {
      this.fired.set(slotId)
      this.flashTimer = setTimeout(() => this.fired.set(null), 320)
    })
  }

  protected modOf(page: number): string {
    return this.store.settings().deckPageMods[page] ?? ''
  }

  /** Même chemin que l'accord clavier : une case est un déclencheur, et le
   *  Rust ne distingue pas d'où vient l'ordre. */
  protected press(c: Cell): void {
    if (!c.slotId) return
    // Allumée ici et non par le Rust : le clic passe par `gesture_fired`, qui
    // sert aussi les gestures et n'a aucune raison d'émettre vers le widget.
    // Une case qui s'allumerait à la touche mais pas au clic aurait l'air en
    // panne.
    this.flash(c.slotId)
    void this.tauri.invoke('gesture_fired', { gestureId: c.slotId }, null).catch(() => {})
  }

  private say(msg: string): void {
    void this.tauri.invoke('journal', { msg: `deck-hud — ${msg}` }, null).catch(() => {})
  }

  protected pageName = computed(
    () => this.store.settings().deckPageNames[this.page()] ?? `Page ${this.page() + 1}`,
  )

  protected cells = computed<Cell[]>(() => {
    const p = this.page()
    return Object.entries(DECK_LAYOUT).map(([k, [col, row, w, h]]) => {
      const key = Number(k)
      const slot = this.store.slotAt(p, key)
      return {
        key,
        label: DECK_LABELS[key] ?? '',
        col,
        row,
        w,
        h,
        slotId: slot?.id ?? null,
        name: slot?.name ?? '',
        filled: !!slot,
        thumb: slot ? this.thumb(slot.id) : null,
      }
    })
  })

  /** Vignette du meme posé sur la case, s'il y en a un. Une image se reconnaît
   *  plus vite qu'un nom, et c'est précisément ce qu'on vient chercher ici. */
  private thumb(slotId: string): string | null {
    const binding = this.store.bindings().find((b) => b.gestureId === slotId)
    const asset = this.store.asset(binding?.assetId)
    return asset ? this.store.assetUrl(asset) : null
  }
}

/**
 * Racine de la fenêtre du widget.
 *
 * Elle n'existe que pour porter le sélecteur `app-root`, seul élément présent
 * dans `index.html`. Sans elle, Angular ne trouve aucun hôte où s'installer et
 * ne rend RIEN — pas une erreur visible, juste une fenêtre vide. C'est
 * exactement ce qui s'est passé : le fond opaque de la feuille globale
 * s'affichait, et rien d'autre.
 */
@Component({
  selector: 'app-root',
  imports: [DeckHudPage],
  template: `<app-deck-hud />`,
  styles: `:host { display: block; height: 100vh; }`,
})
export class DeckHudRoot {}
