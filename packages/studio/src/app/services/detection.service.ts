import { Injectable, signal } from '@angular/core'
import {
  FaceLandmarker,
  FilesetResolver,
  HandLandmarker,
  type NormalizedLandmark,
} from '@mediapipe/tasks-vision'
import type { FaceAnchor, Handedness, Landmark, RawFrame } from '@meme4me/core'

export interface VizFrame {
  faceLandmarks: NormalizedLandmark[] | null
  handLandmarks: NormalizedLandmark[][]
}

export type FrameListener = (raw: RawFrame, viz: VizFrame, ts: number) => void

/** Au-delà, on cesse d'espérer et on le dit : marteler l'ouverture d'une
 *  webcam définitivement partie ne fait que brûler du CPU pendant un live. */
const MAX_RETRIES = 5

/**
 * Caméra + MediaPipe. La boucle tourne HORS de la change detection Angular :
 * les listeners (matcher, wizard, canvas live) sont appelés à ~30 Hz en direct,
 * seuls les signals (fps, statut) passent par Angular, à basse fréquence.
 * Convention verrouillée : le flux envoyé à MediaPipe n'est JAMAIS mirroré
 * (sinon la handedness ment) — le miroir est purement CSS à l'affichage.
 */
@Injectable({ providedIn: 'root' })
export class DetectionService {
  readonly running = signal(false)
  readonly status = signal<string>('caméra arrêtée')
  readonly fps = signal(0)

  /** Métrologie (phase 5), en millisecondes, lissée sur ~1 s.
   *  `inferenceMs` = les deux passes MediaPipe ; `prepMs` = réduction de la
   *  source. Ensemble ils expliquent la cadence bien mieux que le fps seul. */
  readonly inferenceMs = signal(0)
  readonly prepMs = signal(0)
  private infAcc = 0
  private prepAcc = 0

  /** Caméras disponibles + sélection persistée (localStorage). */
  readonly cameras = signal<MediaDeviceInfo[]>([])
  readonly selectedCameraId = signal<string>(localStorage.getItem('meme4me.cameraId') ?? '')

  /** MediaStream partagé avec les previews (un <video> par vue, même stream). */
  stream: MediaStream | null = null

  /** Dimensions réellement délivrées par la source (peut être du 1440p). */
  readonly sourceSize = signal<{ w: number; h: number } | null>(null)

  private video: HTMLVideoElement | null = null
  /** Toile de travail : la détection tourne TOUJOURS en petit, quelle que
   *  soit la définition de la source. Sans ça, brancher la détection sur une
   *  caméra virtuelle 720p/1440p effondre la cadence (le handoff est clair :
   *  monter au-dessus de 640 px n'améliore pas la détection et coûte cher). */
  private work: HTMLCanvasElement | null = null
  private workCtx: CanvasRenderingContext2D | null = null
  private face: FaceLandmarker | null = null
  private hand: HandLandmarker | null = null
  private listeners = new Set<FrameListener>()
  private stopped = true
  private frameCount = 0
  private lastFpsAt = 0
  private retries = 0
  private retryTimer = 0

  onFrame(fn: FrameListener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Les labels ne sont exposés qu'après une permission accordée : on sonde
   *  brièvement la caméra par défaut si rien ne tourne. */
  async listCameras(): Promise<void> {
    try {
      if (!this.stream) {
        const probe = await navigator.mediaDevices.getUserMedia({ video: true })
        probe.getTracks().forEach((t) => t.stop())
      }
    } catch {
      // permission refusée : on liste quand même (labels vides)
    }
    const devs = await navigator.mediaDevices.enumerateDevices()
    this.cameras.set(devs.filter((d) => d.kind === 'videoinput'))
  }

  /** Notifié quand la caméra choisie change, pour que le réglage aille aussi
   *  dans la base : le localStorage d'une webview peut être vidé par Windows
   *  ou par une réinstallation, la base non. */
  onCameraChange: ((deviceId: string) => void) | null = null

  /** Change de caméra, persiste, et redémarre la détection si elle tournait. */
  async selectCamera(deviceId: string): Promise<void> {
    this.selectedCameraId.set(deviceId)
    localStorage.setItem('meme4me.cameraId', deviceId)
    this.onCameraChange?.(deviceId)
    if (this.running()) {
      this.stop()
      await this.start()
    }
  }

  /** Reprend le choix persisté en base quand le localStorage est vide. */
  adoptSavedCamera(deviceId: string): void {
    if (deviceId && !this.selectedCameraId()) {
      this.selectedCameraId.set(deviceId)
      localStorage.setItem('meme4me.cameraId', deviceId)
    }
  }

  async start(): Promise<void> {
    if (this.running()) return
    clearTimeout(this.retryTimer)
    this.status.set('chargement des modèles…')
    try {
      if (!this.face || !this.hand) {
        const fileset = await FilesetResolver.forVisionTasks('/vendor/wasm')
        this.face = await FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: '/vendor/models/face_landmarker.task', delegate: 'GPU' },
          runningMode: 'VIDEO',
          numFaces: 1,
          outputFaceBlendshapes: true,
        })
        this.hand = await HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: '/vendor/models/hand_landmarker.task', delegate: 'GPU' },
          runningMode: 'VIDEO',
          numHands: 2,
        })
      }
      this.status.set('accès caméra…')
      const wanted = this.selectedCameraId()
      const base: MediaTrackConstraints = { width: 640, height: 480, frameRate: 30 }
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          video: wanted ? { ...base, deviceId: { exact: wanted } } : base,
          audio: false,
        })
      } catch (e) {
        if (!wanted) throw e
        // caméra sauvegardée débranchée/indisponible → retombe sur la défaut
        localStorage.removeItem('meme4me.cameraId')
        this.selectedCameraId.set('')
        this.stream = await navigator.mediaDevices.getUserMedia({ video: base, audio: false })
      }
      // reflète la caméra réellement obtenue + rafraîchit les labels
      const settings = this.stream.getVideoTracks()[0]?.getSettings()
      if (settings?.deviceId) this.selectedCameraId.set(settings.deviceId)
      void this.listCameras()
      const video = document.createElement('video')
      video.muted = true
      video.playsInline = true
      video.srcObject = this.stream
      await video.play()
      this.video = video
      this.stopped = false
      this.running.set(true)
      this.status.set('détection en cours')
      this.loop()
    } catch (e) {
      this.status.set(`ERREUR : ${e instanceof Error ? e.message : e}`)
      throw e
    }
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.retryTimer)
    this.retries = 0
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.video = null
    this.fps.set(0)
    this.running.set(false)
    this.status.set('caméra arrêtée')
  }

  /**
   * La caméra a disparu en cours de route. On réessaie, en espaçant : une
   * webcam reprise par Streamlabs peut se libérer quelques secondes plus tard,
   * mais marteler l'ouverture toutes les 200 ms ne fait que consommer du CPU
   * pendant que l'utilisateur stream.
   */
  private onCameraLost(): void {
    this.stopped = true
    this.stream = null
    this.video = null
    this.fps.set(0)
    this.running.set(false)
    this.retries++
    if (this.retries > MAX_RETRIES) {
      this.status.set(
        'caméra perdue — débranchée, ou prise par un autre logiciel. Relance la détection quand elle est libre.',
      )
      return
    }
    const delay = Math.min(8000, 1000 * 2 ** (this.retries - 1))
    this.status.set(`caméra perdue — nouvelle tentative dans ${Math.round(delay / 1000)} s…`)
    clearTimeout(this.retryTimer)
    this.retryTimer = window.setTimeout(() => {
      void this.start()
        .then(() => this.retries = 0)
        .catch(() => this.onCameraLost())
    }, delay)
  }

  private loop(): void {
    const video = this.video
    if (!video) return
    const DETECT_LONG_SIDE = 640

    const tick = () => {
      if (this.stopped || !this.video) return
      const ts = performance.now()

      // Perte de caméra : débranchée, ou reprise par un autre logiciel.
      // `requestVideoFrameCallback` cesse simplement d'être appelé — la boucle
      // se figeait donc en silence, en laissant « détection en cours » et la
      // dernière cadence affichées. On surveille l'état de la piste, seul
      // signal fiable, et on tente de reprendre.
      if (this.stream?.getVideoTracks()[0]?.readyState === 'ended') {
        this.onCameraLost()
        return
      }

      // Réduction de la source à ~640 px de côté long, en CONSERVANT le
      // rapport d'image : les landmarks restent normalisés sur le même cadre
      // que l'aperçu, donc les points tombent au bon endroit.
      const vw = video.videoWidth
      const vh = video.videoHeight
      if (!vw || !vh) {
        schedule()
        return
      }
      if (!this.work) {
        this.work = document.createElement('canvas')
        this.workCtx = this.work.getContext('2d', { willReadFrequently: false })
      }
      const scale = Math.min(1, DETECT_LONG_SIDE / Math.max(vw, vh))
      const dw = Math.round(vw * scale)
      const dh = Math.round(vh * scale)
      if (this.work.width !== dw || this.work.height !== dh) {
        this.work.width = dw
        this.work.height = dh
        this.sourceSize.set({ w: vw, h: vh })
      }
      this.workCtx!.drawImage(video, 0, 0, dw, dh)

      const tPrep = performance.now()
      const faceRes = this.face!.detectForVideo(this.work, ts)
      const handRes = this.hand!.detectForVideo(this.work, ts)
      const tInfer = performance.now()
      this.prepAcc += tPrep - ts
      this.infAcc += tInfer - tPrep

      // Ancre visage : situe les mains par rapport à la tête, indépendamment de
      // la distance à la caméra.
      //
      // v2 (nez + écart inter-oculaire) s'écroulait dès qu'on tournait la tête.
      // Le bout du nez est le point du visage qui se déplace le PLUS en
      // rotation — il dépasse — et l'écart entre les yeux rétrécit en
      // projection : −13 % à 30°, −29 % à 45°. La position étant divisée par
      // cette échelle, elle enflait de 41 % à main strictement immobile.
      // Symptôme vécu : le signe ne passe plus dès qu'on regarde le second
      // écran.
      //
      // v7 corrige les deux : origine entre les yeux (creux stable, ne dépasse
      // pas) et échelle prise sur la HAUTEUR du visage, front→menton, qui elle
      // ne rétrécit pas quand on tourne la tête sur le côté.
      //
      // `nose` et `scale` restent écrits pour les enregistrements d'avant, qui
      // n'ont que ce repère-là. Voir featurizePosition.
      const fl = faceRes.faceLandmarks?.[0] ?? null
      let faceAnchor: FaceAnchor | null = null
      if (fl && fl.length > 263) {
        const nose = fl[1]!
        const l = fl[33]!
        const r = fl[263]!
        faceAnchor = {
          nose: { x: nose.x, y: nose.y },
          scale: Math.hypot(r.x - l.x, r.y - l.y),
          eyes: { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 },
          height: Math.hypot(fl[152]!.x - fl[10]!.x, fl[152]!.y - fl[10]!.y),
        }
      }
      const raw: RawFrame = {
        face: faceRes.faceBlendshapes?.[0]?.categories ?? null,
        hands: (handRes.landmarks ?? []).map((lm, i) => ({
          handedness: (handRes.handedness?.[i]?.[0]?.categoryName ?? 'Right') as Handedness,
          landmarks: lm as Landmark[],
        })),
        faceAnchor,
      }
      const viz: VizFrame = {
        faceLandmarks: faceRes.faceLandmarks?.[0] ?? null,
        handLandmarks: handRes.landmarks ?? [],
      }
      for (const fn of this.listeners) fn(raw, viz, ts)

      this.frameCount++
      if (ts - this.lastFpsAt > 1000) {
        const n = this.frameCount || 1
        this.fps.set(Math.round((this.frameCount * 1000) / (ts - this.lastFpsAt || 1)))
        this.inferenceMs.set(this.infAcc / n)
        this.prepMs.set(this.prepAcc / n)
        this.infAcc = 0
        this.prepAcc = 0
        this.frameCount = 0
        this.lastFpsAt = ts
      }
      schedule()
    }
    const schedule = () => {
      if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
        video.requestVideoFrameCallback(() => tick())
      } else {
        requestAnimationFrame(() => tick())
      }
    }
    schedule()
  }
}
