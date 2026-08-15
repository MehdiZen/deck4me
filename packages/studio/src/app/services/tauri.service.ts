import { Injectable } from '@angular/core'
import { invoke } from '@tauri-apps/api/core'

/**
 * Fine façade sur l'IPC Tauri. Hors webview Tauri (ng serve dans un
 * navigateur nu), les commandes échouent : on log et on renvoie le fallback
 * pour que l'UI reste inspectable.
 */
@Injectable({ providedIn: 'root' })
export class TauriService {
  readonly available = '__TAURI_INTERNALS__' in window

  async invoke<T>(cmd: string, args?: Record<string, unknown>, fallback?: T): Promise<T> {
    try {
      return await invoke<T>(cmd, args)
    } catch (e) {
      if (!this.available) {
        console.warn(`[tauri absent] ${cmd}`, e)
        return fallback as T
      }
      throw e
    }
  }
}
