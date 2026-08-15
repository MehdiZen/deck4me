import { Injectable, effect, inject, signal } from '@angular/core'
import {
  Matcher,
  featurizeRaw,
  type GestureSnapshot,
  type RawFrame,
} from '@meme4me/core'
import { DetectionService } from './detection.service'
import { StoreService } from './store.service'
import { TauriService } from './tauri.service'

export interface TriggerLogEntry {
  at: string
  name: string
  kind: 'fire' | 'release'
}

/**
 * Fait tourner le Matcher du core sur chaque frame de détection et pousse
 * les événements vers le Rust (qui les diffuse à l'overlay OBS).
 */
@Injectable({ providedIn: 'root' })
export class MatcherService {
  private detection = inject(DetectionService)
  private store = inject(StoreService)
  private tauri = inject(TauriService)

  /** Panic : matching coupé + overlay nettoyé, jusqu'à réactivation. */
  readonly muted = signal(false)
  readonly triggerLog = signal<TriggerLogEntry[]>([])

  /** Lu à 30 Hz par le canvas de l'écran Live — volontairement PAS un signal. */
  lastSnapshots: GestureSnapshot[] = []

  private matcher = new Matcher()
  private names = new Map<string, string>()

  constructor() {
    effect(() => {
      const gestures = this.store.runtimeGestures()
      this.matcher.setGestures(gestures)
      this.names = new Map(gestures.map((g) => [g.id, g.name]))
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
    const blocks = featurizeRaw(raw, this.store.baseline())
    const { events, snapshots } = this.matcher.step(blocks, ts)
    this.lastSnapshots = snapshots
    for (const ev of events) {
      const cmd = ev.type === 'fire' ? 'gesture_fired' : 'gesture_released'
      void this.tauri.invoke(cmd, { gestureId: ev.gestureId })
      this.log(ev.gestureId, ev.type)
    }
  }

  private log(gestureId: string, kind: 'fire' | 'release'): void {
    const entry: TriggerLogEntry = {
      at: new Date().toTimeString().slice(0, 8),
      name: this.names.get(gestureId) ?? gestureId,
      kind,
    }
    this.triggerLog.update((l) => [entry, ...l].slice(0, 20))
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
