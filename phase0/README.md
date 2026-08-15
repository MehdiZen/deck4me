# Phase 0 — Faisabilité runtime

Objectif : répondre à deux questions **avant** d'écrire la moindre ligne de l'app.

1. La détection (face + 2 mains, GPU) tient-elle 15–30 fps dans un moteur Chromium
   sur cette machine, **y compris fenêtre en arrière-plan pendant qu'un jeu tourne** ?
2. OBS Browser Source rend-il correctement un webm VP8 avec alpha, sans throttling ?

Tout tourne côté **Windows** (webcam, GPU, OBS, jeu). Le serveur tourne en WSL.
Edge sur Windows utilise le même moteur que WebView2 (la webview de Tauri sur Windows) :
c'est un proxy fidèle pour la perf et le throttling. La validation dans la vraie
webview Tauri se fera au début de la phase 2 (chaîne bout en bout), qui monte Tauri de toute façon.

## Lancement

Depuis WSL :

```bash
node phase0/server.mjs
```

Puis côté Windows, ouvrir `http://localhost:47821/` **dans Edge** (pas Chrome : on veut
le moteur de WebView2). WSL2 forwarde localhost vers Windows par défaut.

> Si `localhost:47821` ne répond pas côté Windows : récupérer l'IP WSL (`hostname -I`),
> puis en PowerShell admin :
> `netsh interface portproxy add v4tov4 listenport=47821 connectaddress=<IP_WSL> connectport=47821`
> (garder `localhost` dans le navigateur — getUserMedia exige un contexte sécurisé).

## Tests

### A — Perf au premier plan
`bench.html`, delegate GPU, mode « 30 Hz tout », 2 min, en bougeant visage et mains.

| Mesure | Cible | GPU (2026-08-15) | CPU (2026-08-15) |
|---|---|---|---|
| fps détection | ≥ 28 | 17.2 (borné caméra) | 16.8 (borné compute) |
| face+mains total p95 | < 33 ms | **17 ms ✓** | 64 ms ✗ |
| fps caméra | ~30 | **15–19 ✗ (basse lumière, run de nuit)** | 19 |

Verdict compute : GPU validé (2× de marge), CPU = fallback 15 Hz uniquement.
**À refaire éclairé** : la caméra plafonnait à 15–19 fps (auto-exposition nocturne
probable), ce qui bornait la détection dans les deux runs. Confirmer 30 fps caméra
en conditions réelles de stream.

### B — Arrière-plan (le test critique)
1. Ouvrir `stats.html` dans une **autre** fenêtre, la garder visible.
2. Minimiser la fenêtre bench → observer 60 s dans stats.html.
3. Restaurer, puis **recouvrir entièrement** la fenêtre bench par une autre → 60 s.

| Situation | fps tenu ? | âge heartbeat |
|---|---|---|
| minimisée | | |
| recouverte | | |

### B2 — Arrière-plan avec flags anti-throttling
Fermer Edge complètement, relancer avec :

```bash
/mnt/c/Program\ Files\ \(x86\)/Microsoft/Edge/Application/msedge.exe --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding http://localhost:47821/bench.html
```

Refaire B. **Ces flags sont exactement ceux qu'on passera à WebView2**
(`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`) : ce résultat décide de l'archi.

### C — Impact sur le jeu
Jeu habituel avec compteur fps, en fullscreen puis borderless. Bench derrière, 10 min.

| Mesure | Sans bench | Avec bench 30 Hz | Avec bench 15 Hz |
|---|---|---|---|
| fps jeu | | | |
| fps détection (stats.html) | | | |

### D — OBS
Browser Source → `http://localhost:47821/overlay.html`, 1920×1080, 30 fps.

- [ ] Fond transparent (la scène est visible derrière les cadres)
- [ ] Danseuse webm **sans** fond noir/blanc (= VP8 alpha décodé)
- [ ] Animation et horloges fluides
- [ ] Horloges ne gèlent pas quand OBS est minimisé / la source non affichée en preview
- [ ] `AudioContext: running` sans interaction + blip audible ; tester le routage
      avec « Contrôler l'audio via OBS » coché/décoché

### E — Partage de la webcam avec OBS
En production, OBS (facecam) et l'app ouvrent la **même** webcam simultanément.
Sous Windows le frame server le permet souvent, mais pas toujours, et parfois à
framerate réduit selon le driver.

1. OBS ouvert avec la webcam en « Périphérique de capture vidéo » dans la scène.
2. En même temps, `bench.html` → Démarrer.

| Constat | Résultat |
|---|---|
| bench obtient la caméra (pas d'erreur getUserMedia) | |
| fps caméra dans le bench avec OBS actif | |
| la facecam OBS reste fluide | |

Si KO : options à arbitrer avant la phase 2 (caméra dédiée à l'app, ou
l'app expose une caméra virtuelle vers OBS, ou capture de la preview OBS).

## Grille de décision

| Constat | Conséquence |
|---|---|
| A ok, B2 ok | Archi validée telle quelle, passer en phase 1 |
| A ok, B2 KO (throttling même avec flags) | La détection ne peut pas vivre dans une fenêtre cachée → fenêtre always-on-top minimale, ou détection déplacée hors webview. **Stop, on redessine avant la phase 1** |
| A limite (>33 ms p95) | 15 Hz devient le défaut produit, 30 Hz optionnel |
| C : jeu perd >10 % fps | Idem + delegate/cadence configurables, mesure à refaire en phase 5 (écran debug) |
| D : alpha KO | Pivot format memes animés (séquence WebP/PNG, canvas) — décision avant la phase 4 |
| D : throttling OBS | Investiguer les flags CEF d'OBS avant la phase 2 |
