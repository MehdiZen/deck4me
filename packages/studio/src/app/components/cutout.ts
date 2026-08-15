import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  Output,
  ViewChild,
  inject,
  signal,
} from '@angular/core'
import { RangeFill } from '../range-fill'
import { StoreService, type AssetMeta } from '../services/store.service'
import { TauriService } from '../services/tauri.service'
import { Icon } from './icon'

/** Formats animés : un canvas n'en voit que la première image. Les détourer
 *  produirait un PNG fixe à la place de l'animation — on refuse plutôt que de
 *  détruire silencieusement le fichier de l'utilisateur. */
const ANIMATED = new Set(['gif', 'webm'])

/**
 * Détourage de fond uni.
 *
 * Ce que ça résout : un meme récupéré sur le web arrive presque toujours sur
 * fond blanc, et dans OBS ça donne un rectangle blanc collé sur la facecam.
 * Convertir en PNG n'y change rien — le PNG *peut* porter de la transparence,
 * il n'en fabrique pas.
 *
 * Comment : on échantillonne la couleur des quatre coins, et on rend
 * transparent tout pixel qui s'en approche. La bande de tolérance est douce
 * (transparence partielle à l'approche du seuil) : un seuil net redécouperait
 * les contours en escalier.
 *
 * Ses limites, dites franchement dans l'interface : un fond dégradé ou de la
 * même couleur que le sujet ne peut pas être distingué, et un JPEG très
 * compressé laisse un liseré autour des contours parce que ses artefacts
 * s'étalent au-delà du sujet.
 */
@Component({
  selector: 'app-cutout',
  imports: [Icon, RangeFill],
  template: `
    <div class="bg" (click)="cancel.emit()"></div>
    <div class="panel card" role="dialog" aria-label="Détourage du fond">
      <header>
        <div>
          <h2>Détourer le fond</h2>
          <p class="lbl sub">{{ asset.filename }}</p>
        </div>
        <button class="ghost" (click)="cancel.emit()" aria-label="Fermer">
          <app-icon name="close" />
        </button>
      </header>

      @if (blocked()) {
        <div class="body">
          <p class="badge warn block">{{ blocked() }}</p>
        </div>
      } @else {
        <div class="body">
          <div class="preview alpha-grid">
            <canvas #out></canvas>
          </div>

          <div class="side">
            <section>
              <h3>Couleur du fond</h3>
              <div class="keyrow">
                <span class="swatch" [style.background]="keyCss()"></span>
                <span class="lbl note flat">
                  Prise aux quatre coins. Clique dans l'aperçu pour la choisir
                  toi-même sur un autre point.
                </span>
              </div>
            </section>

            <section>
              <h3>Tolérance</h3>
              <div class="row">
                <input
                  type="range"
                  min="0"
                  max="120"
                  step="1"
                  [value]="tolerance()"
                  (input)="setTolerance(+$any($event.target).value)"
                  aria-label="Tolérance du détourage"
                />
                <span class="pct num">{{ tolerance() }}</span>
              </div>
              <p class="lbl note">
                Trop bas, il reste un halo. Trop haut, le détourage mord dans le
                sujet. Monte jusqu'à ce que le fond parte, puis redescends d'un cran.
              </p>
            </section>

            <section>
              <h3>Adoucissement</h3>
              <div class="row">
                <input
                  type="range"
                  min="0"
                  max="60"
                  step="1"
                  [value]="feather()"
                  (input)="setFeather(+$any($event.target).value)"
                  aria-label="Adoucissement des contours"
                />
                <span class="pct num">{{ feather() }}</span>
              </div>
              <p class="lbl note">
                Rend les contours progressifs au lieu de les découper net. Utile
                sur un JPEG, dont la compression bave autour du sujet.
              </p>
            </section>

            <section class="stat">
              <span class="lbl">Pixels rendus transparents</span>
              <span class="readout">{{ removed().toFixed(1) }}%</span>
              @if (removed() > 92) {
                <p class="badge err block">
                  Presque toute l'image a disparu : la tolérance mord dans le sujet.
                </p>
              } @else if (removed() < 1) {
                <p class="badge warn block">
                  Rien n'a été enlevé — le fond n'est probablement pas uni.
                </p>
              }
            </section>
          </div>
        </div>

        <footer>
          <span class="lbl note flat">
            L'original est conservé : le détourage crée une nouvelle image.
          </span>
          <button (click)="cancel.emit()">Annuler</button>
          <button class="primary" [disabled]="busy()" (click)="apply()">
            <app-icon name="check" [size]="15" />
            {{ busy() ? 'Enregistrement…' : 'Utiliser cette version' }}
          </button>
        </footer>
      }
    </div>
  `,
  styles: `
    :host { position: fixed; inset: 0; z-index: 70; display: grid; place-items: center; }
    .bg {
      position: absolute; inset: 0;
      background: #07060ad9; backdrop-filter: blur(5px);
      animation: fadein 160ms ease-out;
    }
    @keyframes fadein { from { opacity: 0 } }
    .panel {
      position: relative; width: min(940px, 94vw); max-height: 92vh;
      display: flex; flex-direction: column; padding: 0; overflow: hidden;
      border-radius: var(--r-big);
      box-shadow: var(--edge), 0 40px 90px -20px #000d;
      animation: pop 220ms var(--spring) both;
    }
    @keyframes pop { from { opacity: 0; transform: translateY(10px) scale(.985) } }

    header {
      display: flex; align-items: flex-start; gap: 12px;
      padding: 18px 20px 14px; border-bottom: 1px solid var(--line-soft);
    }
    header h2 { margin: 0; font-size: 17px; }
    .sub { margin: 3px 0 0; text-transform: none; letter-spacing: 0; }
    header button { margin-left: auto; }

    .body { display: flex; min-height: 0; overflow: hidden; }
    .preview {
      flex: 1 1 auto; min-width: 0; display: grid; place-items: center;
      padding: 18px; overflow: auto;
    }
    canvas {
      max-width: 100%; max-height: 52vh; display: block; cursor: crosshair;
      border-radius: 6px;
    }

    .side {
      flex: 0 0 300px; overflow-y: auto;
      padding: 18px 20px; border-left: 1px solid var(--line-soft);
      background: #131219;
    }
    section { margin-bottom: 20px; }
    section:last-child { margin-bottom: 0; }
    .row { display: flex; align-items: center; gap: 11px; }
    .row input[type='range'] { flex: 1; min-width: 0; }
    .pct { flex: none; width: 34px; text-align: right; font-size: 12px; color: var(--ink-2); }
    .note { margin: 8px 0 0; text-transform: none; letter-spacing: 0; font-size: 11.5px; line-height: 1.6; }
    .note.flat { margin: 0; flex: 1; }

    .keyrow { display: flex; align-items: flex-start; gap: 10px; }
    .swatch {
      width: 30px; height: 30px; flex: none; border-radius: 7px;
      border: 1px solid var(--line); box-shadow: var(--edge);
    }

    .stat { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
    .stat .lbl { flex: 1; }
    .block {
      display: block; white-space: normal; line-height: 1.5;
      padding: 9px 12px; margin: 10px 0 0; flex-basis: 100%;
    }

    footer {
      display: flex; align-items: center; gap: 9px;
      padding: 14px 20px; border-top: 1px solid var(--line-soft); background: #131219;
    }
  `,
})
export class Cutout implements AfterViewInit {
  @Input({ required: true }) asset!: AssetMeta
  @Output() cancel = new EventEmitter<void>()
  /** Émis avec le NOUVEL asset détouré — l'original reste intact. */
  @Output() done = new EventEmitter<AssetMeta>()

  private store = inject(StoreService)
  private tauri = inject(TauriService)

  @ViewChild('out') outRef!: ElementRef<HTMLCanvasElement>

  readonly tolerance = signal(38)
  readonly feather = signal(18)
  readonly removed = signal(0)
  readonly busy = signal(false)
  readonly blocked = signal('')
  readonly key = signal<[number, number, number]>([255, 255, 255])

  /** Pixels d'origine, gardés intacts : chaque réglage repart d'eux, sinon
   *  deux passes successives rongeraient l'image. */
  private source: ImageData | null = null

  keyCss(): string {
    const [r, g, b] = this.key()
    return `rgb(${r},${g},${b})`
  }

  async ngAfterViewInit(): Promise<void> {
    if (ANIMATED.has(this.asset.ext)) {
      this.blocked.set(
        this.asset.ext === 'gif'
          ? "Ce GIF est peut-être animé, et un détourage n'en garderait que la première image. Pour un GIF, il vaut mieux repartir d'une version déjà transparente."
          : "Une vidéo webm ne se détoure pas ici : il faut la réencoder avec un canal alpha.",
      )
      return
    }
    try {
      await this.load()
    } catch (e) {
      this.blocked.set(`Image illisible — ${e}`)
    }
  }

  /** Les octets viennent du Rust en data:, pas de l'URL du serveur local :
   *  une image d'une autre origine teinte le canvas et interdit getImageData. */
  private async load(): Promise<void> {
    const dataUrl = await this.tauri.invoke<string>('read_asset', { id: this.asset.id })
    const img = new Image()
    await new Promise<void>((ok, ko) => {
      img.onload = () => ok()
      img.onerror = () => ko(new Error('décodage impossible'))
      img.src = dataUrl
    })
    const canvas = this.outRef.nativeElement
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(img, 0, 0)
    this.source = ctx.getImageData(0, 0, canvas.width, canvas.height)
    this.key.set(this.sampleCorners(this.source))
    canvas.addEventListener('click', (e) => this.pickAt(e))
    this.render()
  }

  /** La couleur de fond est celle qui domine les quatre coins. La médiane par
   *  canal encaisse un coin qui ne serait pas du fond, ce qu'une moyenne ne
   *  ferait pas. */
  private sampleCorners(src: ImageData): [number, number, number] {
    const { width: w, height: h, data } = src
    const at = (x: number, y: number) => (y * w + x) * 4
    const pts = [at(2, 2), at(w - 3, 2), at(2, h - 3), at(w - 3, h - 3)]
    const chan = (o: number) => {
      const vals = pts.map((p) => data[p + o]!).sort((a, b) => a - b)
      return Math.round((vals[1]! + vals[2]!) / 2)
    }
    return [chan(0), chan(1), chan(2)]
  }

  private pickAt(ev: MouseEvent): void {
    if (!this.source) return
    const canvas = this.outRef.nativeElement
    const r = canvas.getBoundingClientRect()
    const x = Math.floor(((ev.clientX - r.left) / r.width) * canvas.width)
    const y = Math.floor(((ev.clientY - r.top) / r.height) * canvas.height)
    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return
    const i = (y * canvas.width + x) * 4
    const d = this.source.data
    this.key.set([d[i]!, d[i + 1]!, d[i + 2]!])
    this.render()
  }

  setTolerance(v: number): void {
    this.tolerance.set(v)
    this.render()
  }

  setFeather(v: number): void {
    this.feather.set(v)
    this.render()
  }

  private render(): void {
    const src = this.source
    if (!src) return
    const canvas = this.outRef.nativeElement
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    const out = ctx.createImageData(src.width, src.height)
    const s = src.data
    const o = out.data
    const [kr, kg, kb] = this.key()
    const tol = this.tolerance()
    const soft = this.feather()
    let gone = 0

    for (let i = 0; i < s.length; i += 4) {
      const dr = s[i]! - kr
      const dg = s[i + 1]! - kg
      const db = s[i + 2]! - kb
      // Distance euclidienne dans RGB. Suffisante pour un fond uni, et sans
      // conversion colorimétrique à chaque pixel — on repeint à chaque cran de
      // curseur, ça doit rester instantané sur une image de deux mégapixels.
      const dist = Math.sqrt(dr * dr + dg * dg + db * db)
      o[i] = s[i]!
      o[i + 1] = s[i + 1]!
      o[i + 2] = s[i + 2]!
      const a = s[i + 3]!
      if (dist <= tol) {
        o[i + 3] = 0
        gone++
      } else if (soft > 0 && dist < tol + soft) {
        // Bande de transition : l'opacité monte progressivement, ce qui évite
        // l'escalier de pixels sur les contours obliques.
        o[i + 3] = Math.round(a * ((dist - tol) / soft))
      } else {
        o[i + 3] = a
      }
    }
    ctx.putImageData(out, 0, 0)
    this.removed.set((gone / (s.length / 4)) * 100)
  }

  async apply(): Promise<void> {
    this.busy.set(true)
    try {
      const canvas = this.outRef.nativeElement
      const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/png'))
      if (!blob) throw new Error('encodage PNG impossible')
      const base = this.asset.filename.replace(/\.[^.]+$/, '')
      const file = new File([blob], `${base}-detoure.png`, { type: 'image/png' })
      this.done.emit(await this.store.uploadAsset(file))
    } catch (e) {
      this.blocked.set(String(e))
    } finally {
      this.busy.set(false)
    }
  }
}
