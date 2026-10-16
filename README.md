# deck4me

[Version française](README.fr.md)

Download the installer from the [latest release](https://github.com/MehdiZen/deck4me/releases/latest). Windows may show an "Unknown publisher" warning, so choose "More info", then "Run anyway".

deck4me is a Windows desktop app for streamers. It reads your webcam, recognizes poses of your face and hands, and fires a meme (an image, an animation or a sound) on your stream when you hold a pose. Everything runs on your machine, the detection model is bundled and nothing is sent to a server.

The app is built with Tauri v2. A local axum server feeds an overlay page that you add to OBS as a browser source. The interface is written in French.

## Features

- Pose detection for the face (26 selected blendshapes) and the hands, with MediaPipe running locally and offline.
- A recording wizard that learns a pose from three short takes, refuses two poses that are too close, and checks the result against your normal speech.
- A per pose sensitivity slider, and a live view that shows the distance to each pose while you move.
- A meme editor for the position, the size, the entry and exit effects, the duration and an optional sound. It accepts png, gif, webp, avif, jpg and webm, and it can cut out a plain background.
- Image import from a file or from a pasted web address, with guards against local network probing.
- Macros that chain two to four poses in a short window, so that sensitive actions never fire by accident.
- Actions attached to a macro to open a file or a link, run a program, send a keyboard shortcut, type text, call an HTTP endpoint, or wait.
- Profiles, global hotkeys and a panic button that clears the overlay at once.
- A keyboard deck on the numeric keypad, with its own widget.
- A virtual camera named "deck4me Camera", built on the Softcam DirectShow filter, so that the webcam can be shared between deck4me and Streamlabs or OBS. Memes can also be drawn on that camera for Discord or Zoom.
- A Streamer mode and a Control mode, and signed automatic updates.

## Demo

![Demo of the deck4me interface](docs/media/demo.gif)

The recording is also available as an [MP4 file](docs/media/demo.mp4). It was made by running the studio front end in Chromium with a simulated Tauri backend and a synthetic camera, with fictional poses and memes. It does not show the native app, a real webcam or any personal data. The captions are in French, like the interface.

## Requirements

- Windows 10 or 11, with WebView2 (preinstalled on Windows 11).
- Node.js 20 or later.
- Rust with the MSVC toolchain.
- Visual Studio Build Tools 2022 with the "Desktop development with C++" workload, only to build the virtual camera filter.
- A network connection once, to download the MediaPipe files (about 90 MB, not stored in the repository).

## Installation

```bash
npm run setup
npm --prefix packages/studio install
```

The first command installs the workspace dependencies, downloads the MediaPipe files, generates the icons and builds the virtual camera filter. The second installs the dependencies of the studio, which is not part of the npm workspace.

To build the installer:

```bash
npm run build:app
```

The installer is written to `src-tauri/target/release/bundle/nsis/`. The build is signed, see the releases section below.

## Development

```bash
npm run dev
```

This runs `tauri dev`, which builds the Rust side and serves the studio on port 4200.

The scripts defined in the root `package.json` are the following.

| Script | What it does |
| --- | --- |
| `npm run setup` | Installs dependencies, MediaPipe files, icons and the softcam build. |
| `npm run vendor` | Downloads the MediaPipe wasm files and models. |
| `npm run icons` | Generates the Tauri icons and the default test image. |
| `npm run softcam` | Builds the virtual camera filter with MSBuild. |
| `npm run dev` | Starts the app in development mode. |
| `npm run dev:front` | Builds the overlay and serves the studio alone, without Tauri. |
| `npm run build:front` | Builds the overlay and the studio. |
| `npm run build:app` | Builds the signed installer. |
| `npm test` | Runs the unit tests of the core package with vitest. |

Other useful commands:

```bash
npm run build -w @deck4me/core
npm --prefix packages/studio run build
cargo test --manifest-path src-tauri/Cargo.toml
```

The first one type checks the core package and the second builds the studio. Running the studio alone in a browser works, but the Tauri commands are then unavailable and the interface only shows empty data.

### Releases

Updates are signed. The build script reads the path of the signing key from the `DECK4ME_SIGNING_KEY` environment variable, and the key password from `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The private key and its password are kept outside the repository and must never be committed. After a build, `node scripts/make-latest-json.mjs "Release notes"` writes the `latest.json` manifest that the updater downloads.

## Repository layout

```
packages/core      pose featurizer, matcher, state machine and macros, in plain TypeScript with tests
packages/overlay   the overlay page for OBS, bundled into one HTML file and embedded in the Rust binary
packages/studio    the Angular interface of the app
src-tauri          the Tauri shell, the local server, the action engine and the virtual camera pump
vendor/softcam     the Softcam DirectShow filter, under the MIT license
scripts            setup, vendoring, icon, softcam and release scripts
phase0             a standalone browser bench used to validate the detection approach
docs/media         the demo recording
```

## License

Copyright (c) 2026 Mehdi Zenati. deck4me is **source-available** under a dual license. It is free for personal non-commercial use, and a paid license is required for commercial and professional use. See [LICENSE](LICENSE) for the exact terms. Third-party libraries keep their own licenses, including Softcam in [vendor/softcam](vendor/softcam/LICENSE).
