# meme4me — Gesture Overlay pour stream

App desktop (Tauri v2) : webcam → détection de poses visage/mains (MediaPipe) →
déclenchement de memes sur un overlay OBS via serveur local axum (port 47821).

## Lancer

Prérequis : Rust MSVC, Node ≥ 20, WebView2 (préinstallé sur Windows 11).

```bash
npm run setup        # deps + binaires MediaPipe (~90 Mo, non versionnés) + icônes
```

```bash
npm run dev          # tauri dev : compile le Rust, sert le Studio (ng serve :4200)
```

Les `.wasm` et `.task` de MediaPipe ne sont pas dans le dépôt (90 Mo dupliqués) :
`npm run vendor` les récupère une fois. Rien n'est chargé depuis un CDN à
l'exécution — l'app embarque tout, elle fonctionne hors ligne.

Build installable : `npm run build:app` → `src-tauri/target/release/` (exe + installeur NSIS
dans `target/release/bundle/nsis/`).

Tests : `npm test` (core TS, vitest) · `cargo test` dans `src-tauri/` (serveur axum).

## Premier usage

1. Onglet **Réglages** → choisir la **caméra** (persisté), puis calibration neutre
   (20 s, garde tes lunettes de stream).
2. Copier l'**URL overlay** → OBS → Source Navigateur 1920×1080.
3. Onglet **Gestures** → enregistrer une pose (3 prises de 2 s).
4. Lier une image (png/gif/webp/webm) → l'**éditeur de rendu** s'ouvre : glisse le
   meme dans le cadre 16:9, tire le coin pour la taille, choisis les effets et le son.
   Sans image liée, le bouton **Tester** utilise une image de test intégrée.
5. Onglet **Live** → barres de distance, états, log des triggers, bouton PANIC.
6. Onglet **Debug** → chaîne de latence étage par étage et historique des distances
   quand une pose refuse de déclencher.

### Rendu d'un meme

Tout est exprimé en **proportions du cadre** : `x`/`y` sont le centre de l'élément
en % du cadre, `sizePct` sa largeur en % de la largeur du cadre. Le même binding
rend donc identiquement quelle que soit la taille de la source de navigateur OBS.
Les bindings du modèle v1 (ancre + décalages + `scale` relatif aux pixels natifs)
sont convertis une fois au chargement — `packages/core/src/render.ts`, couvert par
`test/render.test.ts`.

Aimantation au centre, aux tiers et aux marges de 5 % ; **Alt** enfoncé pour un
placement libre.

### Son

mp3, wav ou ogg, attachés au binding. Le binding ne stocke qu'un identifiant
d'asset : l'URL jetonnée est fabriquée côté Rust au moment du trigger, elle ne
transite jamais par la base. Dans OBS, coche **« Contrôler l'audio via OBS »** sur
la source navigateur, sinon le son sort de ton casque et pas du stream.

> Pas de transcodage à l'import. Un webm à canal alpha doit être encodé en VP9
> avec alpha avant import ; un mp4 ou un mov ne sont pas acceptés. Embarquer
> ffmpeg pour convertir coûterait ~80 Mo dans l'installeur — un arbitrage à
> trancher, pas une omission.

### Profils et raccourcis

Un **profil** est un jeu de gestures armées : « Just Chatting » et « en jeu » ne
veulent pas les mêmes poses. Seul le profil actif est chargé dans le matcher ;
le sélecteur est dans le rail de gauche.

Les **raccourcis globaux** (Réglages) fonctionnent sans que meme4me ait le focus.
Le panic est traité côté Rust : l'overlay est vidé même si la webview est occupée.
Windows accorde un raccourci au premier demandeur — si OBS ou Discord l'ont déjà,
l'échec est affiché plutôt qu'avalé.

## Partager la webcam avec Streamlabs / OBS

Streamlabs capture la webcam en DirectShow **exclusif** : deux applications ne
peuvent pas l'ouvrir en même temps (test E de la phase 0, confirmé).

**Solution intégrée — la caméra virtuelle meme4me.** meme4me devient le seul
process qui ouvre la webcam physique, et republie le flux sous le nom
« meme4me Camera » :

```
webcam physique → meme4me (détection) → « meme4me Camera » → Streamlabs
```

Dans **Réglages → Caméra virtuelle** :
1. « Installer » (demande une élévation admin, une seule fois — enregistre le
   filtre DirectShow via `regsvr32`).
2. Choisir la webcam physique, « Démarrer ».
3. Dans Streamlabs : source « Périphérique de capture vidéo » → **meme4me Camera**.
4. Dans Réglages → Caméra (détection), choisir **meme4me Camera** également.

Le voyant « Streamlabs connecté » confirme qu'une application consomme le flux.
Laisser meme4me ouvert pendant le stream.

Implémentation : `src-tauri/src/virtualcam.rs` — capture Media Foundation
(nokhwa) côté Rust, republication via le filtre DirectShow
[softcam](https://github.com/tshino/softcam) (MIT, vendorisé dans `vendor/`,
`FriendlyName` renommé). Le CLSID du filtre est verrouillé par un test.

Alternatives sans installer de filtre : SplitCam (gratuit), la caméra virtuelle
d'OBS Studio réglée sur *source* et non sur scène, ou une deuxième webcam.

## Architecture

```
vendor/softcam     filtre DirectShow (MIT) pour la caméra virtuelle — à builder
                   avec MSBuild : softcam.sln, Release x64
packages/core      featurizer + matcher + state machine (TS pur, vitest)
packages/overlay   renderer overlay vanilla TS → bundlé en 1 html, embarqué dans le Rust
packages/studio    Angular 20 zoneless (hors workspace npm), MediaPipe vendoré dans public/
src-tauri          shell Tauri v2 + axum (overlay, /assets, WS /events, token) + store JSON
phase0/            banc de faisabilité autonome (voir phase0/README.md)
```

Points d'archi verrouillés (handoff + review 2026-08-15) :
- OBS Browser Source = process séparé → serveur HTTP local + WS obligatoires. [FIGÉ]
- Contrat `TriggerEvent` en camelCase, dupliqué TS/serde, verrouillé par test Rust. [FIGÉ]
- Featurizer versionné ; les **frames brutes** sont persistées avec chaque gesture et la
  calibration → changement de version ou de baseline = re-featurisation silencieuse au boot.
  « À réenregistrer » n'est que le fallback sans données brutes.
- Baseline neutre par utilisateur (biais morphologique + lunettes), soustraite partout.
  Subset visage SANS eyeLook* (regard + lunettes = bruit).
- Distance euclidienne RMS normalisée par dimension (cosinus rejeté : vecteurs tous
  positifs → dynamique écrasée). Seuil auto homogène en distances, avec plancher.
- Hystérésis de sortie ×1.4, state machine PAR gesture. [FIGÉ]
- Wizard en 3 prises séparées ; collision refusée en nommant la gesture ; test
  anti-faux-positifs contre la calibration (parole normale).
- Token de session sur toute la surface OBS + vérif Origin sur l'upgrade WS
  (127.0.0.1 n'est pas une frontière de sécurité pour un navigateur).
- Flux MediaPipe jamais mirroré (handedness) ; miroir CSS à l'affichage uniquement.
- MediaPipe wasm + modèles vendorés en local, jamais de CDN. [FIGÉ]
- Flags WebView2 anti-throttling posés au boot (leçon phase 0, test B2).
- Store JSON versionné en Rust — déviation assumée vs SQLite+Drizzle : volume minuscule,
  migrations = match sur schemaVersion. Révisable si le schéma explose.

## Publier une version

L'app embarque `tauri-plugin-updater`. Le manifeste est cherché à
`https://github.com/MehdiZen/meme4me/releases/latest/download/latest.json` et sa
signature est vérifiée avec la clé publique inscrite dans `tauri.conf.json`.

La **clé privée** vit hors du dépôt, dans `<dossier-des-cles>\` (voir le
`LISEZ-MOI.md` du dossier pour le mot de passe). **À sauvegarder ailleurs** :
sans elle, plus aucune mise à jour ne peut être signée pour les installations
existantes — il faudrait faire réinstaller tout le monde à la main.

> ⚠️ Cette machine a un `TAURI_SIGNING_PRIVATE_KEY` **global**, hérité du projet
> monitor4me. Il gagne sur `TAURI_SIGNING_PRIVATE_KEY_PATH` : sans l'écraser
> explicitement, meme4me se signerait avec la clé de monitor4me et l'updater
> rejetterait la mise à jour chez tous les utilisateurs. D'où le `$env:` ci-dessous.

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content <dossier-des-cles> -Raw).Trim()
$env:TAURI_SIGNING_PRIVATE_KEY_PATH = ''
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '<mot-de-passe>'
npm run build:app
node scripts/make-latest-json.mjs "Ce qui change dans cette version."
```

Produit, dans `src-tauri/target/release/bundle/nsis/` : l'installeur, son `.sig`,
et `latest.json`. Les trois sont à joindre à la release GitHub — le script
affiche la commande `gh release create` toute faite. Le texte passé au script est
celui que l'utilisateur lira dans la carte « Mise à jour » avant de cliquer.

> **Le dépôt est privé.** Les assets d'une release privée exigent une
> authentification : l'updater recevra un 404 tant que le dépôt n'est pas public
> (ou que l'endpoint ne pointe pas vers un hébergement ouvert). Le mécanisme est
> en place et signé ; c'est la visibilité du dépôt qui décide.

### Signature Authenticode

Non faite : elle exige un certificat de signature de code (~300 €/an, ou un
certificat EV pour éviter la période de réputation SmartScreen). Sans elle,
Windows affiche « Éditeur inconnu » à l'installation. Pour l'activer une fois le
certificat obtenu, ajouter dans `tauri.conf.json` sous `bundle.windows` :

```json
"certificateThumbprint": "<empreinte SHA1 du certificat>",
"digestAlgorithm": "sha256",
"timestampUrl": "http://timestamp.digicert.com"
```

## Phasage

- [x] Phase 0 — Faisabilité : banc `phase0/` ; test A fait (GPU 17 ms p95 ✓, CPU ✗ 30 Hz,
      caméra bornée à 15–19 fps de nuit → refaire éclairé) ; B/B2/C/D/E à faire (protocole
      dans `phase0/README.md`)
- [x] Phase 1 — Featurizer + matcher + state machine, 27 tests
- [x] Phase 2 — Tauri + axum + overlay + WS + token + panic, 5 tests d'intégration
- [x] Phase 3 — Studio : calibration, wizard 3 prises, collision, live, binding minimal
- [x] Phase 4 — Bindings complets : éditeur 16:9, position/taille au drag, effets
      d'entrée/sortie, durée, calque, son. **Sauf** le transcodage webm alpha à
      l'import (ffmpeg non embarqué — voir « Son » plus haut)
- [x] Phase 5 — Écran Debug : chaîne de latence par étage, aller-retour réel jusqu'au
      navigateur OBS (accusé WS), historique des distances sur 20 s, rapport copiable
- [x] Phase 6 — Profils, raccourcis globaux, updater signé. **Sauf** la signature
      Authenticode (certificat requis — voir « Publier une version »)
