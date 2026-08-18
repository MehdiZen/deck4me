import { Injectable, computed, inject, signal } from '@angular/core'
import { TauriService } from './tauri.service'

/**
 * Combien de sources de navigateur écoutent l'overlay.
 *
 * Répond à la panne silencieuse la plus probable de l'application : tout est
 * vert, la pose part, et rien n'arrive en stream parce que l'URL n'a jamais été
 * collée dans OBS. Sondage lent, suspendu fenêtre cachée — brancher OBS est un
 * geste qu'on fait une fois.
 */
@Injectable({ providedIn: 'root' })
export class OverlayService {
  private tauri = inject(TauriService)

  /** Nombre de navigateurs connectés. `null` = pas encore mesuré, ce qui n'est
   *  PAS la même chose que zéro : on ne veut pas accuser OBS d'être absent
   *  avant d'avoir regardé. */
  readonly clients = signal<number | null>(null)
  readonly connected = computed(() => (this.clients() ?? 0) > 0)
  /** Vrai seulement quand on a mesuré ET que personne n'écoute. */
  readonly missing = computed(() => this.clients() === 0)

  constructor() {
    void this.poll()
    setInterval(() => void this.poll(), 3000)
  }

  async poll(): Promise<void> {
    if (document.hidden) return
    try {
      const s = await this.tauri.invoke<{ clients: number }>('overlay_stats', {}, { clients: 0 })
      this.clients.set(s?.clients ?? 0)
    } catch {
      // Un sondage raté ne dit rien : on garde la dernière valeur connue
      // plutôt que d'annoncer une déconnexion qui n'a pas été constatée.
    }
  }
}
