import { Component, inject, signal } from '@angular/core'
import { StoreService } from '../services/store.service'
import { Icon } from './icon'

/** Miroir de `hotkeys::ACTIONS` côté Rust. L'identifiant est le contrat ;
 *  seul le libellé vit ici. */
const ACTIONS: { id: string; label: string; hint: string }[] = [
  { id: 'panic', label: 'Panic', hint: "coupe tout et vide l'overlay" },
  { id: 'resume', label: 'Réactiver', hint: 'relance le matching après un panic' },
  { id: 'toggle_detection', label: 'Caméra', hint: 'démarre ou arrête la détection' },
  { id: 'next_profile', label: 'Profil suivant', hint: 'fait tourner les profils' },
]

/** Touches qui ne peuvent pas constituer un raccourci à elles seules. */
const MODIFIERS = new Set(['Control', 'Shift', 'Alt', 'Meta'])

/** DOM `KeyboardEvent.code` → nom d'accélérateur Tauri. */
function accelerator(ev: KeyboardEvent): string | null {
  if (MODIFIERS.has(ev.key)) return null
  const parts: string[] = []
  if (ev.ctrlKey) parts.push('Control')
  if (ev.altKey) parts.push('Alt')
  if (ev.shiftKey) parts.push('Shift')
  if (ev.metaKey) parts.push('Super')
  const code = ev.code
  let key: string
  if (code.startsWith('Key')) key = code.slice(3)
  else if (code.startsWith('Digit')) key = code.slice(5)
  else if (code.startsWith('Numpad')) key = `Numpad${code.slice(6)}`
  else if (/^F\d{1,2}$/.test(code)) key = code
  else if (code === 'Space') key = 'Space'
  else if (code === 'Escape') return null // réservé à l'annulation
  else key = code
  parts.push(key)
  // Une touche nue serait volée à toutes les autres applications de la machine.
  if (parts.length === 1 && !/^F\d{1,2}$/.test(key)) return null
  return parts.join('+')
}

/**
 * Assignation des raccourcis globaux (phase 6).
 *
 * Un raccourci global est pris pour TOUTE la machine : c'est pour ça qu'une
 * touche seule est refusée (sauf F1–F12), et que l'échec d'enregistrement —
 * OBS ou Discord ont pu prendre la combinaison avant nous — est affiché tel
 * quel plutôt qu'avalé.
 */
@Component({
  selector: 'app-hotkeys',
  imports: [Icon],
  template: `
    <div class="card">
      <h2>Raccourcis globaux</h2>
      <p class="lbl">
        Ils fonctionnent même quand meme4me n'a pas le focus — c'est tout
        l'intérêt pendant un live. Clique sur un champ puis tape la combinaison.
        Windows accorde un raccourci au premier logiciel qui le demande : si OBS
        l'a déjà, meme4me ne l'aura pas.
      </p>

      @if (error()) {
        <p class="badge err block">{{ error() }}</p>
      }

      <div class="list">
        @for (a of ACTIONS; track a.id) {
          <div class="hk">
            <div class="who">
              <b>{{ a.label }}</b>
              <span class="lbl">{{ a.hint }}</span>
            </div>
            <button
              class="cap"
              [class.capturing]="capturing() === a.id"
              (click)="beginCapture(a.id)"
              (keydown)="onKey($event, a.id)"
            >
              @if (capturing() === a.id) {
                <span class="wait">tape la combinaison… <em>Échap pour annuler</em></span>
              } @else if (value(a.id)) {
                <kbd>{{ pretty(value(a.id)) }}</kbd>
              } @else {
                <span class="none"><app-icon name="keyboard" [size]="15" /> non assigné</span>
              }
            </button>
            <button
              class="ghost sm"
              [disabled]="!value(a.id)"
              (click)="clear(a.id)"
              [attr.aria-label]="'Retirer le raccourci ' + a.label"
            >
              <app-icon name="close" [size]="15" />
            </button>
          </div>
        }
      </div>
    </div>
  `,
  styles: `
    .block { display: block; white-space: normal; line-height: 1.5; padding: 9px 12px; margin-bottom: 12px; }
    .list { display: flex; flex-direction: column; gap: 6px; }
    .hk {
      display: flex; align-items: center; gap: 12px;
      padding: 8px 10px; border-radius: var(--r-control);
      transition: background 140ms var(--ease);
    }
    .hk:hover { background: #ffffff07; }
    .who { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    .who b { font-weight: 550; font-size: 13.5px; }
    .who .lbl { text-transform: none; letter-spacing: 0; font-size: 11.5px; }

    .cap {
      flex: 0 0 230px; justify-content: center; min-height: 36px;
      background: var(--void); border-style: dashed; color: var(--ink-3);
    }
    .cap.capturing {
      border-style: solid; border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-wash);
      color: var(--accent-hi);
    }
    .wait { font-size: 12px; }
    .wait em { font-style: normal; color: var(--ink-3); margin-left: 5px; font-size: 11px; }
    .none { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; }
    kbd {
      font-family: var(--font-data); font-size: 12px; color: var(--ink);
      background: var(--panel-2); border: 1px solid var(--line);
      border-bottom-width: 2px; border-radius: 5px; padding: 3px 8px;
    }
  `,
})
export class Hotkeys {
  protected store = inject(StoreService)
  protected readonly ACTIONS = ACTIONS
  readonly capturing = signal('')
  readonly error = signal('')

  value(id: string): string {
    return this.store.settings().hotkeys?.[id] ?? ''
  }

  pretty(accel: string): string {
    return accel.replace(/Control/g, 'Ctrl').replace(/Super/g, 'Win').replace(/\+/g, ' + ')
  }

  beginCapture(id: string): void {
    this.capturing.set(this.capturing() === id ? '' : id)
    this.error.set('')
  }

  async onKey(ev: KeyboardEvent, id: string): Promise<void> {
    if (this.capturing() !== id) return
    ev.preventDefault()
    ev.stopPropagation()
    if (ev.key === 'Escape') {
      this.capturing.set('')
      return
    }
    const accel = accelerator(ev)
    if (!accel) return // modificateur seul, ou touche nue : on attend la suite
    this.capturing.set('')
    await this.assign(id, accel)
  }

  async clear(id: string): Promise<void> {
    await this.assign(id, '')
  }

  private async assign(id: string, accel: string): Promise<void> {
    const hotkeys = { ...this.store.settings().hotkeys, [id]: accel }
    // Une même combinaison ne peut pas servir deux actions : la plus récente
    // gagne, l'autre est libérée plutôt que d'échouer silencieusement.
    if (accel) for (const k of Object.keys(hotkeys)) if (k !== id && hotkeys[k] === accel) hotkeys[k] = ''
    try {
      this.error.set('')
      await this.store.saveSettings({ hotkeys })
    } catch (e) {
      this.error.set(String(e))
    }
  }
}
