import { Injectable, effect, inject, signal } from '@angular/core'
import { Matcher, featurizeRaw, type GestureSnapshot, type RawFrame } from '@meme4me/core'
import { DetectionService } from './detection.service'
import { StoreService } from './store.service'
import { TauriService } from './tauri.service'

export interface TriggerLogEntry {
  at: string
  name: string
  kind: 'fire' | 'release'
  /** Horodatage haute résolution — sert au fondu de la ligne la plus récente. */
  ts: number
}

/** Fenêtre d'historique de l'écran Debug. 20 s à 10 Hz : assez long pour
 *  revoir une pose ratée, assez court pour rester lisible. */
export const HISTORY_HZ = 10
export const HISTORY_LEN = 200

@Injectable({ providedIn: 'root' })
export class MatcherService {
  private detection = inject(DetectionService)
  private store = inject(StoreService)
  private tauri = inject(TauriService)

  /** Panic : matching coupé + overlay nettoyé, jusqu'à réactivation. */
  readonly muted = signal(false)
  readonly triggerLog = signal<TriggerLogEntry[]>([])

  /** Métrologie (phase 5) : coût du matching, et aller-retour de la commande
   *  Tauri qui porte le déclenchement. Le dernier maillon (jusqu'au navigateur
   *  OBS) est mesuré côté Rust — lui seul connaît les deux instants. */
  readonly matchMs = signal(0)
  readonly ipcMs = signal(0)

  /** Lu à 30 Hz par les toiles — volontairement PAS un signal. */
  lastSnapshots: GestureSnapshot[] = []

  /** Historique des distances par gesture, le plus récent en fin de tableau.
   *  NaN = bloc requis manquant (main hors champ) : un trou, pas un zéro. */
  readonly history = new Map<string, number[]>()

  private matcher = new Matcher()
  private names = new Map<string, string>()
  private lastHistoryAt = 0
  private matchAcc = 0
  private matchN = 0

  constructor() {
    effect(() => {
      const gestures = this.store.runtimeGestures()
      this.matcher.setGestures(gestures)
      this.names = new Map(gestures.map((g) => [g.id, g.name]))
      // Une gesture supprimée ne doit pas laisser sa courbe traîner.
      const live = new Set(gestures.map((g) => g.id))
      for (const id of [...this.history.keys()]) if (!live.has(id)) this.history.delete(id)
    })
    this.detection.onFrame((raw, _viz, ts) => this.onFrame(raw, ts))
  }

  /** L'injection du service suffit à l'armer (appelé par App). */
  init(): void {}

  private onFrame(raw: RawFrame, ts: number): void {
    if (this.muted()) {
      this.lastSnapshots = []
      return
    }
    const t0 = performance.now()
    const blocks = featurizeRaw(raw, this.store.baseline())
    const { events, snapshots } = this.matcher.step(blocks, ts)
    this.lastSnapshots = snapshots

    this.matchAcc += performance.now() - t0
    if (++this.matchN >= 30) {
      this.matchMs.set(this.matchAcc / this.matchN)
      this.matchAcc = 0
      this.matchN = 0
    }

    if (ts - this.lastHistoryAt >= 1000 / HISTORY_HZ) {
      this.lastHistoryAt = ts
      this.pushHistory(snapshots)
    }

    for (const ev of events) {
      const cmd = ev.type === 'fire' ? 'gesture_fired' : 'gesture_released'
      const sent = performance.now()
      void this.tauri
        .invoke(cmd, { gestureId: ev.gestureId })
        .then(() => this.ipcMs.set(performance.now() - sent))
        .catch(() => {})
      this.log(ev.gestureId, ev.type)
    }
  }

  private pushHistory(snapshots: GestureSnapshot[]): void {
    for (const s of snapshots) {
      let buf = this.history.get(s.gestureId)
      if (!buf) {
        buf = []
        this.history.set(s.gestureId, buf)
      }
      buf.push(s.dist ?? NaN)
      if (buf.length > HISTORY_LEN) buf.shift()
    }
  }

  private log(gestureId: string, kind: 'fire' | 'release'): void {
    const entry: TriggerLogEntry = {
      at: new Date().toTimeString().slice(0, 8),
      name: this.names.get(gestureId) ?? gestureId,
      kind,
      ts: performance.now(),
    }
    this.triggerLog.update((l) => [entry, ...l].slice(0, 24))
  }

  async panic(): Promise<void> {
    this.muted.set(true)
    this.matcher.panic()
    await this.tauri.invoke('panic_clear')
  }

  unmute(): void {
    this.muted.set(false)
  }

  /** Test manuel d'une gesture → trigger visible dans OBS. */
  async testTrigger(gestureId: string): Promise<void> {
    await this.tauri.invoke('gesture_fired', { gestureId })
    this.log(gestureId, 'fire')
  }
}
