import { Injectable, signal } from '@angular/core'
import {
  FaceLandmarker,
  FilesetResolver,
  HandLandmarker,
  type NormalizedLandmark,
} from '@mediapipe/tasks-vision'
import type { FaceAnchor, Handedness, Landmark, RawFrame } from '@facememe/core'

export interface VizFrame {
  faceLandmarks: NormalizedLandmark[] | null
  handLandmarks: NormalizedLandmark[][]
}

export type FrameListener = (raw: RawFrame, viz: VizFrame, ts: number) => void

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

  /** Caméras disponibles + sélection persistée (localStorage). */
  readonly cameras = signal<MediaDeviceInfo[]>([])
  readonly selectedCameraId = signal<string>(localStorage.getItem('facememe.cameraId') ?? '')

  /** MediaStream partagé avec les previews (un <video> par vue, même stream). */
  stream: MediaStream | null = null

  private video: HTMLVideoElement | null = null
  private face: FaceLandmarker | null = null
  private hand: HandLandmarker | null = null
  private listeners = new Set<FrameListener>()
  private stopped = true
  private frameCount = 0
  private lastFpsAt = 0

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

  /** Change de caméra, persiste, et redémarre la détection si elle tournait. */
  async selectCamera(deviceId: string): Promise<void> {
    this.selectedCameraId.set(deviceId)
    localStorage.setItem('facememe.cameraId', deviceId)
    if (this.running()) {
      this.stop()
      await this.start()
    }
  }

  async start(): Promise<void> {
    if (this.running()) return
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
        localStorage.removeItem('facememe.cameraId')
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
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.video = null
    this.running.set(false)
    this.status.set('caméra arrêtée')
  }

  private loop(): void {
    const video = this.video
    if (!video) return
    const tick = () => {
      if (this.stopped || !this.video) return
      const ts = performance.now()
      const faceRes = this.face!.detectForVideo(video, ts)
      const handRes = this.hand!.detectForVideo(video, ts)

      // Ancre visage (featurizer v2) : nez + écart inter-oculaire, pour situer
      // les mains par rapport à la tête indépendamment de la distance caméra.
      const fl = faceRes.faceLandmarks?.[0] ?? null
      let faceAnchor: FaceAnchor | null = null
      if (fl && fl.length > 263) {
        const nose = fl[1]!
        faceAnchor = {
          nose: { x: nose.x, y: nose.y },
          scale: Math.hypot(fl[263]!.x - fl[33]!.x, fl[263]!.y - fl[33]!.y),
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
        this.fps.set(Math.round((this.frameCount * 1000) / (ts - this.lastFpsAt || 1)))
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
