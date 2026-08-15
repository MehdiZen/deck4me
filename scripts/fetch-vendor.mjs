// Récupère les binaires MediaPipe (wasm + modèles) dans les deux emplacements
// qui en ont besoin. Ils ne sont PAS versionnés : ~90 Mo dupliqués, et ils
// changent au rythme des releases MediaPipe.
//
// Le principe du handoff reste intact : rien n'est chargé depuis un CDN à
// l'exécution. C'est une étape d'installation, une fois, puis tout est local
// et embarqué dans le binaire final.
//
//   node scripts/fetch-vendor.mjs
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TASKS_VISION = '@mediapipe/tasks-vision@1.0.1'
const MODELS = {
  'face_landmarker.task':
    'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  'hand_landmarker.task':
    'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
}
// phase0 a besoin du bundle js (page HTML sans build) ; le studio l'obtient via npm.
const TARGETS = [
  { dir: 'phase0/web/vendor', bundle: true },
  { dir: 'packages/studio/public/vendor', bundle: false },
]

// fileURLToPath, pas URL.pathname : sous Windows ce dernier donne « /C:/… »
const root = fileURLToPath(new URL('..', import.meta.url))

async function main() {
  const tmp = await mkdtemp(join(tmpdir(), 'meme4me-vendor-'))
  try {
    console.log(`Téléchargement de ${TASKS_VISION}…`)
    execFileSync('npm', ['pack', TASKS_VISION, '--silent'], { cwd: tmp, shell: true })
    const tgz = `mediapipe-tasks-vision-${TASKS_VISION.split('@').pop()}.tgz`
    execFileSync('tar', ['xzf', tgz], { cwd: tmp })

    console.log('Téléchargement des modèles…')
    const models = {}
    for (const [name, url] of Object.entries(MODELS)) {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`${name} : HTTP ${res.status}`)
      models[name] = Buffer.from(await res.arrayBuffer())
      console.log(`  ${name} (${(models[name].length / 1e6).toFixed(1)} Mo)`)
    }

    for (const { dir, bundle } of TARGETS) {
      const dest = join(root, dir)
      await mkdir(join(dest, 'models'), { recursive: true })
      await cp(join(tmp, 'package', 'wasm'), join(dest, 'wasm'), { recursive: true })
      if (bundle) {
        await cp(join(tmp, 'package', 'vision_bundle.mjs'), join(dest, 'vision_bundle.mjs'))
      }
      for (const [name, bytes] of Object.entries(models)) {
        await writeFile(join(dest, 'models', name), bytes)
      }
      console.log(`✓ ${dir}`)
    }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

// Idempotent : ne retélécharge pas si tout est déjà là (sauf --force)
const complete = TARGETS.every(
  ({ dir, bundle }) =>
    existsSync(join(root, dir, 'models', 'face_landmarker.task')) &&
    existsSync(join(root, dir, 'wasm')) &&
    (!bundle || existsSync(join(root, dir, 'vision_bundle.mjs'))),
)
if (complete && !process.argv.includes('--force')) {
  console.log('Binaires MediaPipe déjà présents (--force pour retélécharger)')
} else {
  await main()
}
