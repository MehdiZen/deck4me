import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { DeckHudRoot } from './app/pages/deck-hud.page';
import { getCurrentWindow } from '@tauri-apps/api/window';

/**
 * Reprise des préférences locales d'avant le renommage en deck4me.
 *
 * Ces clés portent le choix de webcam et l'état « caméra masquée ». Perdre le
 * second ne coûte qu'un clic ; perdre le premier fait redémarrer sur la
 * mauvaise caméra, et sur une machine qui en a trois, c'est l'app qui a l'air
 * cassée.
 *
 * Doit tourner AVANT bootstrapApplication : DetectionService lit
 * `deck4me.cameraId` à l'initialisation de son champ, donc dès sa
 * construction. Copie et non déplacement, pour qu'un retour à l'ancienne
 * version retrouve ses réglages.
 */
for (const key of ['cameraId', 'hideVideo']) {
  const old = localStorage.getItem(`meme4me.${key}`);
  if (old !== null && localStorage.getItem(`deck4me.${key}`) === null) {
    localStorage.setItem(`deck4me.${key}`, old);
  }
}

/**
 * Le widget du deck vit dans sa propre fenêtre, et n'est PAS un écran du
 * Studio : ni rail, ni routeur, ni caméra, ni détection.
 *
 * L'aiguillage se fait ici, avant le démarrage, et non par une route : passer
 * par le routeur ferait construire le composant racine, qui réveille la
 * détection. Un widget qui ferait tourner un second moteur MediaPipe en fond
 * coûterait les images par seconde qu'on vient tout juste de récupérer.
 *
 * Reconnu à l'ÉTIQUETTE de la fenêtre et non à une requête d'URL : Tauri traite
 * l'URL d'une fenêtre comme un chemin de fichier, un `?` s'y fait échapper et la
 * page ne se charge plus. Une fenêtre transparente qui ne charge rien est
 * rigoureusement invisible, et sans la moindre erreur nulle part.
 */
const isDeck = '__TAURI_INTERNALS__' in window && getCurrentWindow().label === 'deck-hud';

if (isDeck) {
  // Le fond opaque de la feuille globale ET le halo ambiant sont posés sur
  // <body> : sans ça, une fenêtre déclarée transparente s'affiche pleine et
  // carrée. C'est le composant qui peint son propre cadre.
  document.documentElement.style.background = 'transparent';
  document.body.style.background = 'transparent';
  document.body.classList.add('deck-window');
}

bootstrapApplication(isDeck ? DeckHudRoot : App, appConfig)
  .catch((err) => console.error(err));
