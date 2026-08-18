import { ChangeDetectionStrategy, Component, Input, computed, inject, signal } from '@angular/core'
import {
  ACTION_HINTS,
  ACTION_KINDS,
  ACTION_LABELS,
  ACTION_MAX_PER_OWNER,
  chainDurationMs,
  describeAction,
  newAction,
  validateAction,
  type ActionDef,
  type ActionKind,
} from '@deck4me/core'
import { ConfirmService } from '../services/confirm.service'
import { StoreService } from '../services/store.service'
import { RangeFill } from '../range-fill'
import { Icon } from './icon'

/**
 * Chaîne d'actions d'une MACRO.
 *
 * Le composant ne reçoit qu'un `ownerId` et resterait techniquement utilisable
 * pour une gesture — mais il ne doit plus l'être. Une pose seule peut partir
 * par accident ; deux gestes volontaires enchaînés, non. C'est donc le seul
 * endroit assez sûr pour « ouvre ceci » ou « lance ce script », et un meme a de
 * toute façon déjà son son.
 *
 * Le parti pris d'affichage : une action repliée tient sur une ligne et se lit
 * comme une phrase. On n'ouvre le formulaire que pour celle qu'on modifie. Une
 * chaîne de six actions dépliées serait un mur illisible, et c'est précisément
 * quand la chaîne est longue qu'on a besoin de la lire d'un coup d'œil.
 */
@Component({
  selector: 'app-action-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, RangeFill],
  template: `
    <div class="wrap">
      <div class="hd">
        <app-icon name="terminal" [size]="15" />
        <b>Actions</b>
        @if (list().length) {
          <span class="lbl n">{{ list().length }}</span>
        }
        <span class="spacer"></span>
        @if (chainMs(); as ms) {
          <span class="lbl">chaîne ≥ {{ (ms / 1000).toFixed(1) }}s</span>
        }
        <button class="sm" [disabled]="list().length >= MAX" (click)="add()">
          <app-icon name="plus" [size]="13" /> Ajouter
        </button>
      </div>

      @if (!list().length) {
        <p class="lbl none">
          Rien pour l'instant. Une action fait faire quelque chose à la machine —
          ouvrir une app, passer au morceau suivant, appuyer sur un raccourci
          qu'OBS écoute, appeler un webhook.
        </p>
      }

      <div class="rows">
        @for (a of list(); track a.id; let i = $index) {
          <div class="act" [class.off]="!a.enabled" [class.open]="opened() === a.id">
            <div class="line">
              <label class="switch sm">
                <input
                  type="checkbox"
                  [checked]="a.enabled"
                  (change)="patch(a, { enabled: $any($event.target).checked })"
                  [attr.aria-label]="'Activer ' + describe(a)"
                />
              </label>
              <span class="kind" [attr.data-k]="a.kind">
                <app-icon [name]="ICONS[a.kind]" [size]="14" />
              </span>
              <button class="asline" (click)="toggleOpen(a.id)">
                <span class="txt">{{ describe(a) }}</span>
              </button>
              @if (problem(a); as p) {
                <span class="badge warn" [title]="p">à compléter</span>
              }
              <button
                class="ghost sm"
                [disabled]="i === 0"
                (click)="move(i, -1)"
                aria-label="Monter"
              >
                <app-icon name="up" [size]="14" />
              </button>
              <button
                class="ghost sm"
                [disabled]="i === list().length - 1"
                (click)="move(i, 1)"
                aria-label="Descendre"
              >
                <app-icon name="down" [size]="14" />
              </button>
              <button class="ghost sm" (click)="remove(a)" aria-label="Supprimer cette action">
                <app-icon name="trash" [size]="14" />
              </button>
            </div>

            @if (opened() === a.id) {
              <div class="form">
                <div class="kinds" role="radiogroup" aria-label="Genre d'action">
                  @for (k of KINDS; track k) {
                    <button
                      class="kbtn"
                      [class.on]="a.kind === k"
                      [attr.aria-pressed]="a.kind === k"
                      (click)="patch(a, { kind: k })"
                    >
                      <app-icon [name]="ICONS[k]" [size]="14" />
                      {{ LABELS[k] }}
                    </button>
                  }
                </div>
                <p class="lbl hint">{{ HINTS[a.kind] }}</p>

                @switch (a.kind) {
                  @case ('open') {
                    <label class="f">
                      <span class="lbl">Quoi ouvrir</span>
                      <input
                        [value]="a.target"
                        placeholder="spotify:playlist:37i9dQZF1DXcBWIGoYBM5M"
                        (change)="patch(a, { target: $any($event.target).value })"
                      />
                    </label>
                    <p class="lbl ex">
                      Une app (<code>obs64.exe</code>), un dossier, un site
                      (<code>https://…</code>), ou un lien d'application :
                      <code>spotify:</code>, <code>steam://</code>,
                      <code>obsidian://</code>, <code>discord://</code>.
                    </p>
                  }

                  @case ('run') {
                    <label class="f">
                      <span class="lbl">Programme</span>
                      <input
                        [value]="a.target"
                        placeholder="C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
                        (change)="patch(a, { target: $any($event.target).value })"
                      />
                    </label>
                    <label class="f">
                      <span class="lbl">Arguments — un par ligne</span>
                      <textarea
                        rows="3"
                        [value]="a.args.join('\n')"
                        placeholder="-File&#10;C:\\scripts\\scene.ps1"
                        (change)="setArgs(a, $any($event.target).value)"
                      ></textarea>
                    </label>
                    <p class="lbl ex">
                      Un argument par ligne, et rien ne passe par un shell : un
                      chemin avec des espaces n'a pas besoin de guillemets.
                    </p>
                    <label class="f">
                      <span class="lbl">Dossier de travail (optionnel)</span>
                      <input
                        [value]="a.cwd"
                        (change)="patch(a, { cwd: $any($event.target).value })"
                      />
                    </label>
                  }

                  @case ('keys') {
                    <div class="chord">
                      <label class="f mods">
                        <span class="lbl">Modificateurs</span>
                        <div class="row">
                          @for (m of MODS; track m) {
                            <button class="kbtn" [class.on]="hasMod(a, m)" (click)="toggleMod(a, m)">
                              {{ m }}
                            </button>
                          }
                        </div>
                      </label>
                      <label class="f">
                        <span class="lbl">Touche</span>
                        <input
                          class="key"
                          [value]="keyOf(a)"
                          list="m4m-keys"
                          placeholder="F13"
                          (change)="setKey(a, $any($event.target).value)"
                        />
                      </label>
                    </div>
                    <p class="lbl ex">
                      <b>C'est la passerelle universelle.</b> OBS, Discord et
                      Streamlabs écoutent des raccourcis <b>globaux</b> : ils les
                      reçoivent même sans être au premier plan. Donne-leur une
                      touche que rien d'autre n'utilise — <code>F13</code> à
                      <code>F24</code> existent et n'ont aucune touche physique,
                      donc aucun risque de collision — puis assigne-la ici.
                      Spotify et VLC répondent directement à
                      <code>MediaPlayPause</code> et <code>MediaNextTrack</code>.
                      Un raccourci <i>non</i> global, lui, ira dans la fenêtre
                      active au moment du geste.
                    </p>
                  }

                  @case ('text') {
                    <label class="f">
                      <span class="lbl">Texte tapé</span>
                      <textarea
                        rows="2"
                        [value]="a.target"
                        placeholder="!discord"
                        (change)="patch(a, { target: $any($event.target).value })"
                      ></textarea>
                    </label>
                    <p class="lbl ex">
                      Tapé dans la fenêtre active, caractère par caractère et en
                      Unicode — donc indépendant de la disposition du clavier.
                      Enchaîne avec une action <b>Raccourci → Enter</b> pour
                      envoyer.
                    </p>
                  }

                  @case ('http') {
                    <div class="httprow">
                      <label class="f meth">
                        <span class="lbl">Méthode</span>
                        <select
                          [value]="a.method"
                          (change)="patch(a, { method: $any($event.target).value })"
                        >
                          @for (m of METHODS; track m) {
                            <option [value]="m" [selected]="m === a.method">{{ m }}</option>
                          }
                        </select>
                      </label>
                      <label class="f">
                        <span class="lbl">Adresse</span>
                        <input
                          [value]="a.target"
                          placeholder="http://192.168.1.50:8123/api/services/light/toggle"
                          (change)="patch(a, { target: $any($event.target).value })"
                        />
                      </label>
                    </div>
                    <label class="f">
                      <span class="lbl">En-têtes — « Clé: valeur » par ligne</span>
                      <textarea
                        rows="2"
                        [value]="a.headers"
                        placeholder="Authorization: Bearer …"
                        (change)="patch(a, { headers: $any($event.target).value })"
                      ></textarea>
                    </label>
                    <label class="f">
                      <span class="lbl">Corps</span>
                      <textarea
                        rows="3"
                        [value]="a.body"
                        placeholder='{ "content": "je reviens dans 5 min" }'
                        (change)="patch(a, { body: $any($event.target).value })"
                      ></textarea>
                    </label>
                    <p class="lbl ex">
                      Le réseau local est autorisé ici — c'est là que vivent Home
                      Assistant, le pont Hue et obs-websocket. Un corps qui
                      commence par <code>&#123;</code> part en JSON sans que tu
                      aies à le déclarer.
                    </p>
                  }

                  @case ('wait') {
                    <label class="f">
                      <span class="lbl">Pause : {{ shown(a, 'waitMs') }} ms</span>
                      <input
                        type="range"
                        min="50"
                        max="5000"
                        step="50"
                        [value]="a.waitMs"
                        (input)="drag('waitMs', $any($event.target).value)"
                        (change)="patch(a, { waitMs: +$any($event.target).value })"
                      />
                    </label>
                    <p class="lbl ex">
                      Espace deux actions. Utile quand la première ouvre une
                      fenêtre que la seconde doit trouver au premier plan.
                    </p>
                  }
                }

                <div class="foot">
                  <label class="f nm">
                    <span class="lbl">Nom affiché (optionnel)</span>
                    <input
                      [value]="a.label"
                      [placeholder]="autoLabel(a)"
                      (change)="patch(a, { label: $any($event.target).value })"
                    />
                  </label>
                  <label class="f cd">
                    <span class="lbl">
                      Repos min. {{ shown(a, 'cooldownMs') || '—' }}{{ shown(a, 'cooldownMs') ? ' ms' : '' }}
                    </span>
                    <input
                      type="range"
                      min="0"
                      max="10000"
                      step="250"
                      [value]="a.cooldownMs"
                      (input)="drag('cooldownMs', $any($event.target).value)"
                      (change)="patch(a, { cooldownMs: +$any($event.target).value })"
                    />
                  </label>
                  <span class="spacer"></span>
                  <button class="sm" [disabled]="!!problem(a) || testing() === a.id" (click)="test(a)">
                    <app-icon name="zap" [size]="14" />
                    {{ testing() === a.id ? 'En cours…' : 'Tester' }}
                  </button>
                </div>

                @if (problem(a); as p) {
                  <p class="badge warn block">{{ p }}</p>
                }
                @if (result(); as r) {
                  @if (r.id === a.id) {
                    <p class="badge block" [class.warn]="!r.ok" [class.ok]="r.ok">{{ r.msg }}</p>
                  }
                }
              </div>
            }
          </div>
        }
      </div>

      <!-- Une seule liste de touches pour tout le composant : elle vient du
           Rust, qui fait autorité sur ce qui est réellement envoyable. -->
      <datalist id="m4m-keys">
        @for (k of keys(); track k) {
          <option [value]="k"></option>
        }
      </datalist>
    </div>
  `,
  styles: `
    .wrap {
      border-top: 1px solid var(--line-soft);
      margin-top: 13px;
      padding-top: 12px;
    }
    .hd { display: flex; align-items: center; gap: 8px; margin-bottom: 9px; }
    .hd b { font-size: 12.5px; font-weight: 600; }
    .hd app-icon { color: var(--ink-3); }
    .n {
      padding: 1px 7px; border-radius: 99px;
      background: var(--panel-3); color: var(--ink-2); font-size: 10.5px;
    }
    .none { margin: 0 0 4px; text-transform: none; letter-spacing: 0; line-height: 1.55; max-width: 62ch; }

    .rows { display: flex; flex-direction: column; gap: 6px; }
    .act {
      border: 1px solid var(--line-soft);
      border-radius: var(--r-control);
      background: var(--void);
      transition: border-color 160ms var(--ease);
    }
    .act.open { border-color: #8b5cf655; background: var(--panel-2); }
    .act.off .line .txt, .act.off .kind { opacity: 0.45; }

    .line { display: flex; align-items: center; gap: 8px; padding: 6px 8px; }
    /* La pastille de genre code l'action par la couleur : sur une chaîne de six,
       on repère « celle qui lance un script » sans lire une seule étiquette. */
    .kind {
      display: grid; place-items: center;
      width: 25px; height: 25px; flex: none; border-radius: 7px;
      background: var(--panel-3); color: var(--ink-2);
    }
    .kind[data-k='run'] { color: #f0a35e; background: #f0a35e18; }
    .kind[data-k='keys'] { color: var(--cyan); background: #38bdf818; }
    .kind[data-k='http'] { color: #7ee08a; background: #7ee08a18; }
    .kind[data-k='open'] { color: var(--accent-hi); background: var(--accent-wash); }
    .kind[data-k='text'] { color: #e0b7f0; background: #e0b7f018; }

    .asline {
      flex: 1; min-width: 0; text-align: left;
      background: none; border: none; padding: 4px 2px;
      color: var(--ink); font-size: 12.5px;
    }
    .asline:hover .txt { color: var(--accent-hi); }
    .txt {
      display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-family: var(--mono, ui-monospace, monospace); font-size: 11.5px;
    }

    .form {
      display: flex; flex-direction: column; gap: 10px;
      padding: 4px 11px 12px 11px;
      border-top: 1px dashed var(--line-soft);
      margin-top: 2px;
    }

    .kinds { display: flex; flex-wrap: wrap; gap: 5px; }
    .kbtn {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 5px 10px; border-radius: 7px;
      font-size: 11.5px; font-weight: 520;
      background: var(--panel-3); border: 1px solid transparent; color: var(--ink-2);
    }
    .kbtn:hover { color: var(--ink); }
    .kbtn.on {
      background: var(--accent-wash); border-color: #8b5cf655; color: var(--ink);
    }

    .f { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
    .f input, .f textarea, .f select { width: 100%; font-size: 12.5px; }
    .f textarea { resize: vertical; font-family: var(--mono, ui-monospace, monospace); line-height: 1.5; }
    .f input[type='range'] { padding: 0; }

    .hint { margin: -3px 0 0; text-transform: none; letter-spacing: 0; line-height: 1.5; }
    .ex {
      margin: -4px 0 0; text-transform: none; letter-spacing: 0;
      line-height: 1.6; max-width: 68ch;
    }
    .ex code {
      padding: 1px 5px; border-radius: 4px; font-size: 11px;
      background: var(--panel-3); color: var(--ink-2);
    }

    .chord { display: flex; gap: 14px; flex-wrap: wrap; align-items: flex-end; }
    .chord .mods { flex: none; }
    .chord .row { display: flex; gap: 5px; }
    .chord .f:last-child { flex: 1 1 150px; }
    .key { font-family: var(--mono, ui-monospace, monospace); }

    .httprow { display: flex; gap: 10px; align-items: flex-end; }
    .httprow .meth { flex: none; width: 108px; }
    .httprow .f:last-child { flex: 1; min-width: 0; }

    .foot { display: flex; align-items: flex-end; gap: 14px; flex-wrap: wrap; }
    .foot .nm { flex: 1 1 200px; }
    .foot .cd { flex: 0 1 190px; }

    .block {
      display: block; white-space: normal; line-height: 1.5;
      padding: 8px 11px; margin: 0;
    }
  `,
})
export class ActionList {
  /** Identifiant de la macro propriétaire. */
  @Input({ required: true }) set ownerId(v: string) {
    this.owner.set(v)
  }

  protected store = inject(StoreService)
  private confirm = inject(ConfirmService)
  protected readonly KINDS = ACTION_KINDS
  protected readonly LABELS = ACTION_LABELS
  protected readonly HINTS = ACTION_HINTS
  protected readonly MAX = ACTION_MAX_PER_OWNER
  protected readonly MODS = ['Ctrl', 'Alt', 'Shift', 'Win']
  protected readonly METHODS = ['GET', 'POST', 'PUT', 'DELETE']
  protected readonly ICONS: Record<ActionKind, string> = {
    open: 'external',
    run: 'terminal',
    keys: 'keyboard',
    text: 'type',
    http: 'globe',
    wait: 'clock',
  }

  private owner = signal('')
  protected opened = signal<string | null>(null)
  protected testing = signal<string | null>(null)
  protected result = signal<{ id: string; ok: boolean; msg: string } | null>(null)
  protected keys = signal<string[]>([])
  /** Valeur affichée pendant le glissement d'un curseur. Persister à chaque
   *  pixel réécrirait le fichier cent fois par geste ; ne rien afficher pendant
   *  le glissement donnerait l'impression d'un curseur mort. */
  private dragging = signal<{ field: string; value: number } | null>(null)

  protected list = computed(() => this.store.actionsOf(this.owner()))
  protected chainMs = computed(() => chainDurationMs(this.list()) || null)

  constructor() {
    void this.store.keyNames().then((k) => this.keys.set(k))
  }

  protected describe = describeAction
  protected problem = (a: ActionDef): string | null => validateAction(a)

  /** Résumé calculé, ignorant l'étiquette : c'est ce qu'on montre en indication
   *  du champ « nom affiché », pour dire ce qui s'affichera si on le laisse vide. */
  autoLabel(a: ActionDef): string {
    return describeAction({ ...a, label: '' })
  }

  toggleOpen(id: string): void {
    this.result.set(null)
    this.opened.update((cur) => (cur === id ? null : id))
  }

  async add(): Promise<void> {
    // Rang = max + 1, jamais `length` : après une suppression au milieu, les
    // rangs sont 0 et 2, et `length` vaudrait 2 — deux actions au même rang,
    // donc un ordre d'exécution indéterminé.
    const next = this.list().reduce((m, a) => Math.max(m, a.order + 1), 0)
    const a = newAction(this.owner(), next)
    await this.store.saveAction(a)
    this.opened.set(a.id)
  }

  patch(a: ActionDef, p: Partial<ActionDef>): void {
    this.result.set(null)
    this.dragging.set(null)
    void this.store.saveAction({ ...a, ...p })
  }

  drag(field: 'waitMs' | 'cooldownMs', value: string): void {
    this.dragging.set({ field, value: +value })
  }

  shown(a: ActionDef, field: 'waitMs' | 'cooldownMs'): number {
    const d = this.dragging()
    return d?.field === field ? d.value : a[field]
  }

  /** Un argument par ligne — le découpage est explicite, jamais deviné à partir
   *  des espaces. C'est ce qui fait qu'un chemin avec espaces marche seul. */
  setArgs(a: ActionDef, raw: string): void {
    this.patch(a, { args: raw.split('\n').map((s) => s.trim()).filter(Boolean) })
  }

  // ---- Accord clavier : le champ stocke une chaîne, l'interface la compose ----

  private parts(a: ActionDef): string[] {
    return a.target.split('+').map((s) => s.trim()).filter(Boolean)
  }

  hasMod(a: ActionDef, m: string): boolean {
    return this.parts(a).some((p) => p.toLowerCase() === m.toLowerCase())
  }

  keyOf(a: ActionDef): string {
    const mods = this.MODS.map((m) => m.toLowerCase())
    return this.parts(a).find((p) => !mods.includes(p.toLowerCase())) ?? ''
  }

  toggleMod(a: ActionDef, m: string): void {
    const on = this.hasMod(a, m)
    const mods = this.MODS.filter((x) => (x === m ? !on : this.hasMod(a, x)))
    this.patch(a, { target: [...mods, this.keyOf(a)].filter(Boolean).join('+') })
  }

  setKey(a: ActionDef, key: string): void {
    const mods = this.MODS.filter((m) => this.hasMod(a, m))
    this.patch(a, { target: [...mods, key.trim()].filter(Boolean).join('+') })
  }

  // ---- Ordre ----

  async move(i: number, dir: -1 | 1): Promise<void> {
    const list = [...this.list()]
    const j = i + dir
    if (j < 0 || j >= list.length) return
    ;[list[i], list[j]] = [list[j]!, list[i]!]
    await this.store.reorderActions(list)
  }

  async remove(a: ActionDef): Promise<void> {
    if (!(await this.confirm.ask({ title: `Supprimer l'action « ${describeAction(a)} » ?`, danger: true })))
      return
    await this.store.deleteAction(a.id)
    if (this.opened() === a.id) this.opened.set(null)
  }

  async test(a: ActionDef): Promise<void> {
    this.testing.set(a.id)
    this.result.set(null)
    try {
      await this.store.testAction(a)
      this.result.set({ id: a.id, ok: true, msg: 'Exécutée.' })
    } catch (e) {
      this.result.set({ id: a.id, ok: false, msg: String(e) })
    } finally {
      this.testing.set(null)
    }
  }
}
