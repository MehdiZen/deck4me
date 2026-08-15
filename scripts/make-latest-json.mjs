// Fabrique le manifeste `latest.json` que l'updater va chercher.
//
// Tauri produit l'installeur et sa signature, mais pas le manifeste : c'est à
// nous de dire OÙ l'installeur sera téléchargeable. On le déduit du dépôt et de
// la version, donc l'URL est juste tant que le tag de release s'appelle bien
// « v<version> » — ce que fait `gh release create v0.1.0`.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const conf = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'))
const { version, productName } = conf

const REPO = 'MehdiZen/meme4me'
const installer = `${productName}_${version}_x64-setup.exe`
const bundle = join(root, 'src-tauri/target/release/bundle/nsis')

let signature
try {
  signature = readFileSync(join(bundle, `${installer}.sig`), 'utf8').trim()
} catch {
  console.error(
    `Signature absente : ${installer}.sig\n` +
      "Le build n'a pas été signé — voir la documentation de signature",
  )
  process.exit(1)
}

// `notes` est repris tel quel dans la carte « Mise à jour » de l'app : ce que
// tu écris ici, l'utilisateur le lit avant de cliquer.
const notes = process.argv.slice(2).join(' ') || `Version ${version}`

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature,
      url: `https://github.com/${REPO}/releases/download/v${version}/${installer}`,
    },
  },
}

const out = join(bundle, 'latest.json')
writeFileSync(out, JSON.stringify(manifest, null, 2))
console.log(`latest.json → ${out}`)
console.log(`  version ${version} · ${installer}`)
console.log('\nÀ joindre à la release :')
console.log(`  gh release create v${version} \\`)
console.log(`    "${join(bundle, installer)}" \\`)
console.log(`    "${join(bundle, `${installer}.sig`)}" \\`)
console.log(`    "${out}"`)
