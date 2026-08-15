// Bundle l'overlay en UN fichier html autonome (inliné), embarqué ensuite
// dans le binaire Rust via include_str!.
import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const js = await build({
  entryPoints: ['src/overlay.ts'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'chrome100', // CEF d'OBS
  write: false,
})

const template = await readFile('src/template.html', 'utf8')
const html = template.replace('<!--SCRIPT-->', `<script>${js.outputFiles[0].text}</script>`)
await mkdir('dist', { recursive: true })
await writeFile('dist/overlay.html', html)
console.log(`overlay.html: ${(html.length / 1024).toFixed(1)} Ko`)
