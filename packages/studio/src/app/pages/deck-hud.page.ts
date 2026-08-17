import { Component, computed, inject, signal } from '@angular/core'
import { listen } from '@tauri-apps/api/event'
import { StoreService } from '../services/store.service'
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
    <div class="hud" [class.idle]="page() === null">
      <header>
        <span class="dot"></span>
        <span class="title">{{ pageName() }}</span>
        @if (page() === null) {
          <span class="hint">maintiens une touche de page</span>
        }
      </header>

      <div class="pad">
        @for (c of cells(); track c.key) {
          <div
            class="cell"
            [class.filled]="c.filled"
            [style.grid-column]="c.col + 1 + ' / span ' + c.w"
            [style.grid-row]="c.row + 1 + ' / span ' + c.h"
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
    /* Fond volontairement translucide et non opaque : le widget se superpose à
       un jeu ou à OBS, et masquer une bande de 340 px pendant qu'on cherche une
       touche est plus gênant que la chercher. */
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
    /* Effet verre.
       backdrop-filter adoucit ce qui est DANS la page, pas le bureau derrière
       — une fenêtre transparente ne donne pas accès à ce qu'il y a dessous. Le
       verre est donc peint : dégradé translucide, liseré de lumière en haut,
       bord clair. À l'œil ça tient ; techniquement rien n'est flouté. */
    .hud {
      height: 100%;
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 12px;
      border-radius: 16px;
      border: 1px solid #ffffff2b;
      background:
        linear-gradient(160deg, #1b2430b8, #0a0e13d1);
      backdrop-filter: blur(18px) saturate(150%);
      -webkit-backdrop-filter: blur(18px) saturate(150%);
      box-shadow:
        inset 0 1px 0 #ffffff2e,
        0 18px 50px #000000a6;
      transition: opacity 0.12s ease;
    }
    /* Aucune page tenue : le widget ne s'affiche que si l'utilisateur l'a
       épinglé. Il s'efface alors pour dire qu'il n'attend rien. */
    .hud.idle {
      opacity: 0.45;
    }
    header {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 0 2px;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.02em;
    }
    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #5eead4;
      box-shadow: 0 0 8px #5eead4a0;
    }
    .idle .dot {
      background: #64748b;
      box-shadow: none;
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
    .cell.filled {
      border-color: #5eead45c;
      background: linear-gradient(#5eead42b, #5eead414);
      box-shadow:
        inset 0 1px 0 #5eead43d,
        0 0 14px #5eead41f;
    }
    .cell.filled .key {
      color: #5eead4;
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

  /** Page tenue en ce moment. `null` = aucune. */
  protected page = signal<number | null>(null)

  constructor() {
    void this.store.load()
    // Le Rust est seul à savoir quelle touche est enfoncée : il n'existe aucun
    // moyen pour une webview sans focus de l'apprendre autrement.
    void listen<number | null>('deck-page', (e) => this.page.set(e.payload))
  }

  protected pageName = computed(() => {
    const p = this.page()
    if (p === null) return 'Deck'
    return this.store.settings().deckPageNames[p] ?? `Page ${p + 1}`
  })

  protected cells = computed<Cell[]>(() => {
    const p = this.page()
    return Object.entries(DECK_LAYOUT).map(([k, [col, row, w, h]]) => {
      const key = Number(k)
      const slot = p === null ? null : this.store.slotAt(p, key)
      return {
        key,
        label: DECK_LABELS[key] ?? '',
        col,
        row,
        w,
        h,
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
