// Phase 0 — bench détection : FaceLandmarker (blendshapes) + HandLandmarker (2 mains)
// Mesure fps effectif, coût par frame, comportement en arrière-plan.
import {
  FilesetResolver,
  FaceLandmarker,
  HandLandmarker,
} from './vendor/vision_bundle.mjs'

const $ = (id) => document.getElementById(id)
const params = new URLSearchParams(location.search)
const DELEGATE = (params.get('delegate') ?? 'GPU').toUpperCase()
const HAS_RVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype

// 'both30' : face+mains chaque frame | 'both15' : tout 1 frame sur 2
// 'face15hands30' : mains chaque frame, face 1 frame sur 2
let mode = 'both30'

// Historique plat (arrays de nombres, pas d'objets : 20 min à 30 fps sans pression GC)
const H = { t: [], face: [], hand: [], dt: [] }
const CAP = 40000
let lastFrameAt = 0
let lastPresented = 0
let camFps = 0
let frameIdx = 0
const events = []

function logEvent(msg) {
  const line = `[${new Date().toTimeString().slice(0, 8)}] ${msg}`
  events.unshift(line)
  if (events.length > 30) events.pop()
  $('events').textContent = events.join('\n')
}

function percentile(arr, p) {
  if (!arr.length) return NaN
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

// Stats sur les N dernières ms
function window5s() {
  const cutoff = performance.now() - 5000
  let i = H.t.length - 1
  while (i >= 0 && H.t[i] >= cutoff) i--
  const from = i + 1
  return {
    fps: (H.t.length - from) / 5,
    face: H.face.slice(from),
    hand: H.hand.slice(from),
  }
}

async function init() {
  $('start').disabled = true
  $('status').textContent = 'Chargement wasm + modèles…'
  try {
    const gl = document.createElement('canvas').getContext('webgl2')
    $('env').textContent =
      `rVFC: ${HAS_RVFC ? 'oui' : 'NON (fallback rAF)'} | WebGL2: ${gl ? 'oui' : 'NON'}` +
      ` | delegate demandé: ${DELEGATE} | UA: ${navigator.userAgent.slice(0, 80)}`

    const fileset = await FilesetResolver.forVisionTasks('./vendor/wasm')
    const t0 = performance.now()
    const face = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: './vendor/models/face_landmarker.task', delegate: DELEGATE },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
    })
    const hand = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: './vendor/models/hand_landmarker.task', delegate: DELEGATE },
      runningMode: 'VIDEO',
      numHands: 2,
    })
    logEvent(`landmarkers créés en ${(performance.now() - t0).toFixed(0)} ms`)

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, frameRate: 30 },
      audio: false,
    })
    const video = $('cam')
    video.srcObject = stream
    await video.play()
    const track = stream.getVideoTracks()[0].getSettings()
    logEvent(`caméra: ${track.width}x${track.height}@${track.frameRate}`)

    $('status').textContent = 'En cours'
    run(video, face, hand)
    startHeartbeat()
  } catch (e) {
    $('status').textContent = 'ERREUR : ' + e.message
    console.error(e)
  }
}

function run(video, face, hand) {
  const canvas = $('overlay')
  const ctx = canvas.getContext('2d')
  const spark = $('spark').getContext('2d')
  let lastUiAt = 0

  const tick = (now, meta) => {
    frameIdx++
    const runFace = mode === 'both30' || frameIdx % 2 === 0
    const runHand = mode !== 'both15' || frameIdx % 2 === 0

    // fps caméra réel via les frames composées (rVFC uniquement)
    if (meta?.presentedFrames) {
      if (lastPresented && now > lastFrameAt) {
        camFps = ((meta.presentedFrames - lastPresented) / (now - lastFrameAt)) * 1000
      }
      lastPresented = meta.presentedFrames
    }

    if (runFace || runHand) {
      const ts = performance.now()
      let faceMs = 0
      let handMs = 0
      let faceRes = null
      let handRes = null
      if (runFace) {
        const a = performance.now()
        faceRes = face.detectForVideo(video, ts)
        faceMs = performance.now() - a
      }
      if (runHand) {
        const b = performance.now()
        handRes = hand.detectForVideo(video, ts)
        handMs = performance.now() - b
      }
      const dt = lastFrameAt ? ts - lastFrameAt : 0
      lastFrameAt = ts
      H.t.push(ts)
      H.face.push(faceMs)
      H.hand.push(handMs)
      H.dt.push(dt)
      if (H.t.length > CAP)
        for (const k of Object.keys(H)) H[k].splice(0, 8000)

      draw(ctx, canvas, faceRes, handRes)
      if (ts - lastUiAt > 250) {
        lastUiAt = ts
        updateUi(faceRes, handRes)
        drawSpark(spark)
      }
    }

    if (HAS_RVFC) video.requestVideoFrameCallback(tick)
    else requestAnimationFrame((t) => tick(t, null))
  }
  if (HAS_RVFC) video.requestVideoFrameCallback(tick)
  else requestAnimationFrame((t) => tick(t, null))
}

function draw(ctx, canvas, faceRes, handRes) {
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  if (faceRes?.faceLandmarks?.[0]) {
    ctx.fillStyle = '#4ade80'
    const pts = faceRes.faceLandmarks[0]
    for (let i = 0; i < pts.length; i += 4)
      ctx.fillRect(pts[i].x * canvas.width, pts[i].y * canvas.height, 2, 2)
  }
  if (handRes?.landmarks) {
    handRes.landmarks.forEach((lm, h) => {
      ctx.fillStyle = h === 0 ? '#60a5fa' : '#f472b6'
      for (const p of lm)
        ctx.fillRect(p.x * canvas.width - 2, p.y * canvas.height - 2, 4, 4)
    })
  }
}

function updateUi(faceRes, handRes) {
  const w = window5s()
  $('fps').textContent = w.fps.toFixed(1)
  $('camfps').textContent = camFps ? camFps.toFixed(1) : '–'
  $('facems').textContent = `${percentile(w.face, 50).toFixed(1)} / ${percentile(w.face, 95).toFixed(1)}`
  $('handms').textContent = `${percentile(w.hand, 50).toFixed(1)} / ${percentile(w.hand, 95).toFixed(1)}`
  const totals = w.face.map((f, i) => f + w.hand[i])
  $('totalms').textContent = `${percentile(totals, 50).toFixed(1)} / ${percentile(totals, 95).toFixed(1)}`

  if (faceRes?.faceBlendshapes?.[0]) {
    const top = [...faceRes.faceBlendshapes[0].categories]
      .filter((c) => c.categoryName !== '_neutral')
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((c) => `${c.categoryName} ${c.score.toFixed(2)}`)
    $('blend').textContent = top.join('  ·  ')
  }
  if (handRes?.handednesses) {
    $('hands').textContent = handRes.handednesses
      .map((h) => `${h[0].categoryName} ${h[0].score.toFixed(2)} (label brut MediaPipe, flux non mirroré)`)
      .join('  ·  ')
  } else $('hands').textContent = ''
}

function drawSpark(ctx) {
  const W = ctx.canvas.width
  const HH = ctx.canvas.height
  ctx.clearRect(0, 0, W, HH)
  const n = Math.min(300, H.t.length)
  const scale = HH / 66 // 66 ms plein cadre
  for (let i = 0; i < n; i++) {
    const idx = H.t.length - n + i
    const total = H.face[idx] + H.hand[idx]
    ctx.fillStyle = total > 33 ? '#f87171' : '#34d399'
    ctx.fillRect((i * W) / n, HH - total * scale, W / n, total * scale)
  }
  ctx.strokeStyle = '#fbbf24'
  ctx.beginPath()
  ctx.moveTo(0, HH - 33 * scale)
  ctx.lineTo(W, HH - 33 * scale)
  ctx.stroke()
}

function startHeartbeat() {
  // setInterval sera throttlé fenêtre cachée : c'est justement l'observable.
  setInterval(() => {
    const w = window5s()
    fetch('/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        t: Date.now(),
        visible: document.visibilityState,
        fps5s: w.fps,
        camFps,
        faceP50: percentile(w.face, 50),
        faceP95: percentile(w.face, 95),
        handP50: percentile(w.hand, 50),
        handP95: percentile(w.hand, 95),
        msSinceLastFrame: performance.now() - lastFrameAt,
        mode,
        delegate: DELEGATE,
        rvfc: HAS_RVFC,
      }),
    }).catch(() => {})
  }, 2000)
}

document.addEventListener('visibilitychange', () =>
  logEvent(`visibilité → ${document.visibilityState}`),
)
for (const r of document.querySelectorAll('input[name=mode]'))
  r.addEventListener('change', () => {
    mode = r.value
    logEvent(`mode → ${mode}`)
  })
$('start').addEventListener('click', init)
$('delegatelink').href = `?delegate=${DELEGATE === 'GPU' ? 'CPU' : 'GPU'}`
$('delegatelink').textContent = `passer en ${DELEGATE === 'GPU' ? 'CPU' : 'GPU'}`
