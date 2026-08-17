/**
 * Géométrie du pavé numérique, partagée par le widget et l'écran d'édition.
 *
 * Recopiée d'un vrai pavé et non inventée : `+` et `Entrée` font deux rangées
 * de haut, `0` deux colonnes de large. Une grille régulière serait plus simple
 * à écrire et méconnaissable à l'œil — or c'est justement la reconnaissance
 * instantanée qui fait tout l'intérêt de la chose.
 *
 * Les clés sont des codes PHYSIQUES : le code virtuel du « 1 » du pavé change
 * selon NumLock, le physique non. `0xE0xx` marque une touche étendue — `/` et
 * `Entrée` partagent leur code avec une touche du clavier principal.
 *
 * Verr.Num n'y figure pas : c'est la seule touche du pavé qui ait encore une
 * fonction, et la confisquer priverait l'utilisateur du moyen de la récupérer.
 * Le Rust a la même table dans `deck::PAD_KEYS` ; les deux doivent rester
 * d'accord, faute de quoi une touche s'affiche ici sans rien déclencher là-bas.
 */

/** touche → [colonne, rangée, largeur, hauteur] */
export const DECK_LAYOUT: Record<number, [number, number, number, number]> = {
  0xe035: [0, 0, 1, 1], // /
  0x37: [1, 0, 1, 1], // *
  0x4a: [2, 0, 1, 1], // -
  0x47: [0, 1, 1, 1], // 7
  0x48: [1, 1, 1, 1], // 8
  0x49: [2, 1, 1, 1], // 9
  0x4e: [3, 1, 1, 2], // +
  0x4b: [0, 2, 1, 1], // 4
  0x4c: [1, 2, 1, 1], // 5
  0x4d: [2, 2, 1, 1], // 6
  0x4f: [0, 3, 1, 1], // 1
  0x50: [1, 3, 1, 1], // 2
  0x51: [2, 3, 1, 1], // 3
  0xe01c: [3, 3, 1, 2], // Entrée
  0x52: [0, 4, 2, 1], // 0
  0x53: [2, 4, 1, 1], // .
}

export const DECK_LABELS: Record<number, string> = {
  0xe035: '/',
  0x37: '*',
  0x4a: '−',
  0x47: '7',
  0x48: '8',
  0x49: '9',
  0x4e: '+',
  0x4b: '4',
  0x4c: '5',
  0x4d: '6',
  0x4f: '1',
  0x50: '2',
  0x51: '3',
  0xe01c: '⏎',
  0x52: '0',
  0x53: '.',
}
