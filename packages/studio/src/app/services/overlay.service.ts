import { Injectable, computed, inject, signal } from '@angular/core'
import { TauriService } from './tauri.service'

/**
 * Combien de sources de navigateur écoutent l'overlay.
 *
 * Cette information existait déjà côté Rust, mais elle n'était lue que par
 * l'écran Debug — c'est-à-dire par personne. Or c'est la panne silencieuse la
 * plus probable de toute l'application : on calibre, on enregistre une pose, le
 * testeur affiche « déclenchée » en vert, et rien n'apparaît en stream parce
 * que l'URL n'a jamais été collée dans OBS. Tous les écrans disent que ça
 * marche ; aucun ne pose la question.
 *
 * Le sondage est volontairement lent (3 s) et se suspend quand la fenêtre est
 * cachée : brancher OBS est un geste qu'on fait une fois, pas une mesure à
 * suivre à la seconde.
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
