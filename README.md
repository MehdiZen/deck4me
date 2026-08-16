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
3. Onglet **Gestures** → enregistrer une pose (3 prises de 2 s). L'icône **main**
   sur une carte **refait la pose** sans rien toucher d'autre : le meme, son
   cadrage, son son et sa sensibilité restent en place. C'est la façon de
   corriger une pose qui déclenche mal, et de repasser une vieille gesture au
   featurizer courant sans avoir à relier son image.
4. Lier une image — fichier, **adresse web collée**, ou reprise d'une image déjà
   importée → l'**éditeur de rendu** s'ouvre : glisse le meme dans le cadre 16:9,
   tire le coin pour la taille, choisis les effets et le son. Sans image liée, le
   bouton **Tester** utilise une image de test intégrée.
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

### Formats acceptés

Images : **png, gif, webp, avif, jpg**. Vidéo : **webm** (alpha si le fichier a été
encodé en VP9 avec canal alpha). Sons : **mp3, wav, ogg**.

Le format est toujours décidé sur les **octets d'en-tête**, jamais sur l'extension :
le nom vient de l'utilisateur, les octets viennent du fichier. Piège traité au
passage : un JPEG commence par `0xFF`, comme une trame MPEG audio — c'est le
second octet qui tranche, sans quoi toute image JPEG atterrirait dans la
bibliothèque de sons.

Le **JPEG n'a pas de canal alpha** : il arrive dans OBS avec son fond. Il est
accepté quand même (beaucoup de memes fonctionnent en rectangle assumé) mais
signalé dans l'éditeur, qui propose le détourage. Convertir un JPEG en PNG ne
sert à rien : le PNG *peut* porter de la transparence, il n'en fabrique pas.

Le mp4 et le mov sont refusés — pas de canal alpha exploitable par le navigateur
d'OBS.

### Détourage de fond

Dans l'éditeur de rendu, **Détourer le fond** échantillonne la couleur des quatre
coins et rend transparent tout pixel qui s'en approche, avec une bande de
transition douce pour éviter les contours en escalier. Clic dans l'aperçu pour
choisir une autre couleur de référence.

Ses limites, affichées dans l'interface : un fond dégradé ou de la même couleur
que le sujet ne peut pas être distingué, et un JPEG très compressé laisse un
liseré autour des contours. Les formats animés (gif, webm) sont exclus — un canvas
n'en voit que la première image, et détourer y remplacerait l'animation par un PNG
fixe. L'original est toujours conservé : le détourage crée une nouvelle image.

### Import par URL

Coller l'adresse d'une image l'importe directement. Le téléchargement se fait
côté Rust, pas dans la webview : la webview se ferait refuser la moitié des liens
par CORS, et surtout coller une URL ne doit pas revenir à faire sonder son réseau
local par l'app. D'où les garde-fous de `src-tauri/src/fetch.rs`, couverts par
`tests/import_test.rs` : protocoles limités à http/https, refus des adresses
privées et de bouclage (y compris déguisées en IPv6), refus des redirections et
des URL à identifiants, plafond de 25 Mo appliqué à la lecture et pas seulement
d'après l'en-tête déclaré.

### Son

mp3, wav ou ogg, attachés au binding. Le binding ne stocke qu'un identifiant
d'asset : l'URL jetonnée est fabriquée côté Rust au moment du trigger, elle ne
transite jamais par la base. Dans OBS, coche **« Contrôler l'audio via OBS »** sur
la source navigateur, sinon le son sort de ton casque et pas du stream.

> Pas de transcodage à l'import. Un webm à canal alpha doit être encodé en VP9
> avec alpha avant import ; un mp4 ou un mov ne sont pas acceptés. Embarquer
> ffmpeg pour convertir coûterait ~80 Mo dans l'installeur — un arbitrage à
> trancher, pas une omission.

### Ce qui est retenu entre deux lancements

Caméra de détection, webcam republiée, définition diffusée : tout est persisté
dans la base, plus rien à recliquer avant un stream. Deux options de reprise
automatique (décochées par défaut, parce qu'allumer une webcam sans qu'on l'ait
demandé n'est pas anodin) : **démarrer la détection au lancement** dans Réglages →
Caméra de détection, et **reprendre la caméra virtuelle au lancement** dans sa
carte.

La webcam republiée est retenue par **nom** et non par index : un index change
dès qu'un périphérique est branché ou débranché, et on rouvrirait alors la
mauvaise caméra sans rien dire. Si la définition retenue n'existe plus sur la
caméra choisie, on retombe sur « automatique » plutôt que d'échouer à l'ouverture.

### Macros — enchaînements de poses

Un enchaînement (« poing puis trois doigts ») déclenche un meme comme une pose
simple. Ce n'est pas qu'un confort : **le nombre de poses distinguables est
fini**. Le seuil d'une gesture est plafonné par sa distance à sa voisine la plus
proche, donc plus on en ajoute, plus les seuils se resserrent — au-delà d'une
douzaine, le wizard refuse tout. Deux poses parmi six donnent trente
combinaisons sans rien ajouter à distinguer. Les macros lèvent le plafond.

Second usage : **une séquence ne part jamais par accident**. Deux gestes
volontaires d'affilée sont hors d'atteinte d'une gesticulation ordinaire — c'est
donc là que doivent aller les actions qu'on ne confierait jamais à une pose
seule.

La fenêtre se mesure **entre deux maillons consécutifs**, pas depuis le début :
un enchaînement de trois poses n'est pas plus dur à réussir qu'un de deux.
Implémentation dans `packages/core/src/sequence.ts`, 14 tests.

#### Enregistrer les poses de l'enchaînement

Une macro n'est pas obligée de recycler des poses qui ont déjà un meme. Deux
chemins depuis l'écran Macros :

- **Enregistrer un enchaînement** — le chemin normal. Le wizard fait faire les
  2 à 4 poses **à la suite dans une seule session** (3 prises chacune), puis crée
  les gestures *et* la macro qui les relie. Rien n'est écrit avant la fin :
  abandonner au maillon 2 ne laisse ni demi-macro ni gesture orpheline.
- **Depuis mes poses** — compose l'enchaînement à partir de gestures existantes.

Un maillon peut aussi s'ajouter **plus tard**, un à la fois : le bouton
« + Maillon » et l'option « ＋ Enregistrer une nouvelle pose… » de chaque liste
déroulante ouvrent le wizard et glissent la pose obtenue à la bonne place.

#### Les deux familles de poses ne se mélangent pas

`sequenceOnly` n'est pas un détail de réglage, c'est **la frontière entre deux
familles** qui n'ont ni les mêmes réglages ni le même sens : une pose à meme est
une fin en soi, un maillon n'existe que pour armer un enchaînement. L'écran
Gestures a donc deux onglets, **Memes** et **Maillons de macro**, chacun avec son
compteur — c'est le nombre de poses qui plafonne tout le reste.

Le maillon a son propre gabarit de carte : pas de cadre OBS ni de liste
d'actions (le matcher ne le déclenche même pas seul), mais la liste des macros
qui s'en servent, et un bouton pour le rendre autonome. Basculer le drapeau
déplace la carte d'un onglet à l'autre — le classement est réversible.

Deux surfaces gardent volontairement les deux familles : **Live**, où l'on règle
la sensibilité en regardant la barre réagir, et **Debug**. Les y masquer voudrait
dire qu'une macro qui ne part pas n'a plus aucun endroit où se diagnostiquer.
Elles y sont **groupées, jamais entrelacées**.

Les poses créées depuis Macros naissent **« maillon seulement »**. Trois
conséquences voulues :

- le mode « tant que tenue » disparaît — un maillon se lit sur un déclenchement,
  pas sur une durée ;
- l'avertissement « ressemble à ta tête en parlant » devient une information et
  non un reproche : un faux positif sur un maillon isolé ne déclenche rien, il
  faut la pose suivante dans la foulée ;
- **mais chaque maillon compte toujours dans le budget de collisions.** C'est la
  contrepartie honnête : l'argument « les macros lèvent le plafond » ne vaut que
  pour les enchaînements composés de poses réutilisées. Des poses dédiées coûtent
  exactement ce qu'elles coûteraient ailleurs. Elles ont en échange le droit
  d'être moins appuyées.

La détection de collision compare le maillon en cours **aux maillons déjà pris
dans la même session**, qui ne sont pas encore en base — sans quoi deux poses
indistinguables du même enchaînement passeraient sans un mot.

### Actions — faire faire des choses à la machine

Afficher un meme est **un cas particulier**. Le cas général : un déclencheur
(gesture *ou* macro, indifféremment) porte une **chaîne d'actions**, exécutée
dans l'ordre. Une macro peut n'avoir aucun meme et ne servir qu'à ça.

| Genre | Ce que ça fait | Ce que ça ouvre comme usages |
| --- | --- | --- |
| **Ouvrir** | `ShellExecuteW` — ce que ferait un double-clic | une app, un dossier, un site, ou un lien applicatif : `spotify:playlist:…`, `steam://`, `obsidian://` |
| **Exécuter** | lance un programme avec des arguments | scripts PowerShell / Python / batch |
| **Raccourci** | envoie un accord clavier au système | **la passerelle universelle** — OBS, Discord, Streamlabs écoutent des raccourcis globaux ; Spotify et VLC répondent à `MediaPlayPause` |
| **Taper** | frappe une chaîne, en Unicode | commandes de chat |
| **HTTP** | GET/POST/PUT/DELETE avec en-têtes et corps | webhook Discord, Home Assistant, pont Hue, Streamer.bot, obs-websocket |
| **Attendre** | pause | espacer deux actions de la même chaîne |

Le raccourci clavier est le point d'entrée le plus rentable : il ne demande
d'intégration à personne. Donner à OBS un raccourci global sur `F13` (touche qui
existe et n'a aucune contrepartie physique, donc zéro collision) suffit à piloter
une scène depuis un geste.

**Ce qui est délibéré :**

- **Aucun shell.** `Exécuter` reçoit un programme et un tableau d'arguments — un
  par ligne — jamais une ligne de commande à redécouper. C'est ce redécoupage qui
  fabrique les injections de commande, et son absence veut dire qu'un chemin avec
  des espaces n'a besoin d'aucun guillemet.
- **Le réseau local est autorisé pour HTTP**, contrairement à l'import d'image
  (`fetch.rs`) qui le refuse. La différence n'est pas technique mais de
  provenance : là-bas l'URL vient d'un collage, ici de la configuration de
  l'utilisateur — et la moitié des usages intéressants sont précisément locaux.
- **Un budget de lancement glissant** (20 processus / 10 s, global). Une gesture
  au seuil trop permissif peut partir plusieurs fois par seconde ; sans plafond,
  « ouvrir Notepad » devient une bombe à processus.
- **Une seule chaîne à la fois par déclencheur.** Sinon deux exécutions
  s'entrelaceraient dans le désordre.
- **Les échecs remontent dans le journal des triggers** de l'écran Live, pas
  seulement dans le fichier de log. Une action qui ne part pas silencieusement,
  c'est une heure perdue à chercher du côté d'OBS.

**Sur la sécurité.** Oui, ceci exécute des programmes arbitraires. Ce n'est pas
une élévation de privilège : la configuration vit dans `db.json`, et tout ce qui
peut écrire ce fichier peut déjà exécuter du code sous ton compte. Le vrai risque
est ailleurs — **le jour où un profil s'importera depuis l'extérieur, ses actions
ne devront jamais suivre en silence.** Il n'existe aucun import aujourd'hui ;
c'est une contrainte à tenir si on en ajoute un.

Deux limites inhérentes à l'injection clavier, à connaître : elle part dans la
fenêtre **active** (sauf raccourci global, que l'app destinataire reçoit sans
focus), et Windows la bloque si la fenêtre au premier plan tourne en
administrateur alors que meme4me non — l'erreur le dit explicitement.

Implémentation : `packages/core/src/action.ts` (14 tests) et
`src-tauri/src/actions.rs` (14 tests, dont la table des touches vérifiée contre
son propre analyseur). La table des noms de touches vit côté Rust et l'interface
la lit par la commande `key_names` : deux listes à maintenir, c'est deux listes
qui divergent, et l'écart ne se verrait qu'au moment où le raccourci ne part pas.

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
                   actions.rs : moteur d'actions (ouvrir / exécuter / clavier / HTTP)
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
- Une macro n'a **pas** de chemin de déclenchement propre : son binding et ses actions
  portent son identifiant dans `gestureId` / `ownerId`. `gesture_fired(id)` sert les deux
  sans un seul cas particulier — et `build_trigger`, ne trouvant pas de gesture, en déduit
  correctement qu'il n'y a pas de mode « tenu ».
- Les actions ne passent **jamais** par un shell (programme + argv), et la table des noms
  de touches fait autorité côté Rust, lue par l'interface via `key_names`.

## Caméra virtuelle et redistribuable

`softcam.dll` est compilée avec le **runtime C++ lié statiquement**
(`scripts/softcam-static-crt.props`, injecté par `scripts/build-softcam.mjs`).
Sans ça la DLL réclame `MSVCP140.dll` et `VCRUNTIME140.dll`, c'est-à-dire le
redistribuable Visual C++ : sur une machine qui ne l'a pas, le `regsvr32` de
l'installeur échoue et l'utilisateur voit « pilote absent » sans la moindre
indication, puis ne trouve jamais « meme4me Camera » dans Streamlabs. Le mode
d'échec est silencieux et porte justement sur la fonctionnalité qui demande une
élévation administrateur.

Le script **vérifie** après compilation que la DLL n'importe plus ces deux
bibliothèques, et échoue sinon — un lien statique qui saute sans prévenir ne se
verrait qu'au premier rapport d'utilisateur.

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
