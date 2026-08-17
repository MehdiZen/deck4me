import { Component, computed, inject, signal } from '@angular/core'
import { ActionList } from '../components/action-list'
import { AssetPicker } from '../components/asset-picker'
import { BindingEditor } from '../components/binding-editor'
import { Icon } from '../components/icon'
import { ConfirmService } from '../services/confirm.service'
import {
  type AssetMeta,
  type DeckSlot,
  type StoredBinding,
  type StoredGesture,
  StoreService,
} from '../services/store.service'
import { DECK_LABELS, DECK_LAYOUT, deckAccel } from './deck-layout'

/**
 * L'écran d'édition du deck : le même pavé que le widget, mais cliquable.
 *
 * La grille EST l'interface. Une liste de cases (« page 1, touche 4 → … »)
 * aurait demandé de reconstruire mentalement le pavé à chaque lecture, alors
 * que c'est précisément cette forme-là que la main connaît déjà. On édite là où
 * on regardera.
 */
@Component({
  selector: 'app-deck-page',
  imports: [Icon, AssetPicker, ActionList, BindingEditor],
  template: `
    <header class="top">
      <div>
        <h1>Deck clavier</h1>
        <p class="sub">
          Chaque case répond à un accord : le modificateur de sa page, puis sa
          touche du pavé numérique. Le widget montre ce que chaque touche fera —
          c'est lui qui remplace les étiquettes d'un boîtier.
        </p>
      </div>
      <div class="switches">
        <label class="arm" [class.on]="armed()">
          <input type="checkbox" [checked]="armed()" (change)="toggleArmed($event)" />
          <app-icon [name]="armed() ? 'zap' : 'power'" [size]="15" />
          {{ armed() ? 'Deck armé' : 'Deck désarmé' }}
        </label>
        <label class="arm" [class.on]="pinned()" [class.off]="!armed()">
          <input
            type="checkbox"
            [checked]="pinned()"
            [disabled]="!armed()"
            (change)="togglePinned($event)"
          />
          <app-icon name="eye" [size]="15" />
          Widget épinglé
        </label>
      </div>
    </header>

    @if (!armed()) {
      <p class="note">
        Tant que le deck est désarmé, aucun raccordement au clavier n'est
        installé. Rien de ce qui est ci-dessous ne se déclenchera.
      </p>
    }

    <nav class="pages">
      @for (p of pages(); track p.index) {
        <button [class.on]="page() === p.index" (click)="page.set(p.index)">
          {{ p.name }}
          <span class="kbd">{{ p.keyName }}</span>
          @if (p.count) {
            <span class="n">{{ p.count }}</span>
          }
        </button>
      }
    </nav>

    <div class="cols">
      <div class="pad">
        @for (c of cells(); track c.key) {
          <button
            class="cell"
            [class.filled]="c.slot"
            [class.sel]="selected()?.key === c.key"
            [style.grid-column]="c.col + 1 + ' / span ' + c.w"
            [style.grid-row]="c.row + 1 + ' / span ' + c.h"
            (click)="pick(c.key)"
          >
            <span class="key">{{ c.label }}</span>
            @if (c.slot) {
              @if (c.thumb) {
                <img [src]="c.thumb" alt="" />
              }
              <span class="name">{{ c.slot.name }}</span>
            }
          </button>
        }
      </div>

      <aside class="side">
        @if (selected(); as sel) {
          @if (sel.slot; as slot) {
            @if (accelOf(); as a) {
              <p class="accord">Se déclenche par <b>{{ a }}</b></p>
            }
            <div class="hd">
              <input
                class="nm"
                [value]="slot.name"
                (change)="rename(slot, $event)"
                aria-label="Nom de la case"
              />
              <button class="sm danger" (click)="remove(slot)">
                <app-icon name="trash" [size]="13" /> Supprimer
              </button>
            </div>

            @if (bindingOf(slot); as b) {
              <div class="meme">
                <img [src]="thumbOf(slot)" alt="" />
                <button class="sm" (click)="edit(slot, b)">
                  <app-icon name="image" [size]="13" /> Position et durée
                </button>
                <button class="sm" (click)="detach(slot)">Retirer</button>
              </div>
            } @else {
              <app-asset-picker
                label="Poser un meme sur cette touche"
                (picked)="attach(slot, $event)"
              />
            }

            <app-action-list [ownerId]="slot.id" />
          } @else {
            <div class="empty">
              <p>
                Touche <b>{{ sel.label }}</b> libre sur cette page.
              </p>
              @if (accelOf(); as a) {
                <p class="lbl">Elle répondrait à <b>{{ a }}</b>.</p>
              }
              <p class="lbl">
                Rien n'est confisqué : seule la combinaison complète est
                réservée, donc Alt&nbsp;+&nbsp;0233 continue d'écrire « é » et
                Alt+Tab n'est pas touché.
              </p>
              <button class="sm on" (click)="create(sel.key)">
                <app-icon name="plus" [size]="13" /> Occuper cette touche
              </button>
            </div>
          }
        } @else {
          <p class="lbl none">Choisis une touche dans le pavé.</p>
        }
      </aside>
    </div>

    @if (editing(); as e) {
      <app-binding-editor
        [gesture]="e.gesture"
        [binding]="e.binding"
        (cancel)="editing.set(null)"
        (saved)="editing.set(null)"
      />
    }
  `,
  styles: `
    :host { display: block; padding: 22px 26px 30px; }
    .top { display: flex; align-items: flex-start; gap: 20px; margin-bottom: 16px; }
    h1 { font-size: 19px; margin: 0 0 4px; }
    .sub { margin: 0; max-width: 62ch; font-size: 12.5px; color: var(--ink-2); line-height: 1.55; }
    .arm {
      display: flex; align-items: center; gap: 7px;
      white-space: nowrap; padding: 8px 12px; border-radius: 9px;
      border: 1px solid var(--line); background: var(--surface);
      font-size: 12.5px; font-weight: 560; cursor: pointer;
    }
    .switches { display: flex; flex-direction: column; gap: 7px; margin-left: auto; }
    .arm.on { border-color: #5eead466; background: #5eead41a; color: #5eead4; }
    .arm.off { opacity: .45; cursor: default; }
    .arm input { accent-color: #5eead4; }
    .note {
      margin: 0 0 16px; padding: 10px 13px; border-radius: 9px;
      border: 1px solid var(--line-soft); background: var(--surface);
      font-size: 12.5px; color: var(--ink-2); line-height: 1.5;
    }
    .pages { display: flex; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; }
    .pages button {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 13px; border-radius: 9px;
      border: 1px solid var(--line); background: var(--surface);
      color: var(--ink-2); font-size: 12.5px; font-weight: 560; cursor: pointer;
    }
    .pages button.on { border-color: #5eead466; background: #5eead41a; color: #5eead4; }
    .kbd {
      font-size: 10.5px; font-weight: 700; letter-spacing: .03em;
      padding: 2px 6px; border-radius: 5px;
      border: 1px solid var(--line); color: var(--ink-3);
    }
    .pages button.on .kbd { border-color: #5eead44d; color: #5eead4; }
    .n { font-size: 10.5px; opacity: .8; }

    .cols { display: grid; grid-template-columns: minmax(320px, 420px) 1fr; gap: 22px; align-items: start; }
    .pad { display: grid; grid-template-columns: repeat(3, 1fr); grid-template-rows: repeat(5, 82px); gap: 8px; }
    .cell {
      position: relative; overflow: hidden;
      border-radius: 11px; border: 1px solid var(--line);
      background: var(--surface); color: var(--ink-2);
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 3px; padding: 4px; cursor: pointer;
      transition: border-color .12s ease, background .12s ease;
    }
    .cell:hover { border-color: var(--line-strong, #ffffff33); }
    .cell.filled { border-color: #5eead43d; background: #5eead414; }
    .cell.sel { border-color: #5eead4; background: #5eead424; }
    .key { position: absolute; top: 4px; left: 7px; font-size: 10px; font-weight: 700; color: var(--ink-3); }
    .cell.filled .key { color: #5eead4; }
    .cell img { max-width: 72%; max-height: 44%; object-fit: contain; border-radius: 4px; }
    .name {
      font-size: 11px; line-height: 1.2; text-align: center; padding: 0 4px;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    }

    .side { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
    .hd { display: flex; align-items: center; gap: 10px; }
    .nm {
      flex: 1; min-width: 0; font-size: 14px; font-weight: 600;
      padding: 7px 10px; border-radius: 8px;
      border: 1px solid var(--line); background: var(--surface); color: var(--ink);
    }
    .accord {
      margin: 0; padding: 8px 11px; border-radius: 8px;
      border: 1px solid #5eead43d; background: #5eead414;
      font-size: 12.5px; color: #5eead4;
    }
    .accord b { font-weight: 700; letter-spacing: .02em; }
    .row { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--ink-2); }
    .row input { accent-color: #5eead4; }
    .meme { display: flex; align-items: center; gap: 10px; }
    .meme img { width: 64px; height: 64px; object-fit: contain; border-radius: 7px; border: 1px solid var(--line); }
    .empty { display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }
    .empty p { margin: 0; font-size: 13px; line-height: 1.55; }
    .lbl { font-size: 12px; color: var(--ink-3); line-height: 1.55; }
    .none { padding-top: 30px; }
    .sm {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 7px 11px; border-radius: 8px; cursor: pointer;
      border: 1px solid var(--line); background: var(--surface); color: var(--ink-2);
      font-size: 12px; font-weight: 560;
    }
    .sm.on { border-color: #5eead466; background: #5eead41a; color: #5eead4; }
    .sm.danger:hover { border-color: #f8717166; color: #f87171; }
  `,
})
export class DeckPage {
  protected store = inject(StoreService)
  private confirm = inject(ConfirmService)

  protected page = signal(0)
  protected selectedKey = signal<number | null>(null)
  protected editing = signal<{ gesture: StoredGesture; binding: StoredBinding } | null>(null)

  protected armed = computed(() => this.store.settings().deckEnabled)
  protected pinned = computed(() => this.store.settings().deckPinned)

  protected pages = computed(() =>
    this.store.settings().deckPageMods.map((mod, index) => ({
      index,
      name: this.store.settings().deckPageNames[index] ?? `Page ${index + 1}`,
      keyName: mod,
      count: this.store.deckSlots().filter((s) => s.page === index).length,
    })),
  )

  /** L'accord réellement enregistré pour la case sélectionnée. C'est ce que
   *  l'utilisateur devra taper, donc c'est ce qu'on lui montre — pas une
   *  description approximative. */
  protected accelOf = computed(() => {
    const k = this.selectedKey()
    if (k === null) return null
    return deckAccel(this.store.settings().deckPageMods, this.page(), k)
  })

  protected cells = computed(() => {
    const p = this.page()
    return Object.entries(DECK_LAYOUT).map(([k, [col, row, w, h]]) => {
      const key = Number(k)
      const slot = this.store.slotAt(p, key)
      return {
        key,
        label: DECK_LABELS[key] ?? '',
        col,
        row,
        w,
        h,
        slot,
        thumb: slot ? this.thumbOf(slot) : null,
      }
    })
  })

  protected selected = computed(() => {
    const k = this.selectedKey()
    if (k === null) return null
    return { key: k, label: DECK_LABELS[k] ?? '', slot: this.store.slotAt(this.page(), k) }
  })

  protected pick(key: number): void {
    this.selectedKey.set(key)
  }

  protected toggleArmed(ev: Event): void {
    void this.store.saveSettings({ deckEnabled: (ev.target as HTMLInputElement).checked })
  }

  /** Épinglé, le widget reste à l'écran et accepte les clics.
   *
   *  Ce n'est pas un confort : hors épinglage il n'a jamais le focus et
   *  s'efface au relâchement de la touche de page, donc rien n'y est
   *  atteignable à la souris. Il reste invisible à la capture d'écran dans les
   *  deux cas — épinglé ne veut pas dire visible par les spectateurs. */
  protected togglePinned(ev: Event): void {
    void this.store.saveSettings({ deckPinned: (ev.target as HTMLInputElement).checked })
  }

  protected async create(key: number): Promise<void> {
    const slot: DeckSlot = {
      id: crypto.randomUUID(),
      profileId: this.store.activeProfile()?.id ?? 'default',
      page: this.page(),
      key,
      name: DECK_LABELS[key] ?? 'Case',
      // Durée fixe, et pas de maintien possible : RegisterHotKey ne signale
      // jamais le relâchement d'un accord. Un meme « tenu » resterait affiché
      // indéfiniment, l'overlay guettant une fin qui n'arriverait jamais.
      holdMode: 'fixed_duration',
    }
    await this.store.saveDeckSlot(slot)
  }

  protected rename(slot: DeckSlot, ev: Event): void {
    const name = (ev.target as HTMLInputElement).value.trim()
    if (name) void this.store.saveDeckSlot({ ...slot, name })
  }

  protected async remove(slot: DeckSlot): Promise<void> {
    const n = this.store.actionsOf(slot.id).length
    const ok = await this.confirm.ask({
      title: `Libérer la touche « ${slot.name} » ?`,
      body: n
        ? `Ses ${n} action${n > 1 ? 's' : ''} et son meme partent avec elle. La touche redeviendra une touche ordinaire.`
        : 'Son meme part avec elle. La touche redeviendra une touche ordinaire.',
      ok: 'Libérer',
      danger: true,
    })
    if (ok) await this.store.deleteDeckSlot(slot.id)
  }

  protected bindingOf(slot: DeckSlot): StoredBinding | null {
    return this.store.binding(slot.id)
  }

  protected thumbOf(slot: DeckSlot): string | null {
    const asset = this.store.asset(this.store.binding(slot.id)?.assetId)
    return asset ? this.store.assetUrl(asset) : null
  }

  protected async attach(slot: DeckSlot, meta: AssetMeta): Promise<void> {
    const binding = await this.store.bindAsset(slot.id, meta.id)
    this.editing.set({ gesture: this.asGesture(slot), binding })
  }

  protected edit(slot: DeckSlot, binding: StoredBinding): void {
    this.editing.set({ gesture: this.asGesture(slot), binding })
  }

  protected async detach(slot: DeckSlot): Promise<void> {
    await this.store.unbind(slot.id)
  }

  /** L'éditeur de rendu ne lit qu'un nom et un mode d'affichage. Une case
   *  emprunte donc le même éditeur que les gestures et les macros, sans qu'il
   *  ait à connaître leur existence. */
  private asGesture(slot: DeckSlot): StoredGesture {
    return { name: slot.name, holdMode: slot.holdMode } as StoredGesture
  }
}


