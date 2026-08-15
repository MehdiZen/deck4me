// Génère les icônes Tauri (PNG + ICO) et l'image de test par défaut,
// sans aucune dépendance : encodeur PNG minimal (zlib node + CRC32 maison).
import { deflateSync } from 'node:zlib'
import { mkdir, writeFile } from 'node:fs/promises'

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function png(w, h, pixelFn) {
  const raw = Buffer.alloc(h * (1 + w * 4))
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0 // filtre none
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = pixelFn(x, y)
      raw.set([r, g, b, a], y * (1 + w * 4) + 1 + x * 4)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr.set([8, 6, 0, 0, 0], 8) // 8 bits, RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
function icoFromPng(pngBuf) {
  // format ICO Vista+ : PNG embarqué tel quel
  const header = Buffer.from([0, 0, 1, 0, 1, 0])
  const entry = Buffer.alloc(16)
  entry.set([0, 0, 0, 0, 1, 0, 32, 0]) // 256x256, 32bpp
  entry.writeUInt32LE(pngBuf.length, 8)
  entry.writeUInt32LE(22, 12)
  return Buffer.concat([header, entry, pngBuf])
}

// Icône : fond ardoise arrondi, bulle cyan + bulle rose qui "pop"
function iconPixel(size) {
  const r1 = size * 0.34
  const c1 = [size * 0.42, size * 0.55]
  const r2 = size * 0.2
  const c2 = [size * 0.68, size * 0.32]
  const radius = size * 0.18
  return (x, y) => {
    const inRound =
      Math.min(x, size - 1 - x) > radius ||
      Math.min(y, size - 1 - y) > radius ||
      Math.hypot(
        Math.max(0, radius - Math.min(x, size - 1 - x)),
        Math.max(0, radius - Math.min(y, size - 1 - y)),
      ) <= radius
    if (!inRound) return [0, 0, 0, 0]
    if (Math.hypot(x - c2[0], y - c2[1]) < r2) return [244, 114, 182, 255]
    if (Math.hypot(x - c1[0], y - c1[1]) < r1) return [56, 189, 248, 255]
    return [15, 23, 42, 255]
  }
}

// Image de test par défaut (binding absent) : cadre rose "TEST" en damier alpha
function testMemePixel(w, h) {
  return (x, y) => {
    const border = x < 8 || y < 8 || x >= w - 8 || y >= h - 8
    if (border) return [244, 114, 182, 255]
    const checker = (Math.floor(x / 24) + Math.floor(y / 24)) % 2 === 0
    return checker ? [56, 189, 248, 230] : [15, 23, 42, 200]
  }
}

await mkdir('src-tauri/icons', { recursive: true })
await mkdir('src-tauri/embedded', { recursive: true })
const icon256 = png(256, 256, iconPixel(256))
await writeFile('src-tauri/icons/icon.png', icon256)
await writeFile('src-tauri/icons/128x128.png', png(128, 128, iconPixel(128)))
await writeFile('src-tauri/icons/32x32.png', png(32, 32, iconPixel(32)))
await writeFile('src-tauri/icons/icon.ico', icoFromPng(icon256))
await writeFile('src-tauri/embedded/test-meme.png', png(320, 180, testMemePixel(320, 180)))
console.log('icônes générées')
