// Construit l'installeur signé. À utiliser au lieu de `tauri build` direct.
//
// ─── Pourquoi ce script existe ──────────────────────────────────────────────
// Cette machine porte un `TAURI_SIGNING_PRIVATE_KEY` GLOBAL, hérité du projet
// monitor4me, et une variable d'environnement gagne toujours sur
// `TAURI_SIGNING_PRIVATE_KEY_PATH`. Un `tauri build` nu part donc avec la
// mauvaise clé, chiffrée avec un mot de passe qu'il n'a pas.
//
// Et il ne le dit pas : il affiche « expect a prompt for password » puis
// ATTEND sur l'entrée standard. Lancé depuis un terminal dont la sortie est
// tuyautée, le prompt reste invisible et le build a l'air de compiler. Il a
// tenu vingt minutes comme ça avant qu'on regarde le journal — la compilation,
// elle, avait pris 1 min 39.
//
// D'où les deux règles ici :
//  1. la clé du projet est imposée EN CONTENU, et `..._PATH` est vidé, sinon
//     l'héritage machine reprend la main ;
//  2. l'entrée standard est fermée. Si Tauri veut malgré tout un mot de passe,
//     il échoue tout de suite au lieu d'attendre pour toujours. Un build qui
//     casse en dix secondes vaut mieux qu'un build qui ment pendant vingt
//     minutes.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

/** La clé vit HORS du dépôt, à dessein : elle ne doit jamais partir dans un
 *  commit. Surchargeable pour construire depuis une autre machine. */
const keyFile = process.env['MEME4ME_SIGNING_KEY'] ?? ''

if (!existsSync(keyFile)) {
  console.error(`Clé de signature introuvable : ${keyFile}`)
  console.error('Définir MEME4ME_SIGNING_KEY, ou voir la documentation de signature')
  process.exit(1)
}

const env = {
  ...process.env,
  TAURI_SIGNING_PRIVATE_KEY: readFileSync(keyFile, 'utf8').trim(),
  // Vidé et non supprimé : Tauri lit la variable telle quelle, et une chaîne
  // vide se distingue d'un héritage machine.
  TAURI_SIGNING_PRIVATE_KEY_PATH: '',
  // Le mot de passe ne protège rien tout seul — sans le fichier de clé, qui
  // n'est pas dans le dépôt, il n'ouvre rien. Il est déjà écrit dans le README
  // pour cette raison. Surchargeable pour une clé différente.
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD:
    process.env['TAURI_SIGNING_PRIVATE_KEY_PASSWORD'] ?? '',
}

const r = spawnSync('npm', ['run', 'tauri', '--', 'build', ...process.argv.slice(2)], {
  cwd: root,
  env,
  shell: true,
  stdio: ['ignore', 'inherit', 'inherit'], // stdin fermé : voir règle 2
})
process.exit(r.status ?? 1)
