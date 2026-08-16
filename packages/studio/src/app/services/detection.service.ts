import { Injectable, signal } from '@angular/core'
import {
  FaceLandmarker,
  FilesetResolver,
  HandLandmarker,
  type NormalizedLandmark,
} from '@mediapipe/tasks-vision'
import type { FaceAnchor, Handedness, Landmark, RawFrame } from '@deck4me/core'

export interface VizFrame {
  faceLandmarks: NormalizedLandmark[] | null
  handLandmarks: NormalizedLandmark[][]
}

type ImageSource = HTMLVideoElement | HTMLCanvasElement | ImageBitmap

export type FrameListener = (raw: RawFrame, viz: VizFrame, ts: number) => void

/** Au-delà, on cesse d'espérer et on le dit : marteler l'ouverture d'une
 *  webcam définitivement partie ne fait que brûler du CPU pendant un live. */
const MAX_RETRIES = 5

/** Côté long donné à MediaPipe. Les modèles redimensionnent eux-mêmes en
 *  interne ; au-delà, on paie une réduction pour rien. */
const DETECT_LONG_SIDE = 640

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
  /**
   * Temps passé à ATTENDRE l'image suivante, par frame.
   *
   * L'étage qui manquait, et le plus important quand la cadence déçoit : sans
   * lui, 12 ms de travail mesurés et 59 ms réellement écoulées laissaient
   * croire à une lenteur du logiciel. Une webcam qui rallonge son exposition
   * en faible lumière descend à 15 fps tout en continuant d'en annoncer 30 —
   * c'est elle qu'on voit ici, pas nous.
   */
  readonly waitMs = signal(0)
  /** Cadence négociée avec la source, telle qu'elle la déclare. À comparer aux
   *  fps réellement obtenus : l'écart entre les deux EST le diagnostic. */
  readonly trackFps = signal(0)
  private infAcc = 0
  private prepAcc = 0
  private waitAcc = 0
  private lastTickEnd = 0

  readonly cameras = signal<MediaDeviceInfo[]>([])

  /**
   * Deux notions distinctes, longtemps confondues en une seule.
   *
   * `preferredCameraId` est le choix de L'UTILISATEUR. Il ne change que
   * lorsqu'il choisit, et il survit à tout le reste.
   *
   * `selectedCameraId` est la caméra réellement employée à cet instant. Le
   * démarrage de la caméra virtuelle la déplace de force — la webcam physique
   * devient illisible, elle est prise par le pompage —, et une webcam
   * débranchée fait retomber sur celle par défaut.
   *
   * Les mélanger avait une conséquence pénible : lancer la caméra virtuelle
   * écrasait définitivement le choix, si bien qu'en l'arrêtant on ne savait
   * plus vers quoi revenir et on repartait sur n'importe quelle caméra.
   */
  readonly preferredCameraId = signal<string>(localStorage.getItem('deck4me.cameraId') ?? '')
  readonly selectedCameraId = signal<string>(localStorage.getItem('deck4me.cameraId') ?? '')

  /** MediaStream partagé avec les previews (un <video> par vue, même stream). */
  stream: MediaStream | null = null

  /** Dimensions réellement délivrées par la source (peut être du 1440p). */
  readonly sourceSize = signal<{ w: number; h: number } | null>(null)

  /**
   * Flux direct depuis Rust, employé quand la caméra virtuelle tourne.
   *
   * Dans ce cas la webcam physique est prise par la pompe, et consommer
   * « deck4me Camera » comme une webcam ordinaire faisait perdre une image sur
   * deux : WebView2 n'arrive pas à absorber du RGB24 720p au rythme où il
   * arrive. Rust tient déjà l'image ; il la réduit à 640 px, l'encode en JPEG
   * et la pousse par le serveur local. Six fois moins d'octets, et plus aucune
   * dépendance à la vitesse de la pile de capture Windows.
   */
  readonly feedActive = signal(false)
  private feedWs: WebSocket | null = null
  /** Dernière image reçue, gardée pour l'aperçu — c'est elle que camera-view
   *  dessine, faute de MediaStream à donner à un <video>. */
  bitmap: ImageBitmap | null = null
  /** Une image est en cours de traitement : les suivantes sont ABANDONNÉES.
   *  Se mettre à la file rendrait la détection de plus en plus en retard, ce
   *  qui est précisément le défaut qu'on corrige ici. */
  private busy = false

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

  /** Choix explicite de l'utilisateur : retenu, et il fait référence. */
  async selectCamera(deviceId: string): Promise<void> {
    this.preferredCameraId.set(deviceId)
    localStorage.setItem('deck4me.cameraId', deviceId)
    this.onCameraChange?.(deviceId)
    // Flux direct en cours : le choix est ENREGISTRÉ mais pas appliqué.
    //
    // Tant que la caméra virtuelle tourne, la source de la détection n'est plus
    // une webcam mais le flux servi par Rust — plus rapide, et seul chemin
    // possible puisque la webcam physique est prise par la pompe. Appliquer le
    // choix ici couperait ce flux pour rebrancher l'ancien, trois fois plus
    // lent ; et si l'utilisateur visait sa webcam, elle refuserait de s'ouvrir
    // et il se retrouverait sans image, coincé. Vécu.
    //
    // Le choix reprend effet à l'arrêt de la caméra virtuelle, via
    // `restorePreferred`.
    if (this.feedActive()) {
      this.selectedCameraId.set(deviceId)
      return
    }
    await this.useCamera(deviceId)
  }

  /**
   * Bascule imposée par les circonstances, pas demandée par l'utilisateur :
   * démarrage de la caméra virtuelle, retour ensuite. Rien n'est persisté, la
   * préférence reste intacte — c'est elle qui dit où revenir.
   */
  async useCamera(deviceId: string): Promise<void> {
    if (deviceId === this.selectedCameraId() && this.running()) return
    this.selectedCameraId.set(deviceId)
    if (this.running()) {
      this.stop()
      await this.start()
    }
  }

  /** Retour à la caméra choisie par l'utilisateur, si elle est toujours là.
   *  Sinon on ne force rien : mieux vaut la caméra par défaut qu'une erreur
   *  d'ouverture sur un périphérique débranché. */
  async restorePreferred(): Promise<void> {
    const want = this.preferredCameraId()
    if (!want) return
    await this.listCameras()
    if (!this.cameras().some((c) => c.deviceId === want)) return
    await this.useCamera(want)
  }

  /** Reprend le choix persisté en base quand le localStorage est vide. */
  adoptSavedCamera(deviceId: string): void {
    if (deviceId && !this.preferredCameraId()) {
      this.preferredCameraId.set(deviceId)
      this.selectedCameraId.set(deviceId)
      localStorage.setItem('deck4me.cameraId', deviceId)
    }
  }

  /** Bascule sur le flux direct servi par Rust. */
  async startFeed(url: string): Promise<void> {
    this.stopFeed()
    await this.ensureModels()
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.video = null
    this.stopped = false
    this.lastTickEnd = 0
    const ws = new WebSocket(url)
    ws.binaryType = 'blob'
    ws.onopen = () => {
      this.feedActive.set(true)
      this.running.set(true)
      this.status.set('détection en cours — flux direct')
    }
    ws.onmessage = (ev) => void this.onFeedFrame(ev.data as Blob)
    ws.onerror = () => this.status.set('flux direct injoignable')
    ws.onclose = () => {
      this.feedActive.set(false)
      if (!this.stopped) this.status.set('flux direct interrompu')
    }
    this.feedWs = ws
  }

  stopFeed(): void {
    const ws = this.feedWs
    this.feedWs = null
    this.feedActive.set(false)
    if (ws) {
      ws.onclose = null
      ws.close()
    }
    this.bitmap?.close()
    this.bitmap = null
    this.busy = false
  }

  private async onFeedFrame(blob: Blob): Promise<void> {
    // Image jetée plutôt que mise en file : voir `busy`.
    if (this.busy || this.stopped) return
    this.busy = true
    const ts = performance.now()
    if (this.lastTickEnd) this.waitAcc += ts - this.lastTickEnd
    try {
      const bmp = await createImageBitmap(blob)
      this.bitmap?.close()
      this.bitmap = bmp
      if (this.sourceSize()?.w !== bmp.width || this.sourceSize()?.h !== bmp.height) {
        this.sourceSize.set({ w: bmp.width, h: bmp.height })
      }
      this.process(bmp, ts)
    } catch {
      /* image illisible : on saute, la suivante arrive dans 30 ms */
    } finally {
      this.lastTickEnd = performance.now()
      this.busy = false
    }
  }

  /** Chargement des modèles, commun aux deux sources. */
  private async ensureModels(): Promise<void> {
    if (this.face && this.hand) return
    this.status.set('chargement des modèles…')
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

  async start(): Promise<void> {
    if (this.running()) return
    this.stopFeed()
    clearTimeout(this.retryTimer)
    this.status.set('chargement des modèles…')
    try {
      await this.ensureModels()
      this.status.set('accès caméra…')
      const wanted = this.selectedCameraId()
      // Aucune contrainte de définition : on prend la source TELLE QU'ELLE
      // SORT, et on réduit nous-mêmes.
      //
      // Demander 640×480 semblait économe. En réalité, quand la source ne
      // délivre pas cette définition — la caméra virtuelle publie du 1280×720
      // en RGB24 —, WebView2 accepte le flux puis redimensionne chaque image
      // dans sa propre chaîne de capture, en logiciel. Ce travail-là n'apparaît
      // dans aucun de nos compteurs : il se présente comme de l'ATTENTE.
      // Mesuré : 104 ms d'attente par image et 9 fps, alors que notre
      // traitement complet tenait en 12 ms.
      //
      // Notre réduction à nous coûte 0,2 ms, mesurée sur la même image. Le
      // marché est donc simple : on encaisse 0,2 ms pour ne plus subir un
      // rééchantillonnage dont on ne contrôle rien.
      //
      // `frameRate` reste demandé : une cadence se choisit parmi les modes du
      // pilote, elle ne se fabrique pas par conversion.
      const base: MediaTrackConstraints = { frameRate: 30 }
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          video: wanted ? { ...base, deviceId: { exact: wanted } } : base,
          audio: false,
        })
      } catch (e) {
        if (!wanted) throw e
        // Deux échecs très différents, longtemps traités pareil.
        //
        // Si la caméra a DISPARU de la liste — débranchée —, retomber sur
        // celle par défaut est le bon geste : on rend une image plutôt qu'une
        // erreur.
        //
        // Si elle est TOUJOURS LÀ mais refuse de s'ouvrir, c'est qu'une autre
        // application la tient : Streamlabs, ou notre propre pompe de caméra
        // virtuelle. Basculer alors sur la première caméra venue est le pire
        // geste possible — on filme autre chose, sans le dire, et la détection
        // se met à mal reconnaître pour une raison introuvable. Vécu : la
        // détection est partie sur une caméra tierce, et rien ne l'expliquait.
        await this.listCameras()
        const stillThere = this.cameras().some((c) => c.deviceId === wanted)
        if (stillThere) {
          const label = this.cameras().find((c) => c.deviceId === wanted)?.label || 'Cette caméra'
          this.status.set(
            `${label} est prise par une autre application (Streamlabs, ou la caméra virtuelle de deck4me). ` +
              'Arrête la caméra virtuelle, ou choisis « deck4me Camera ».',
          )
          throw e
        }
        this.selectedCameraId.set('')
        this.stream = await navigator.mediaDevices.getUserMedia({ video: base, audio: false })
      }
      // reflète la caméra réellement obtenue + rafraîchit les labels
      const settings = this.stream.getVideoTracks()[0]?.getSettings()
      if (settings?.deviceId) this.selectedCameraId.set(settings.deviceId)
      // Première utilisation : la caméra obtenue devient la préférence, sinon
      // on n'aurait aucune référence vers laquelle revenir.
      if (settings?.deviceId && !this.preferredCameraId()) {
        this.preferredCameraId.set(settings.deviceId)
        localStorage.setItem('deck4me.cameraId', settings.deviceId)
        this.onCameraChange?.(settings.deviceId)
      }
      this.trackFps.set(Math.round(settings?.frameRate ?? 0))
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
    this.stopFeed()
    clearTimeout(this.retryTimer)
    this.retries = 0
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.video = null
    this.fps.set(0)
    this.lastTickEnd = 0
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

  /** Dimensions de réduction, ou `null` quand la source est déjà assez petite
   *  pour être donnée directement. Le rapport d'image est conservé : les
   *  landmarks sont normalisés sur le cadre fourni, les déformer les ferait
   *  tomber à côté dans l'aperçu. */
  private sizeOf(vw: number, vh: number): { w: number; h: number } | null {
    const long = Math.max(vw, vh)
    if (long <= DETECT_LONG_SIDE) return null
    const s = DETECT_LONG_SIDE / long
    return { w: Math.round(vw * s), h: Math.round(vh * s) }
  }

  /**
   * Traite UNE image, d'où qu'elle vienne.
   *
   * Extrait de la boucle vidéo pour être partagé avec le flux direct : les
   * deux sources ne diffèrent que par la façon dont l'image arrive, jamais par
   * ce qu'on en fait. Dupliquer ce corps aurait garanti qu'un correctif
   * n'atterrisse que d'un côté.
   */
  private process(input: ImageSource, ts: number): void {
    const tPrep = performance.now()
    const faceRes = this.face!.detectForVideo(input, ts)
    const handRes = this.hand!.detectForVideo(input, ts)
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
      this.waitMs.set(this.waitAcc / n)
      this.infAcc = 0
      this.prepAcc = 0
      this.waitAcc = 0
      this.frameCount = 0
      this.lastFpsAt = ts
    }
  }

  private loop(): void {
    const video = this.video
    if (!video) return

    const tick = () => {
      if (this.stopped || !this.video) return
      const ts = performance.now()
      // Depuis la fin du tour précédent : c'est du temps mort, pas du travail.
      if (this.lastTickEnd) this.waitAcc += ts - this.lastTickEnd

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
      // Source déjà assez petite (webcam en 640×480) : on la donne TELLE
      // QUELLE à MediaPipe. La toile intermédiaire ne servait alors qu'à
      // recopier l'image à l'identique — une copie CPU par frame, et surtout
      // la perte du chemin direct vidéo→texture GPU, qui évite de repasser par
      // la mémoire centrale. Elle n'est utile que face à une source 720p/1440p,
      // typiquement la caméra virtuelle.
      const src = this.sizeOf(vw, vh)
      let input: ImageSource = video
      if (src) {
        if (!this.work) {
          this.work = document.createElement('canvas')
          this.workCtx = this.work.getContext('2d', { willReadFrequently: false })
        }
        if (this.work.width !== src.w || this.work.height !== src.h) {
          this.work.width = src.w
          this.work.height = src.h
        }
        this.workCtx!.drawImage(video, 0, 0, src.w, src.h)
        input = this.work
      }
      if (this.sourceSize()?.w !== vw || this.sourceSize()?.h !== vh) {
        this.sourceSize.set({ w: vw, h: vh })
      }

      this.process(input, ts)
      this.lastTickEnd = performance.now()
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
