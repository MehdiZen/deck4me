// Phase 0 — serveur statique + collecte de heartbeats du bench.
// Zéro dépendance. Lancer : node server.mjs   →  http://localhost:47821/
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, normalize, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('./web', import.meta.url))
const PORT = Number(process.env.PORT ?? 47821)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.webm': 'video/webm',
  '.map': 'application/json',
}

// Ring des derniers heartbeats reçus du bench (page visible ou non).
const beats = []

function hhmmss(t = Date.now()) {
  return new Date(t).toTimeString().slice(0, 8)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')

  if (req.method === 'POST' && url.pathname === '/heartbeat') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      try {
        const b = JSON.parse(body)
        b.serverReceived = Date.now()
        beats.push(b)
        if (beats.length > 600) beats.splice(0, 100)
        console.log(
          `[${hhmmss(b.serverReceived)}] fps=${b.fps5s?.toFixed?.(1) ?? '?'} ` +
            `face p95=${b.faceP95?.toFixed?.(1) ?? '?'}ms hand p95=${b.handP95?.toFixed?.(1) ?? '?'}ms ` +
            `vis=${b.visible} mode=${b.mode} delegate=${b.delegate}`,
        )
      } catch {
        /* heartbeat malformé, ignoré */
      }
      res.writeHead(204).end()
    })
    return
  }

  if (url.pathname === '/stats') {
    res.writeHead(200, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify({ serverNow: Date.now(), beats: beats.slice(-120) }))
    return
  }

  // Statique
  let p = url.pathname === '/' ? '/index.html' : url.pathname
  const file = normalize(join(ROOT, p))
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end()
    return
  }
  try {
    const data = await readFile(file)
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      // COOP/COEP inutiles ici : pas de SharedArrayBuffer en phase 0
    })
    res.end(data)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('404 ' + p)
  }
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Phase 0 — serveur prêt`)
  console.log(`  Bench détection : http://localhost:${PORT}/bench.html`)
  console.log(`  Moniteur externe: http://localhost:${PORT}/stats.html`)
  console.log(`  Overlay OBS     : http://localhost:${PORT}/overlay.html`)
})
