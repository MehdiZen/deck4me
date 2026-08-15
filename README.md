# facememe — Gesture Overlay pour stream

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
4. Bouton **Tester** → l'image apparaît dans OBS. Sans image liée, une image de
   test intégrée est utilisée ; lie un png/gif/webp/webm via « image… ».
5. Onglet **Live** → barres de distance, états, log des triggers, bouton PANIC.

## Partager la webcam avec Streamlabs / OBS

Streamlabs capture la webcam en DirectShow **exclusif** : deux applications ne
peuvent pas l'ouvrir en même temps (test E de la phase 0, confirmé).

**Solution intégrée — la caméra virtuelle facememe.** facememe devient le seul
process qui ouvre la webcam physique, et republie le flux sous le nom
« facememe Camera » :

```
webcam physique → facememe (détection) → « facememe Camera » → Streamlabs
```

Dans **Réglages → Caméra virtuelle** :
1. « Installer » (demande une élévation admin, une seule fois — enregistre le
   filtre DirectShow via `regsvr32`).
2. Choisir la webcam physique, « Démarrer ».
3. Dans Streamlabs : source « Périphérique de capture vidéo » → **facememe Camera**.
4. Dans Réglages → Caméra (détection), choisir **facememe Camera** également.

Le voyant « Streamlabs connecté » confirme qu'une application consomme le flux.
Laisser facememe ouvert pendant le stream.

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

## Phasage

- [x] Phase 0 — Faisabilité : banc `phase0/` ; test A fait (GPU 17 ms p95 ✓, CPU ✗ 30 Hz,
      caméra bornée à 15–19 fps de nuit → refaire éclairé) ; B/B2/C/D/E à faire (protocole
      dans `phase0/README.md`)
- [x] Phase 1 — Featurizer + matcher + state machine, 27 tests
- [x] Phase 2 — Tauri + axum + overlay + WS + token + panic, 5 tests d'intégration
- [x] Phase 3 — Studio : calibration, wizard 3 prises, collision, live, binding minimal
- [ ] Phase 4 — Bindings complets : preview canvas 16:9, position/taille/durée au drag,
      son, transcodage webm alpha à l'import
- [ ] Phase 5 — Écran debug complet + latence bout-en-bout instrumentée
- [ ] Phase 6 — Profils, hotkeys globales (panic clavier), packaging signé, updater
