import { Injectable, signal } from '@angular/core'

export interface ConfirmRequest {
  title: string
  /** Ce qui sera perdu, en une phrase. Facultatif quand le titre suffit. */
  body?: string
  /** Libellé du bouton d'action. « Supprimer » par défaut. */
  ok?: string
  /** Action destructrice : le bouton passe en rouge. */
  danger?: boolean
}

/**
 * Confirmations, en un seul endroit.
 *
 * Le `confirm()` du navigateur était fonctionnel et laid : police système,
 * bouton OK/Annuler dans l'ordre de Windows, et surtout il affiche le nom de
 * l'application en en-tête. Dans une fenêtre sans barre de titre, ça donne une
 * boîte qui a l'air de venir d'un autre logiciel.
 *
 * Il bloque aussi le fil d'exécution — la boucle de détection comprise, qui
 * tourne à 30 Hz derrière. Une confirmation ne devrait jamais geler la caméra.
 *
 * L'API rend une promesse plutôt qu'un rappel : les appelants s'écrivent
 * exactement comme avant, `if (await ...ask(...))`, et le remplacement n'a
 * touché à aucune logique.
 */
@Injectable({ providedIn: 'root' })
export class ConfirmService {
  readonly pending = signal<ConfirmRequest | null>(null)
  private resolve: ((ok: boolean) => void) | null = null

  ask(req: ConfirmRequest): Promise<boolean> {
    // Une demande déjà en cours est refusée plutôt qu'empilée : deux modales
    // superposées ne se distinguent pas, et la première ne serait jamais
    // résolue.
    this.resolve?.(false)
    this.pending.set(req)
    return new Promise<boolean>((r) => (this.resolve = r))
  }

  answer(ok: boolean): void {
    this.pending.set(null)
    this.resolve?.(ok)
    this.resolve = null
  }
}
