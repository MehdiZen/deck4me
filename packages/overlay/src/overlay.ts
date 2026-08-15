// Overlay renderer — vanilla TS, zéro framework (un framework ici est du poids mort).
// Reçoit les WsMsg du serveur local, anime des <img>/<video> transparents.

type Anchor = 'tl' | 'tc' | 'tr' | 'ml' | 'center' | 'mr' | 'bl' | 'bc' | 'br'

interface TriggerMsg {
  type: 'trigger'
  bindingId: string
  assetUrl: string
  anchor: Anchor
  x: number
  y: number
  scale: number
  durationMs: number
  enter: 'pop' | 'fade' | 'slide'
  exit: 'fade' | 'shrink'
  layer: number
  hold: boolean
  sound?: { url: string; volume: number }
}

type WsMsg =
  | { type: 'preload'; assets: string[] }
  | TriggerMsg
  | { type: 'release'; bindingId: string }
  | { type: 'clear'; bindingId?: string }
  | { type: 'reload' }

const token = new URLSearchParams(location.search).get('t') ?? ''
const withToken = (url: string) => `${url}${url.includes('?') ? '&' : '?'}t=${token}`
const statusDot = document.getElementById('fm-status')!

// ---- Préchargement -------------------------------------------------------
// Sans préchargement le premier trigger a ~200 ms de latence de décodage et
// l'effet est raté. Pour le webm, préchargé ≠ décodé : il faut un pool de
// <video> déjà instanciés, play() puis pause() pour chauffer le décodeur.

const images = new Map<string, HTMLImageElement>()
const videoPools = new Map<string, HTMLVideoElement[]>()

function warmVideo(url: string): HTMLVideoElement {
  const v = document.createElement('video')
  v.muted = true
  v.playsInline = true
  v.preload = 'auto'
  v.src = withToken(url)
  v.addEventListener(
    'loadeddata',
    () => {
      v.play()
        .then(() => {
          v.pause()
          v.currentTime = 0
        })
        .catch(() => {})
    },
    { once: true },
  )
  return v
}

function preload(assets: string[]) {
  for (const url of assets) {
    if (url.endsWith('.webm')) {
      if (!videoPools.has(url)) videoPools.set(url, [warmVideo(url), warmVideo(url)])
    } else if (!images.has(url)) {
      const img = new Image()
      img.src = withToken(url)
      images.set(url, img)
    }
  }
}

// ---- Positionnement ------------------------------------------------------

const ANCHOR_CSS: Record<Anchor, Partial<CSSStyleDeclaration>> = {
  tl: { left: '0', top: '0' },
  tc: { left: '50%', top: '0' },
  tr: { right: '0', top: '0' },
  ml: { left: '0', top: '50%' },
  center: { left: '50%', top: '50%' },
  mr: { right: '0', top: '50%' },
  bl: { left: '0', bottom: '0' },
  bc: { left: '50%', bottom: '0' },
  br: { right: '0', bottom: '0' },
}
const ANCHOR_TRANSLATE: Record<Anchor, string> = {
  tl: '',
  tc: 'translateX(-50%)',
  tr: '',
  ml: 'translateY(-50%)',
  center: 'translate(-50%,-50%)',
  mr: 'translateY(-50%)',
  bl: '',
  bc: 'translateX(-50%)',
  br: '',
}

interface ActiveItem {
  wrapper: HTMLDivElement
  msg: TriggerMsg
  video: HTMLVideoElement | null
  timer: number | null
}
const active = new Map<string, ActiveItem[]>() // par bindingId

function takeVideo(url: string): HTMLVideoElement {
  const pool = videoPools.get(url) ?? []
  const free = pool.find((v) => v.paused && !v.dataset['busy'])
  if (free) return free
  const v = warmVideo(url)
  pool.push(v)
  videoPools.set(url, pool)
  return v
}

function show(msg: TriggerMsg) {
  const wrapper = document.createElement('div')
  wrapper.className = 'fm-item'
  Object.assign(wrapper.style, ANCHOR_CSS[msg.anchor])
  wrapper.style.zIndex = String(1000 + msg.layer)
  wrapper.style.transform = `${ANCHOR_TRANSLATE[msg.anchor]} translate(${msg.x}vw, ${msg.y}vh)`

  let media: HTMLImageElement | HTMLVideoElement
  let video: HTMLVideoElement | null = null
  if (msg.assetUrl.endsWith('.webm')) {
    video = takeVideo(msg.assetUrl)
    video.dataset['busy'] = '1'
    video.currentTime = 0
    video.loop = msg.hold // while_held : la vidéo boucle tant que la pose tient
    media = video
    const w = video.videoWidth
    if (w) media.style.width = `${w * msg.scale}px`
    video.play().catch(() => {})
  } else {
    const src = images.get(msg.assetUrl)
    media = new Image()
    ;(media as HTMLImageElement).src = src?.src ?? withToken(msg.assetUrl)
    const w = src?.naturalWidth
    if (w) media.style.width = `${w * msg.scale}px`
  }
  media.classList.add('fm-media', `fm-enter-${msg.enter}`)
  wrapper.appendChild(media)
  document.body.appendChild(wrapper)

  if (msg.sound) {
    const a = new Audio(withToken(msg.sound.url))
    a.volume = Math.min(1, Math.max(0, msg.sound.volume))
    a.play().catch(() => {})
  }

  const item: ActiveItem = { wrapper, msg, video, timer: null }
  const list = active.get(msg.bindingId) ?? []
  list.push(item)
  active.set(msg.bindingId, list)

  if (!msg.hold) {
    item.timer = window.setTimeout(() => hide(item), msg.durationMs)
  }
}

function hide(item: ActiveItem, instant = false) {
  const list = active.get(item.msg.bindingId) ?? []
  const idx = list.indexOf(item)
  if (idx >= 0) list.splice(idx, 1)
  if (item.timer !== null) clearTimeout(item.timer)

  const done = () => {
    item.wrapper.remove()
    if (item.video) {
      item.video.pause()
      item.video.currentTime = 0
      delete item.video.dataset['busy']
    }
  }
  if (instant) return done()
  const media = item.wrapper.firstElementChild as HTMLElement
  media.classList.remove('fm-enter-pop', 'fm-enter-fade', 'fm-enter-slide')
  media.classList.add(`fm-exit-${item.msg.exit}`)
  media.addEventListener('animationend', done, { once: true })
  window.setTimeout(done, 500) // filet si animationend ne part pas
}

function release(bindingId: string) {
  for (const item of [...(active.get(bindingId) ?? [])]) hide(item)
}

function clear(bindingId?: string) {
  const ids = bindingId ? [bindingId] : [...active.keys()]
  // panic : disparition immédiate, pas d'animation
  for (const id of ids) for (const item of [...(active.get(id) ?? [])]) hide(item, !bindingId)
}

// ---- WebSocket -----------------------------------------------------------

let retryMs = 1000
function connect() {
  const ws = new WebSocket(`ws://${location.host}/events?t=${token}`)
  ws.onopen = () => {
    retryMs = 1000
    statusDot.style.display = 'none'
  }
  ws.onmessage = (e) => {
    let msg: WsMsg
    try {
      msg = JSON.parse(e.data as string)
    } catch {
      return
    }
    switch (msg.type) {
      case 'preload':
        preload(msg.assets)
        break
      case 'trigger':
        show(msg)
        break
      case 'release':
        release(msg.bindingId)
        break
      case 'clear':
        clear(msg.bindingId)
        break
      case 'reload':
        location.reload()
        break
    }
  }
  ws.onclose = () => {
    statusDot.style.display = 'block'
    setTimeout(connect, retryMs)
    retryMs = Math.min(retryMs * 2, 10000)
  }
}
connect()
