// Prépare target/release à recevoir softcam.dll, et ramasse ce qu'un build
// précédent a dû laisser derrière lui.
//
// ─── Le problème ────────────────────────────────────────────────────────────
// Tauri copie vendor/softcam/dist/bin/x64/softcam.dll vers target/release à
// chaque build. Si le filtre est enregistré et chargé — OBS ouvert, ou l'app
// elle-même en train de tourner — Windows a le fichier mappé en mémoire et la
// copie échoue avec « os error 32 », ce qui tue le build.
//
// ─── Le contournement, et son piège ─────────────────────────────────────────
// Windows refuse de SUPPRIMER un fichier mappé mais accepte de le RENOMMER :
// on pousse l'ancien de côté, la copie retrouve un chemin libre, et le
// processus qui l'utilisait continue de travailler sur son inode.
//
// Le piège, c'est que ce fichier écarté ne disparaît jamais tout seul. Fait à
// la main build après build, ça donne exactement ce qu'on a eu : six
// `softcam.locked.*.dll` de 215 Ko empilés dans target/release.
//
// D'où l'ordre ici : on BALAIE D'ABORD, on écarte ensuite. Le balayage
// récupère les fichiers des builds passés, dont les processus sont morts
// depuis. Il en reste au plus un en permanence — celui réellement mappé
// maintenant — au lieu d'une collection qui grossit.
//
// Toutes les suppressions sont best-effort : un échec ici ne doit jamais faire
// tomber le build, le balayage suivant repassera derrière.
import { existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const src = join(root, 'vendor', 'softcam', 'dist', 'bin', 'x64', 'softcam.dll')

/** Les deux préfixes déjà semés dans la nature : `softcam.locked.*` (ce
 *  script) et `softcam.old-*` (une improvisation antérieure). Le second n'est
 *  plus produit par personne, mais des copies traînent chez qui a construit
 *  avant ce script — on les ramasse aussi. */
const isLeftover = (n) => n.startsWith('softcam.locked.') || n.startsWith('softcam.old-')

/** Vrai si supprimé (ou déjà absent), faux si Windows le tient encore. */
function tryRemove(path) {
  try {
    rmSync(path, { force: true })
    return true
  } catch {
    return false
  }
}

let swept = 0
let held = 0

for (const dir of [join(root, 'src-tauri', 'target', 'release'), join(root, 'target', 'release')]) {
  if (!existsSync(dir)) continue

  for (const name of readdirSync(dir)) {
    if (!isLeftover(name)) continue
    if (tryRemove(join(dir, name))) swept++
    else held++
  }

  // Le softcam.dll en place, lui, n'est écarté que s'il résiste à la
  // suppression : sans ça on créerait un fichier parqué à CHAQUE build, y
  // compris les fois où rien ne le verrouillait.
  const dst = join(dir, 'softcam.dll')
  if (!existsSync(dst) || !existsSync(src)) continue
  if (statSync(dst).size === statSync(src).size) continue // déjà à jour, on n'y touche pas
  if (tryRemove(dst)) continue

  const parked = join(dir, `softcam.locked.${Date.now()}.dll`)
  try {
    renameSync(dst, parked)
    console.log(`softcam.dll verrouillé, écarté vers ${parked} (nettoyé au prochain build)`)
  } catch (e) {
    console.error(`softcam.dll verrouillé et impossible à écarter : ${e.message}`)
    console.error('Fermer OBS et meme4me, puis relancer le build.')
    process.exit(1)
  }
}

if (swept) console.log(`softcam : ${swept} résidu(s) de build nettoyé(s)`)
if (held) console.log(`softcam : ${held} résidu(s) encore mappé(s), repris au prochain build`)
