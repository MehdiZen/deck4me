import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core'
import { FEATURIZER_VERSION, HYSTERESIS } from '@meme4me/core'
import { Icon } from '../components/icon'
import { DetectionService } from '../services/detection.service'
import { HISTORY_HZ, HISTORY_LEN, MatcherService } from '../services/matcher.service'
import { StoreService, effectiveThreshold } from '../services/store.service'
import { TauriService } from '../services/tauri.service'

interface OverlayStats {
  lastMs: number | null
  medianMs: number | null
  samples: number
  clients: number
}

/**
 * Écran Debug (phase 5). Deux questions, deux moitiés :
 *   « pourquoi ça ne déclenche pas ? »  → l'historique des distances
 *   « pourquoi c'est en retard ? »      → la chaîne de latence, étage par étage
 *
 * Chaque étage est mesuré là où il se passe. Le dernier — jusqu'au navigateur
 * OBS — ne peut PAS être chronométré ici : les deux documents n'ont pas la même
 * origine de `performance.now()`. C'est le Rust qui le mesure, par aller-retour
 * sur le WebSocket, et il rapporte un aller-retour complet, jamais une moitié
 * devinée.
 */
@Component({
  selector: 'app-debug-page',
  imports: [Icon],
  template: `
    <div class="head">
      <div>
        <h1>Debug</h1>
        <p class="lbl sub">Ce que la machine mesure, pas ce qu'elle promet.</p>
      </div>
      <span class="spacer"></span>
      <span class="badge" [class.ok]="overlay().clients > 0" [class.warn]="!overlay().clients">
        <i class="led" [class.on]="overlay().clients > 0"></i>
        {{ overlay().clients }} source(s) OBS connectée(s)
      </span>
    </div>

    <!-- Chaîne de latence -->
    <div class="card chain">
      <div class="cardhead">
        <h2>Chaîne de latence</h2>
        <span class="lbl legend">de l'image captée au meme affiché dans OBS</span>
      </div>

      <div class="stages">
        @for (s of stages(); track s.key) {
          <div class="stage" [class.unknown]="s.value === null">
            <span class="lbl">{{ s.label }}</span>
            <span class="display" [style.color]="s.value === null ? 'var(--ink-3)' : s.color">
              {{ s.value === null ? '—' : s.value.toFixed(1) }}<em>ms</em>
            </span>
            <span class="lbl note">{{ s.note }}</span>
          </div>
          @if (!$last) {
            <span class="arrow" aria-hidden="true">›</span>
          }
        }
      </div>

      <div class="total">
        <div class="totrow">
          <span class="lbl">Budget mesuré</span>
          <span class="readout">{{ totalMs() === null ? '—' : totalMs()!.toFixed(0) + ' ms' }}</span>
          <span class="spacer"></span>
          <span class="badge" [class.ok]="verdict() === 'ok'" [class.warn]="verdict() === 'limite'"
            [class.err]="verdict() === 'lent'">{{ verdictLabel() }}</span>
        </div>
        <p class="lbl note">
          En dessous de 150 ms le meme paraît simultané à la pose. Entre 150 et
          300 ms le décalage se voit au montage. Au-delà, le bit tombe à côté.
          Le premier étage — la caméra elle-même — n'est pas mesurable depuis ici
          et s'ajoute à ce budget (compte 20 à 60 ms selon la webcam).
        </p>
      </div>
    </div>

    <!-- Historique des distances -->
    <div class="card">
      <div class="cardhead">
        <h2>Historique des distances</h2>
        <span class="lbl legend">
          {{ HISTORY_LEN / HISTORY_HZ }} dernières secondes · ligne pleine = seuil ·
          pointillé = relâche (×{{ HYSTERESIS }})
        </span>
      </div>
      @if (!store.gestures().length) {
        <p class="empty">Aucune gesture dans ce profil.</p>
      } @else {
        <canvas #hist></canvas>
        <p class="lbl note">
          Une courbe qui plonge sous le trait plein sans déclencher, c'est
          <span class="num">framesToTrigger</span> qui n'est pas atteint : la pose
          n'a pas été tenue assez longtemps. Une courbe qui frôle sans passer,
          c'est la sensibilité qu'il faut monter. Un trou dans la courbe, c'est
          une main sortie du champ.
        </p>
      }
    </div>

    <!-- Détail des gestures -->
    <div class="card">
      <div class="cardhead">
        <h2>État des gestures</h2>
      </div>
      <table>
        <thead>
          <tr>
            <th>Gesture</th>
            <th>État</th>
            <th class="r">Distance</th>
            <th class="r">Seuil</th>
            <th class="r">Marge</th>
            <th class="r">Prises</th>
            <th class="r">Cooldown</th>
          </tr>
        </thead>
        <tbody>
          @for (r of rows(); track r.id) {
            <tr>
              <td class="nm">
                {{ r.name }}
                @if (r.isLink) {
                  <span class="badge" title="Maillon de macro — n'affiche rien seul">maillon</span>
                }
              </td>
              <td>
                <span class="badge" [style.color]="r.color">
                  <i class="led" [style.background]="r.color"></i>{{ r.state.toLowerCase() }}
                </span>
              </td>
              <td class="r num">{{ r.dist === null ? '—' : r.dist.toFixed(3) }}</td>
              <td class="r num">{{ r.threshold.toFixed(3) }}</td>
              <td class="r num" [style.color]="r.margin !== null && r.margin < 0 ? 'var(--st-armed)' : ''">
                {{ r.margin === null ? '—' : (r.margin > 0 ? '+' : '') + r.margin.toFixed(3) }}
              </td>
              <td class="r num">{{ r.samples }}</td>
              <td class="r num">{{ r.cooldownMs }}ms</td>
            </tr>
          }
        </tbody>
      </table>
    </div>

    <!-- Environnement -->
    <div class="card">
      <div class="cardhead">
        <h2>Environnement</h2>
      </div>
      <dl class="env">
        <div><dt>Version</dt><dd class="num">{{ store.version() || '—' }}</dd></div>
        <div><dt>Featurizer</dt><dd class="num">v{{ FEATURIZER_VERSION }}</dd></div>
        <div><dt>Serveur local</dt><dd class="num">127.0.0.1:{{ store.port() }}</dd></div>
        <div>
          <dt>Source détection</dt>
          <dd class="num">
            @if (detection.sourceSize(); as s) { {{ s.w }}×{{ s.h }} → 640 } @else { — }
          </dd>
        </div>
        <div><dt>Calibration</dt><dd>{{ store.calibration()?.savedAt?.slice(0, 10) ?? 'absente' }}</dd></div>
        <div><dt>Aller-retours mesurés</dt><dd class="num">{{ overlay().samples }}</dd></div>
      </dl>
      <div class="row">
        <button (click)="copyReport()">
          <app-icon name="copy" [size]="15" /> {{ copied() ? 'Copié' : 'Copier le rapport' }}
        </button>
        @if (store.logPath()) {
          <button (click)="openLog()" [title]="store.logPath()!">
            <app-icon name="download" [size]="15" /> Ouvrir le journal
          </button>
        }
        <span class="lbl note flat">
          Un bloc de texte à coller si tu demandes de l'aide : versions, cadence,
          latences, état des gestures. Aucune image, aucun jeton.
        </span>
      </div>
    </div>
  `,
  styles: `
    :host { display: flex; flex-direction: column; gap: 16px; }
    .head { display: flex; align-items: flex-start; gap: 12px; }
    .head h1 { margin: 0 0 4px; }
    .sub { margin: 0; text-transform: none; letter-spacing: 0; }
    .cardhead { display: flex; align-items: baseline; gap: 12px; margin-bottom: 14px; }
    .cardhead h2 { margin: 0; }
    .legend { flex: 1; text-align: right; text-transform: none; letter-spacing: 0; font-size: 11px; }
    .empty { color: var(--ink-3); font-size: 13px; }
    .note { text-transform: none; letter-spacing: 0; font-size: 11.5px; line-height: 1.6; }
    .note.flat { flex: 1; margin: 0; }

    /* Chaîne : des cadrans alignés, séparés par des chevrons. Le sens de
       lecture porte le sens du flux. */
    .stages { display: flex; align-items: stretch; gap: 6px; flex-wrap: wrap; }
    .stage {
      flex: 1 1 128px; min-width: 118px;
      display: flex; flex-direction: column; gap: 3px;
      padding: 13px 14px; border-radius: var(--r-control);
      background: var(--void); border: 1px solid var(--line-soft);
    }
    .stage.unknown { opacity: 0.6; }
    .stage .display em { font-size: 12px; font-style: normal; color: var(--ink-3); margin-left: 3px; }
    .stage .note { margin: 2px 0 0; font-size: 10.5px; color: var(--ink-3); }
    .arrow { align-self: center; color: var(--ink-3); font-size: 20px; }

    .total { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--line-soft); }
    .totrow { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
    .totrow .readout { font-size: 20px; }

    canvas { display: block; width: 100%; }

    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th {
      text-align: left; font-size: 10.5px; font-weight: 600; letter-spacing: 0.08em;
      text-transform: uppercase; color: var(--ink-3);
      padding: 0 10px 9px; border-bottom: 1px solid var(--line);
    }
    td { padding: 9px 10px; border-bottom: 1px solid var(--line-soft); }
    tr:last-child td { border-bottom: 0; }
    tbody tr { transition: background 140ms var(--ease); }
    tbody tr:hover { background: #ffffff07; }
    .r { text-align: right; }
    .nm { font-weight: 550; }
    td .badge { padding: 2px 8px; font-size: 11px; }

    .env { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin: 0 0 16px; }
    .env dt { font-size: 10.5px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-3); }
    .env dd { margin: 4px 0 0; font-size: 13px; }
  `,
})
export class DebugPage implements AfterViewInit, OnDestroy {
  protected detection = inject(DetectionService)
  protected matcher = inject(MatcherService)
  protected store = inject(StoreService)
  private tauri = inject(TauriService)

  protected readonly HYSTERESIS = HYSTERESIS
  protected readonly HISTORY_HZ = HISTORY_HZ
  protected readonly HISTORY_LEN = HISTORY_LEN
  protected readonly FEATURIZER_VERSION = FEATURIZER_VERSION

  @ViewChild('hist') histRef?: ElementRef<HTMLCanvasElement>

  readonly overlay = signal<OverlayStats>({
    lastMs: null,
    medianMs: null,
    samples: 0,
    clients: 0,
  })
  readonly copied = signal(false)
  /** Rafraîchi à la même cadence que les toiles, pour le tableau. */
  readonly tick = signal(0)

  private raf = 0
  private poll = 0

  readonly stages = computed(() => {
    const d = this.detection
    const m = this.matcher
    const o = this.overlay()
    const c = (v: number | null, warn: number, bad: number) =>
      v === null ? 'var(--ink-3)' : v > bad ? 'var(--st-live)' : v > warn ? 'var(--st-candidate)' : 'var(--ink)'
    const inf = d.running() ? d.inferenceMs() : null
    const prep = d.running() ? d.prepMs() : null
    const match = d.running() ? m.matchMs() : null
    const ipc = m.ipcMs() || null
    return [
      {
        key: 'prep',
        label: 'Réduction',
        value: prep,
        color: c(prep, 4, 10),
        note: 'source → 640 px',
      },
      {
        key: 'infer',
        label: 'MediaPipe',
        value: inf,
        color: c(inf, 22, 40),
        note: 'visage + mains',
      },
      {
        key: 'match',
        label: 'Matching',
        value: match,
        color: c(match, 2, 6),
        note: 'distances + états',
      },
      {
        key: 'ipc',
        label: 'IPC Tauri',
        value: ipc,
        color: c(ipc, 3, 10),
        note: 'webview → Rust',
      },
      {
        key: 'obs',
        label: 'Aller-retour OBS',
        value: o.medianMs,
        color: c(o.medianMs, 12, 30),
        note: o.samples ? `médiane sur ${o.samples}` : 'aucun trigger encore',
      },
    ]
  })

  readonly totalMs = computed(() => {
    const s = this.stages()
    if (s.every((x) => x.value === null)) return null
    // L'aller-retour OBS est compté pour moitié : c'est le trajet aller qui
    // fait attendre le spectateur, le retour n'est qu'un accusé de mesure.
    return s.reduce((sum, x) => sum + (x.key === 'obs' ? (x.value ?? 0) / 2 : (x.value ?? 0)), 0)
  })

  readonly verdict = computed(() => {
    const t = this.totalMs()
    if (t === null) return 'inconnu'
    return t < 150 ? 'ok' : t < 300 ? 'limite' : 'lent'
  })

  verdictLabel(): string {
    switch (this.verdict()) {
      case 'ok':
        return 'imperceptible'
      case 'limite':
        return 'décalage visible'
      case 'lent':
        return 'trop lent'
      default:
        return 'en attente de mesure'
    }
  }

  readonly rows = computed(() => {
    this.tick()
    const snaps = new Map(this.matcher.lastSnapshots.map((s) => [s.gestureId, s]))
    // Poses à meme d'abord, maillons ensuite : les deux restent mesurables —
    // c'est un instrument, pas une bibliothèque — mais elles ne s'entrelacent
    // plus dans le tableau.
    const ordered = [...this.store.memeGestures(), ...this.store.linkGestures()]
    return ordered.map((g) => {
      const s = snaps.get(g.id)
      const threshold = effectiveThreshold(g)
      return {
        id: g.id,
        name: g.name,
        isLink: !!g.sequenceOnly,
        state: s?.state ?? (g.enabled ? 'IDLE' : 'DÉSACTIVÉE'),
        dist: s?.dist ?? null,
        threshold,
        margin: s?.dist === null || s?.dist === undefined ? null : s.dist - threshold,
        samples: g.rawSamples.length,
        cooldownMs: g.cooldownMs,
        color: this.stateColor(s?.state ?? 'IDLE'),
      }
    })
  })

  ngAfterViewInit(): void {
    const draw = () => {
      this.drawHistory()
      this.raf = requestAnimationFrame(draw)
    }
    this.raf = requestAnimationFrame(draw)
    // Le tableau et les cadrans n'ont pas besoin de 60 Hz : 4 Hz suffit à
    // suivre, et laisse le processeur à la détection.
    this.poll = window.setInterval(() => {
      this.tick.update((t) => t + 1)
      void this.readOverlay()
    }, 250)
    void this.readOverlay()
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.raf)
    clearInterval(this.poll)
  }

  private async readOverlay(): Promise<void> {
    try {
      const s = await this.tauri.invoke<OverlayStats>('overlay_stats', {}, this.overlay())
      this.overlay.set(s)
    } catch {
      /* transitoire */
    }
  }

  private token(name: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  }

  private stateColor(state: string): string {
    switch (state) {
      case 'ACTIVE':
        return this.token('--st-armed')
      case 'CANDIDATE':
        return this.token('--st-candidate')
      case 'COOLDOWN':
        return this.token('--st-cooldown')
      default:
        return this.token('--st-idle')
    }
  }

  /**
   * Une courbe par gesture, empilées. L'échelle verticale est commune à toutes
   * (2 × le plus grand seuil) : c'est ce qui permet de comparer deux gestures
   * d'un coup d'œil, ce qu'une échelle par courbe interdirait.
   */
  private drawHistory(): void {
    const canvas = this.histRef?.nativeElement
    if (!canvas) return
    const gestures = this.store.gestures()
    const ROW = 74
    const cssW = canvas.clientWidth || 600
    const cssH = Math.max(1, gestures.length) * ROW + 6
    const dpr = window.devicePixelRatio || 1
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr)
      canvas.height = Math.round(cssH * dpr)
      canvas.style.height = `${cssH}px`
    }
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, cssH)

    const ink = this.token('--ink')
    const ink3 = this.token('--ink-3')
    const line = this.token('--line-soft')
    const armed = this.token('--st-armed')
    const accent = this.token('--accent-hi')

    gestures.forEach((g, i) => {
      const top = i * ROW + 6
      const h = ROW - 26
      const thr = effectiveThreshold(g)
      const max = thr * 2.4
      const buf = this.matcher.history.get(g.id) ?? []
      const yOf = (v: number) => top + h - Math.min(1, v / max) * h

      // fond de piste
      ctx.fillStyle = this.token('--void')
      ctx.fillRect(0, top, cssW, h)

      // seuil + hystérésis
      ctx.strokeStyle = line
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, yOf(thr))
      ctx.lineTo(cssW, yOf(thr))
      ctx.stroke()
      ctx.setLineDash([2, 3])
      ctx.beginPath()
      ctx.moveTo(0, yOf(thr * HYSTERESIS))
      ctx.lineTo(cssW, yOf(thr * HYSTERESIS))
      ctx.stroke()
      ctx.setLineDash([])

      // La zone sous le seuil est la zone de déclenchement : la teinter évite
      // d'avoir à se rappeler dans quel sens lit la courbe.
      ctx.fillStyle = armed + '14'
      ctx.fillRect(0, yOf(thr), cssW, top + h - yOf(thr))

      // courbe — un trou (NaN) coupe le tracé au lieu de l'interpoler
      if (buf.length > 1) {
        const step = cssW / (HISTORY_LEN - 1)
        const x0 = cssW - (buf.length - 1) * step
        ctx.strokeStyle = accent
        ctx.lineWidth = 1.6
        ctx.beginPath()
        let pen = false
        buf.forEach((v, k) => {
          if (!Number.isFinite(v)) {
            pen = false
            return
          }
          const x = x0 + k * step
          const y = yOf(v)
          if (pen) ctx.lineTo(x, y)
          else ctx.moveTo(x, y)
          pen = true
        })
        ctx.stroke()

        const last = buf[buf.length - 1]
        if (Number.isFinite(last!)) {
          ctx.fillStyle = last! < thr ? armed : accent
          ctx.beginPath()
          ctx.arc(cssW - 3, yOf(last!), 3, 0, 7)
          ctx.fill()
        }
      } else {
        ctx.fillStyle = ink3
        ctx.font = '11.5px "Segoe UI Variable Display", "Segoe UI", system-ui'
        ctx.fillText('pas encore de mesure', 10, top + h / 2 + 4)
      }

      // étiquettes
      ctx.font = '12.5px "Segoe UI Variable Display", "Segoe UI", system-ui'
      ctx.fillStyle = ink
      ctx.fillText(g.name, 0, top + h + 15)
      ctx.font = '11px "Cascadia Mono", ui-monospace, Consolas, monospace'
      ctx.fillStyle = ink3
      ctx.textAlign = 'right'
      ctx.fillText(`seuil ${thr.toFixed(3)}`, cssW, top + h + 15)
      ctx.textAlign = 'left'
    })
  }

  /** Le journal vit dans les données d'application : personne ne l'y
   *  trouverait à la main. */
  async openLog(): Promise<void> {
    await this.tauri.invoke('reveal_log', {}, null).catch(() => {})
  }

  async copyReport(): Promise<void> {
    const s = this.stages()
    const lines = [
      `meme4me ${this.store.version()} — rapport`,
      `featurizer v${this.FEATURIZER_VERSION} · profil « ${this.store.activeProfile()?.name} »`,
      `caméra ${this.detection.running() ? `${this.detection.fps()} fps` : 'arrêtée'}` +
        (this.detection.sourceSize()
          ? ` · source ${this.detection.sourceSize()!.w}×${this.detection.sourceSize()!.h}`
          : ''),
      '',
      'latence :',
      ...s.map((x) => `  ${x.label} : ${x.value === null ? '—' : x.value.toFixed(1) + ' ms'}`),
      `  total estimé : ${this.totalMs() === null ? '—' : this.totalMs()!.toFixed(0) + ' ms'} (${this.verdictLabel()})`,
      `  sources OBS connectées : ${this.overlay().clients}`,
      '',
      'gestures :',
      ...this.rows().map(
        (r) =>
          `  ${r.name} — ${r.state}, dist ${r.dist === null ? '—' : r.dist.toFixed(3)}, seuil ${r.threshold.toFixed(3)}, ${r.samples} prises`,
      ),
    ]
    await navigator.clipboard.writeText(lines.join('\n'))
    this.copied.set(true)
    setTimeout(() => this.copied.set(false), 1600)
  }
}
