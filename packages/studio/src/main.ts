import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

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

bootstrapApplication(App, appConfig)
  .catch((err) => console.error(err));
