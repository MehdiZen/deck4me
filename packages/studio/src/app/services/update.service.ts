import { Injectable, inject, signal } from '@angular/core'
import { StoreService } from './store.service'
import { TauriService } from './tauri.service'

export interface UpdateInfo {
  version: string
  currentVersion: string
  notes: string | null
}

/**
 * Mise à jour (phase 6). L'état vit dans un service, pas dans la carte de
 * Réglages : la vérification doit avoir lieu AU DÉMARRAGE — ce que la case à
 * cocher promet — et pas la première fois qu'on ouvre l'écran des réglages.
 *
 * Rien ne s'installe sans clic : une mise à jour qui relance l'app pendant un
 * live est un incident, pas un service.
 */
@Injectable({ providedIn: 'root' })
export class UpdateService {
  private tauri = inject(TauriService)
  private store = inject(StoreService)

  readonly found = signal<UpdateInfo | null>(null)
  readonly busy = signal(false)
  readonly checked = signal(false)
  readonly error = signal('')

  /** Appelé une fois au lancement, après le chargement des réglages. */
  async checkOnStartup(): Promise<void> {
    if (!this.store.settings().autoUpdateCheck) return
    await this.check(true)
  }

  async check(silent = false): Promise<void> {
    if (this.busy()) return
    this.busy.set(true)
    this.error.set('')
    try {
      this.found.set(await this.tauri.invoke<UpdateInfo | null>('check_update', {}, null))
      this.checked.set(true)
    } catch (e) {
      // Pas de réseau, ou aucune release publiée : ce n'est pas une panne de
      // l'application, on ne l'annonce pas comme telle au démarrage.
      if (!silent) this.error.set(`Canal de mise à jour injoignable — ${e}`)
    } finally {
      this.busy.set(false)
    }
  }

  /** Télécharge, installe, relance. Ne rend jamais la main en cas de succès. */
  async install(): Promise<void> {
    this.busy.set(true)
    this.error.set('')
    try {
      await this.tauri.invoke('install_update')
    } catch (e) {
      this.error.set(String(e))
      this.busy.set(false)
    }
  }
}
