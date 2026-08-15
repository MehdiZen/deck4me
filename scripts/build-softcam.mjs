// Construit le filtre DirectShow de la caméra virtuelle (vendor/softcam).
// Requiert Visual Studio Build Tools 2022 avec « Développement Desktop C++ ».
// Produit vendor/softcam/dist/bin/x64/softcam.dll, embarqué ensuite par Tauri.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const sln = join(root, 'vendor', 'softcam', 'softcam.sln')
const dll = join(root, 'vendor', 'softcam', 'dist', 'bin', 'x64', 'softcam.dll')

if (existsSync(dll) && !process.argv.includes('--force')) {
  console.log('softcam.dll déjà construit (--force pour reconstruire)')
  process.exit(0)
}
if (process.platform !== 'win32') {
  console.log('Caméra virtuelle : Windows uniquement, build ignoré')
  process.exit(0)
}

const vswhere = join(
  process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
  'Microsoft Visual Studio',
  'Installer',
  'vswhere.exe',
)
if (!existsSync(vswhere)) {
  console.error('Visual Studio Build Tools introuvables (vswhere absent).')
  console.error('Installer « Build Tools 2022 » + charge de travail C++ Desktop.')
  process.exit(1)
}

const vsPath = execFileSync(vswhere, [
  '-latest',
  '-products',
  '*',
  '-requires',
  'Microsoft.Component.MSBuild',
  '-property',
  'installationPath',
])
  .toString()
  .trim()

const msbuild = join(vsPath, 'MSBuild', 'Current', 'Bin', 'MSBuild.exe')
if (!existsSync(msbuild)) {
  console.error(`MSBuild introuvable dans ${vsPath}`)
  process.exit(1)
}

console.log('Build de softcam (Release x64, runtime statique)…')
// Runtime C++ lié statiquement : sans ça la DLL réclame le redistribuable
// Visual C++, et son enregistrement échoue en silence sur les machines qui ne
// l'ont pas. Injecté par import forcé pour ne pas toucher au code vendorisé.
const props = join(root, 'scripts', 'softcam-static-crt.props')

// Les projets de tests référencent un paquet NuGet googletest absent : ils
// échouent, sans empêcher la construction de la DLL (seule cible utile ici).
try {
  execFileSync(
    msbuild,
    [
      sln,
      '-p:Configuration=Release',
      '-p:Platform=x64',
      `-p:ForceImportAfterCppTargets=${props}`,
      '-m',
      '-v:m',
      '-nologo',
    ],
    { stdio: 'inherit' },
  )
} catch {
  /* voir ci-dessous : on juge sur la présence de la DLL */
}

if (!existsSync(dll)) {
  console.error('Échec : softcam.dll non produit')
  process.exit(1)
}

// Vérification, pas confiance : si le lien statique n'a pas pris, la DLL ne
// fonctionnera que sur les machines déjà équipées et on ne le saurait qu'au
// premier rapport d'utilisateur.
const bytes = readFileSync(dll)
const needsRedist = ['MSVCP140.dll', 'VCRUNTIME140.dll'].filter((name) =>
  bytes.includes(Buffer.from(name, 'latin1')),
)
if (needsRedist.length) {
  console.error(`✗ ${dll}`)
  console.error(
    `La DLL dépend encore du redistribuable Visual C++ (${needsRedist.join(', ')}).\n` +
      "L'enregistrement du filtre échouera sur les machines qui ne l'ont pas.",
  )
  process.exit(1)
}
console.log(`✓ ${dll} — runtime statique, aucun redistribuable requis`)
