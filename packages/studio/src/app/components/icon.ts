import { ChangeDetectionStrategy, Component, Input } from '@angular/core'

/**
 * Pictogrammes en trait, dessinés sur une grille de 24 et rendus à 1,6 px de
 * trait : à cette épaisseur ils tiennent le même poids optique que le texte
 * d'interface, ce qui évite l'effet « icônes collées sur une maquette ».
 * Registre local plutôt qu'une police d'icônes : quinze traits pèsent moins
 * qu'un woff de 40 ko, et rien ne part chercher un CDN à l'exécution.
 */
const PATHS: Record<string, string> = {
  live: 'M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M12 11.2a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6',
  hand: 'M9 11V5.5a1.5 1.5 0 0 1 3 0V11m0 0V4.5a1.5 1.5 0 0 1 3 0V11m0 0V6.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1a6 6 0 0 1-5.2-3l-2-3.5a1.6 1.6 0 0 1 2.7-1.7L9 15V11',
  pulse: 'M3 12h3.5L9 5l4 14 2.6-7H21',
  sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 4.5v5M9 14.5v5',
  layers: 'M12 3 3 7.5l9 4.5 9-4.5L12 3ZM3 12.5 12 17l9-4.5M3 17 12 21.5 21 17',
  play: 'M7 4.5v15l13-7.5-13-7.5Z',
  stop: 'M6.5 6.5h11v11h-11z',
  power: 'M12 3.5v8M17.7 6.8a8 8 0 1 1-11.4 0',
  zap: 'M13.5 2.5 4 14h7l-.5 7.5L20 10h-7l.5-7.5Z',
  image: 'M3.5 5.5h17v13h-17zM3.5 15l5-4 4 3.2 3.5-3 4.5 4M8.5 10a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4',
  volume: 'M4 9.5h3.5L12 5.5v13L7.5 14.5H4v-5ZM15.5 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11',
  trash: 'M4.5 6.5h15M9 6.5V4.5h6v2M6.5 6.5 7.5 20h9l1-13.5M10 10v6.5M14 10v6.5',
  plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6 6 18',
  check: 'M4.5 12.5 9.5 17.5 19.5 6.5',
  copy: 'M8.5 8.5h11v11h-11zM15.5 8.5v-4h-11v11h4',
  camera: 'M3.5 7.5h4l1.5-2.5h6L16.5 7.5h4v12h-17zM12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7',
  download: 'M12 3.5v11m0 0 4.5-4.5M12 14.5 7.5 10M4 18.5h16',
  keyboard:
    'M3 6.5h18v11H3zM6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M6.5 13.5h.01M17 13.5h.01M9.5 13.5h5',
  target: 'M12 3.5v3M12 17.5v3M3.5 12h3M17.5 12h3M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8',
  external: 'M14 4.5h5.5V10M19 5l-8 8M17.5 14v5.5h-13v-13H10',
  terminal: 'M3.5 5.5h17v13h-17zM7 10l2.5 2.5L7 15M12.5 15.5h5',
  globe: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17M3.7 9.5h16.6M3.7 14.5h16.6M12 3.5c-4 4.5-4 12.5 0 17M12 3.5c4 4.5 4 12.5 0 17',
  clock: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17M12 7v5.2l3.4 2',
  type: 'M5 6.5V5h14v1.5M12 5v14M9 19h6',
  up: 'M6 14.5 12 8.5l6 6',
  down: 'M6 9.5 12 15.5l6-6',
}

@Component({
  selector: 'app-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg
      [attr.width]="size"
      [attr.height]="size"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path [attr.d]="path" />
    </svg>
  `,
  styles: `
    :host { display: inline-flex; flex: none; }
  `,
})
export class Icon {
  @Input({ required: true }) name!: string
  @Input() size = 18

  get path(): string {
    return PATHS[this.name] ?? ''
  }
}
