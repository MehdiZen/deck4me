import { Injectable, effect, inject, signal } from '@angular/core'
import {
  Matcher,
  SequenceMatcher,
  featurizeRaw,
  type GestureSnapshot,
  type MacroProgress,
  type RawFrame,
} from '@deck4me/core'
import { DetectionService } from './detection.service'
import { StoreService } from './store.service'
import { TauriService } from './tauri.service'

export interface TriggerLogEntry {
  at: string
  name: string
  /** `error` : une action a échoué. Elle apparaît dans le MÊME journal que les
   *  déclenchements, parce que c'est là qu'on regarde quand quelque chose ne
   *  s'est pas produit — pas dans un fichier au fond des données d'application. */
  kind: 'fire' | 'release' | 'error'
  /** Détail de l'échec, en infobulle. */
  detail?: string
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
  private sequences = new SequenceMatcher()
  /** Gestures qui ne déclenchent rien seules — maillons d'enchaînement. */
  private sequenceOnly = new Set<string>()
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
    effect(() => {
      const macros = this.store.macros()
      this.sequences.setMacros(macros)
      for (const m of macros) this.names.set(m.id, m.name)
      this.sequenceOnly = new Set(
        this.store.gestures().filter((g) => g.sequenceOnly).map((g) => g.id),
      )
    })
    this.detection.onFrame((raw, _viz, ts) => this.onFrame(raw, ts))
    void this.listenActionFailures()
  }

  /** L'injection du service suffit à l'armer (appelé par App). */
  init(): void {}

  /** Une action qui échoue doit se voir immédiatement. Sinon on refait le geste
   *  cinq fois devant la webcam en se demandant si c'est la pose qui rate. */
  private async listenActionFailures(): Promise<void> {
    try {
      const { listen } = await import('@tauri-apps/api/event')
      await listen<{ ownerId: string; action: string; error: string }>(
        'action-failed',
        ({ payload }) => {
          this.triggerLog.update((l) =>
            [
              {
                at: new Date().toTimeString().slice(0, 8),
                name: payload.action,
                kind: 'error' as const,
                detail: payload.error,
                ts: performance.now(),
              },
              ...l,
            ].slice(0, 24),
          )
        },
      )
    } catch {
      /* hors webview Tauri : rien à écouter */
    }
  }

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
      if (ev.type === 'fire') {
        // Le maillon alimente les enchaînements AVANT toute décision : même une
        // gesture « séquence seulement » doit faire avancer ses macros.
        const completed = this.sequences.push(ev.gestureId, ts)
        for (const m of completed) {
          this.fire(m.id, m.name)
          this.log(m.id, 'fire', m.name)
        }
        // Une pose marquée maillon ne déclenche rien pour elle-même, sinon
        // « OK puis 3 » afficherait aussi le meme du OK au passage.
        if (this.sequenceOnly.has(ev.gestureId)) continue
      }
      if (ev.type === 'fire') this.fire(ev.gestureId)
      else this.release(ev.gestureId)
      this.log(ev.gestureId, ev.type)
    }
  }

  private fire(id: string, _name?: string): void {
    const sent = performance.now()
    void this.tauri
      .invoke('gesture_fired', { gestureId: id })
      .then(() => this.ipcMs.set(performance.now() - sent))
      .catch(() => {})
  }

  private release(id: string): void {
    void this.tauri.invoke('gesture_released', { gestureId: id }).catch(() => {})
  }

  /** Enchaînements en cours — lu par l'écran Macros pour le retour visuel. */
  progress(): MacroProgress[] {
    return this.sequences.progress(performance.now())
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

  private log(gestureId: string, kind: 'fire' | 'release', name?: string): void {
    const entry: TriggerLogEntry = {
      at: new Date().toTimeString().slice(0, 8),
      name: name ?? this.names.get(gestureId) ?? gestureId,
      kind,
      ts: performance.now(),
    }
    this.triggerLog.update((l) => [entry, ...l].slice(0, 24))
  }

  async panic(): Promise<void> {
    this.muted.set(true)
    this.matcher.panic()
    this.sequences.reset()
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
