import { Component, Input, computed, signal } from '@angular/core'
import { RouterLink } from '@angular/router'

/**
 * Affiche une liste de noms sans plafond dans un encombrement constant : le
 * premier nom, deux feuilles empilées derrière, un compte, la liste au survol.
 *
 * Le premier nom reste visible parce que c'est souvent le seul qui existe —
 * une pastille qui ne dirait que « 3 » obligerait à survoler pour savoir de
 * quoi on parle.
 */
@Component({
  selector: 'app-chip-stack',
  imports: [RouterLink],
  template: `
    @if (items.length === 1) {
      <a class="badge ok one" [routerLink]="link" [title]="items[0]">{{ items[0] }}</a>
    } @else if (items.length > 1) {
      <a class="stack" [routerLink]="link" [title]="full()" [attr.aria-label]="full()">
        <!-- Deux feuilles au plus : au-delà, l'empilement ne se lit plus comme
             une épaisseur mais comme un bord flou, et c'est le compte qui
             porte l'information de toute façon. -->
        @if (items.length > 2) {
          <span class="sheet far" aria-hidden="true"></span>
        }
        <span class="sheet near" aria-hidden="true"></span>
        <span class="badge ok front">
          <span class="nm">{{ items[0] }}</span>
          <span class="n">{{ items.length }}</span>
        </span>
      </a>
    }
  `,
  styles: `
    :host { display: inline-block; vertical-align: middle; }

    .one {
      max-width: 15ch;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      text-decoration: none;
    }

    /* La marge reserve la place ou les feuilles depassent : sans elle, elles
       mordraient sur le voisin de gauche et sur la ligne du dessus. */
    .stack {
      position: relative; display: inline-flex;
      margin: 5px 5px 0 0; text-decoration: none;
    }
    .sheet {
      position: absolute; inset: 0;
      border-radius: 999px;
      border: 1px solid #17a26855;
      background: var(--panel-2);
      box-shadow: inset 0 0 0 99px #17a26814;
    }
    .sheet.near { transform: translate(3px, -3px); }
    .sheet.far { transform: translate(6px, -6px); opacity: 0.6; }

    .front { position: relative; display: inline-flex; align-items: center; gap: 6px; }
    .nm {
      max-width: 13ch;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    /* Le compte est une pastille, pas un mot : il se lit sans etre lu. */
    .n {
      flex: none;
      min-width: 15px; height: 15px; padding: 0 4px;
      border-radius: 999px;
      display: inline-grid; place-items: center;
      background: #17a268; color: #04140c;
      font-family: var(--font-data); font-size: 9.5px; font-weight: 700;
      line-height: 1;
    }

    .stack:hover .sheet.near { transform: translate(4px, -4px); }
    .stack:hover .sheet.far { transform: translate(8px, -8px); opacity: 0.75; }
    .sheet { transition: transform 140ms var(--ease), opacity 140ms var(--ease); }
    @media (prefers-reduced-motion: reduce) {
      .sheet { transition: none; }
    }
  `,
})
export class ChipStack {
  /** Les noms, dans l'ordre. Le premier est celui qu'on montre. */
  @Input({ required: true }) set items(v: string[]) {
    this.list.set(v ?? [])
  }
  get items(): string[] {
    return this.list()
  }
  /** Ce que le survol annonce avant la liste. */
  @Input() lead = 'Utilisée par'
  @Input() link = '/macros'

  private readonly list = signal<string[]>([])

  /** Une par ligne : au-delà de trois noms, une énumération sur une seule
   *  ligne d'infobulle déborde de l'écran et se coupe. */
  protected readonly full = computed(
    () => `${this.lead} (${this.list().length}) :\n${this.list().map((n) => `· ${n}`).join('\n')}`,
  )
}
