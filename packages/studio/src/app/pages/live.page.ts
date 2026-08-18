import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core'
import { HYSTERESIS, type BlockDiag, type GestureSnapshot } from '@deck4me/core'
import { RouterLink } from '@angular/router'
import { CameraView } from '../components/camera-view'
import { Icon } from '../components/icon'
import { DetectionService } from '../services/detection.service'
import { MatcherService } from '../services/matcher.service'
import { OverlayService } from '../services/overlay.service'
import { StoreService } from '../services/store.service'

/**
 * Écran Live : ce qu'on regarde pendant qu'on stream.
 * Les barres de distance sont en canvas, PAS en DOM — elles se redessinent à
 * 30 Hz et feraient tourner la change detection sur chaque frame.
 * Le seuil se règle en attrapant son trait directement dans le graphe : la
 * chose qu'on regarde et la commande qu'on manipule sont la même.
 */
@Component({
  selector: 'app-live-page',
  imports: [CameraView, Icon, RouterLink],
  template: `
    <div class="head">
      <div>
        <h1>Live</h1>
        <p class="lbl sub">{{ detection.status() }}</p>
      </div>
      <span class="spacer"></span>
      @if (!detection.running()) {
        <button class="primary" (click)="detection.start()">
          <app-icon name="play" [size]="16" /> Démarrer la caméra
        </button>
      } @else {
        <button (click)="detection.stop()"><app-icon name="stop" [size]="15" /> Arrêter</button>
      }
      @if (matcher.muted()) {
        <button class="primary" (click)="matcher.unmute()">Réactiver les poses</button>
      } @else {
        <button class="danger" (click)="matcher.panic()">
          <app-icon name="power" [size]="15" /> Panic
        </button>
      }
    </div>

    <!-- Liste de mise en route.
         L'application s'ouvre sur cet écran, qui est le seul des six à
         supposer que tout est déjà fait : caméra éteinte, aucune barre, « Rien
         encore ». Et c'était aussi le seul à ne rien dire de la calibration,
         alors que sans elle TOUS les boutons d'enregistrement sont grisés et
         qu'elle se trouve dans la sixième carte du dernier onglet.
         Elle disparaît d'elle-même dès qu'on a de quoi travailler : une
         calibration et une pose. Ce n'est pas un tutoriel, c'est un chemin. -->
    @if (setupOpen()) {
      <ol class="setup card rise">
        <li [class.done]="detection.running()">
          <i class="tick"></i>
          <div>
            <b>Allume la caméra</b>
            <span class="lbl">Tout le reste en dépend, à commencer par la calibration.</span>
          </div>
          @if (!detection.running()) {
            <button class="sm primary" (click)="detection.start()">Démarrer</button>
          }
        </li>
        <li [class.done]="!!store.calibration()">
          <i class="tick"></i>
          <div>
            <b>Calibre-toi — vingt secondes</b>
            <span class="lbl">
              Ton visage au repos sert de garde-fou. Sans elle, impossible
              d'enregistrer quoi que ce soit.
            </span>
          </div>
          @if (!store.calibration()) {
            <a class="btn" routerLink="/reglages">Aller à la calibration</a>
          }
        </li>
        <li [class.done]="store.gestures().length > 0">
          <i class="tick"></i>
          <div>
            <b>Enregistre une première pose</b>
            <span class="lbl">Volontaire et exagérée : c'est ce qui se reconnaît le mieux.</span>
          </div>
          @if (store.calibration() && !store.gestures().length) {
            <a class="btn" routerLink="/gestures">Aller aux poses</a>
          }
        </li>
        <li [class.done]="overlay.connected()">
          <i class="tick"></i>
          <div>
            <b>Branche l'overlay dans OBS</b>
            <span class="lbl">
              Sans cette source de navigateur, la pose sera reconnue mais
              <b>aucun meme n'apparaîtra</b> en stream.
            </span>
          </div>
          @if (!overlay.connected()) {
            <a class="btn" routerLink="/reglages">Copier l'URL</a>
          }
        </li>
      </ol>
    }

    <!-- La caméra d'abord, sur toute la largeur : c'est l'image qui sert à se
         cadrer et à s'éclairer, et ces deux réglages-là pèsent plus lourd sur
         la qualité de détection que n'importe quel seuil. Les mesures viennent
         dessous, dans l'ordre où on les consulte : ce qui est en train de se
         passer à gauche, ce qui vient de se passer à droite. -->
    <div class="stack" #stack>
      <div class="card viewport" [class.fired]="flash()" [style.width.px]="camPx()">
        <app-camera-view />
        <!-- Bandeau d'instrument sur l'image : ce qui compte pendant un live
             se lit sans quitter la vidéo des yeux. -->
        <div class="hud" #hud>
          <span class="badge" [class.ok]="detection.running()">
            <i class="led" [class.on]="detection.running()"></i>
            {{ detection.running() ? 'détection' : 'arrêt' }}
          </span>
          @if (detection.running()) {
            <span class="badge"><b class="num">{{ detection.fps() }}</b> fps</span>
            @if (detection.sourceSize(); as s) {
              <span class="badge"><span class="num">{{ s.w }}×{{ s.h }}</span></span>
            }
          }
          <span class="spacer"></span>
          <!-- La panne silencieuse : tout est vert, la pose part, et rien
               n'arrive en stream parce que personne n'écoute au bout du fil. -->
          @if (overlay.missing()) {
            <span class="badge warn" title="Colle l'URL de l'overlay dans une source Navigateur d'OBS (Réglages)">
              <i class="led"></i> OBS non branché
            </span>
          }
          @if (armed(); as n) {
            <span class="badge ok"><span class="num">{{ n }}</span> armée(s)</span>
          }
        </div>
      </div>

      <div class="row" #row>
        <div class="card">
          <div class="cardhead">
            <h2>Distances</h2>
            <!-- Une toile n'a aucune affordance : tout ce qui n'est pas
                 écrit n'existe pas. Cette ligne est la seule chose qui dise
                 que le graphe est une commande, elle a donc le droit de tenir
                 sur deux lignes. -->
            <span class="lbl legend">
              <b>attrape le trait plein</b> pour régler le déclenchement ·
              double-clic = retour auto · le pointillé est le seuil de relâche
              (×{{ HYSTERESIS }})
            </span>
          </div>
          <!-- mouseup et mouseleave sur la fenêtre : relâcher hors de la toile
               doit terminer le geste, sinon le glissement reste collé au
               curseur après coup. -->
          <canvas
            #bars
            [class.grabbing]="!!drag()"
            [class.grab]="!drag() && !!hover()"
            (mousedown)="onBarsDown($event)"
            (mousemove)="onBarsMove($event)"
            (mouseleave)="hover.set(null)"
            (dblclick)="onBarsDbl($event)"
            (window:mouseup)="onBarsUp()"
            title="Attrape le trait plein d'une ligne pour régler sa facilité de déclenchement. Double-clic sur la ligne pour revenir au seuil mesuré à l'enregistrement."
          ></canvas>
        </div>

        <div class="card log-panel">
          <h2>Derniers triggers</h2>
          @if (!matcher.triggerLog().length) {
            <p class="empty">Rien encore. Prends une pose enregistrée.</p>
          }
          <ul class="log">
            @for (t of matcher.triggerLog(); track t.ts) {
              <li class="rise" [class.failed]="t.kind === 'error'" [title]="t.detail ?? ''">
                <i class="led" [class.on]="t.kind === 'fire'" [class.bad]="t.kind === 'error'"></i>
                <span class="nm">{{ t.name }}</span>
                <span class="kind lbl">{{ label(t.kind) }}</span>
                <span class="at num">{{ t.at }}</span>
              </li>
            }
          </ul>
        </div>
      </div>
    </div>
  `,
  styles: `
    /* La page prend la hauteur qu'on lui donne : c'est ce qui rend la place
       libre MESURABLE. Sans ça, la colonne se règle sur son contenu, et
       demander « combien reste-t-il ? » n'a plus de sens — la réponse est
       toujours zéro. */
    :host { display: flex; flex-direction: column; height: 100%; min-height: 0; }
    .head { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 20px; flex: 0 0 auto; }
    .head h1 { margin: 0 0 4px; }
    .sub { margin: 0; text-transform: none; letter-spacing: 0; }

    /* Liste de mise en route : une colonne d'etapes, pas un encart d'alerte.
       Un chemin se lit de haut en bas, et chaque ligne porte l'action qui la
       termine — sans quoi on sait quoi faire mais pas ou aller. */
    .setup {
      flex: 0 0 auto;
      display: flex; flex-direction: column; gap: 2px;
      margin: 0 0 18px; padding: 14px 16px;
      list-style: none;
      counter-reset: step;
    }
    .setup li {
      display: flex; align-items: center; gap: 12px;
      padding: 9px 0; font-size: 13px;
      border-bottom: 1px solid var(--line-soft);
    }
    .setup li:last-child { border-bottom: 0; }
    .setup li > div { flex: 1; min-width: 0; }
    /* Selecteur volontairement etroit : un <b> a l'interieur de la ligne
       d'explication doit rester dans le fil de la phrase, pas passer en bloc. */
    .setup li > div > b { display: block; font-weight: 580; color: var(--ink); }
    .setup .lbl {
      display: block; margin-top: 2px;
      text-transform: none; letter-spacing: 0; font-size: 11.5px; line-height: 1.5;
    }
    /* La pastille porte le numero tant que l'etape reste a faire, et une coche
       une fois passee : le compte des etapes restantes se lit sans compter. */
    .setup .tick {
      counter-increment: step;
      flex: none; width: 21px; height: 21px; border-radius: 50%;
      display: grid; place-items: center;
      border: 1px solid var(--line);
      color: var(--ink-3); font-size: 10.5px; font-weight: 600;
      font-style: normal;
    }
    .setup .tick::before { content: counter(step); }
    .setup li.done .tick {
      border-color: transparent; background: var(--st-armed); color: #04140c;
    }
    .setup li.done .tick::before { content: '✓'; }
    .setup li.done > div > b { color: var(--ink-2); font-weight: 520; }
    .setup li.done .lbl { display: none; }
    /* Un lien qui mene a l'etape suivante doit avoir l'air d'un bouton : les
       styles de bouton de la feuille globale sont portes par l'element
       button, un <a> n'en herite rien. */
    .setup .btn {
      flex: none;
      display: inline-flex; align-items: center; justify-content: center;
      padding: 5px 11px; border-radius: var(--r-control);
      border: 1px solid var(--line); background: var(--panel-2);
      color: var(--ink); text-decoration: none; white-space: nowrap;
      font: 550 12px/1 var(--font-ui);
      box-shadow: var(--edge);
      transition: background 140ms var(--ease), border-color 140ms var(--ease);
    }
    .setup .btn:hover { background: var(--panel-3); border-color: #423e56; }
    .setup button { flex: none; }

    .stack { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 16px; }
    /* Les deux étages gardent leur hauteur propre : l'image la reçoit en style
       en ligne, la ligne du bas la tient de son contenu. Rien ne s'étire pour
       remplir — c'est le calcul qui décide, pas le flex. */
    .stack > * { flex: 0 0 auto; }
    /* Trop étroit pour la mise en page : la hauteur cesse d'être la contrainte
       qui mord, la page défile, et c'est très bien. */
    @media (max-width: 1120px) { :host { height: auto; } }
    /* 2/3 – 1/3. En grille et non en flex : les deux cartes reçoivent leur part
       de la largeur sans que leur CONTENU ne la négocie — un nom de trigger
       long élargirait sa colonne en flex, et la toile perdrait la place au
       pixel près sous le curseur qui règle un seuil.
       Le minmax(0, …) est là parce qu'une piste de grille refuse par défaut de
       passer sous la largeur intrinsèque de son contenu : sans lui, la toile ne
       peut plus jamais rétrécir une fois qu'elle s'est élargie. */
    .row {
      display: grid;
      grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
      gap: 16px;
      align-items: start;
    }
    /* Sous cette largeur, deux colonnes rendraient le journal trop étroit pour
       ses trois colonnes de texte : on empile. */
    @media (max-width: 1120px) { .row { grid-template-columns: minmax(0, 1fr); } }

    /* La vidéo occupe toute la carte : aucune marge ne vient la « décorer ».
       Centrée, parce que sa largeur est plafonnée pour que les mesures restent
       visibles : sur un écran large elle ne remplit plus toute la ligne, et
       collée à gauche elle donnerait l'air d'une mise en page ratée.

       Centrée par align-self, et surtout PAS par une marge automatique : sur un
       élément flex, une marge auto sur l'axe transverse annule l'étirement, et
       la carte retombe alors sur la largeur de son CONTENU — les quelques
       badges du bandeau. La largeur explicite est donc indispensable ici : sans
       elle, align-self: center produirait exactement la même réduction. */
    .viewport {
      padding: 0;
      overflow: hidden;
      width: 100%;
      align-self: center;
      transition: box-shadow 200ms var(--ease), border-color 200ms var(--ease);
    }
    /* Un meme part à l'antenne : la carte s'allume une demi-seconde. C'est le
       seul retour visuel qu'on peut capter du coin de l'œil sans lâcher la
       caméra des yeux. */
    .viewport.fired {
      border-color: var(--st-armed);
      box-shadow: var(--edge), 0 0 0 1px #17a26866, 0 0 34px -4px #17a268aa;
    }
    .viewport app-camera-view { display: block; }
    .hud {
      display: flex; align-items: center; gap: 7px;
      padding: 10px 12px; border-top: 1px solid var(--line-soft);
      background: #100f16;
    }

    .cardhead { display: flex; align-items: baseline; gap: 12px; margin-bottom: 12px; }
    .cardhead h2 { margin: 0; }
    .legend { flex: 1; text-align: right; text-transform: none; letter-spacing: 0; font-size: 11px; }
    .hint { max-width: 64ch; margin-bottom: 14px; }

    canvas { display: block; width: 100%; }
    /* Le curseur est la seule affordance possible sur une toile : il doit dire
       « ça s'attrape » avant qu'on essaie. */
    canvas.grab { cursor: ew-resize; }
    canvas.grabbing { cursor: grabbing; user-select: none; }
    .empty { color: var(--ink-3); font-size: 13px; }

    .log-panel { max-height: 320px; display: flex; flex-direction: column; }
    .log { list-style: none; margin: 0; padding: 0; overflow-y: auto; }
    .log li {
      display: flex; align-items: center; gap: 10px;
      padding: 8px 0; border-bottom: 1px solid var(--line-soft);
      font-size: 13px;
    }
    .log li:last-child { border-bottom: 0; }
    .log .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .log .kind { font-size: 10px; }
    .log .at { color: var(--ink-3); font-size: 11.5px; }
    /* Un échec d'action se lit dans le même journal que les déclenchements —
       c'est là qu'on regarde quand quelque chose ne s'est pas produit. */
    .log li.failed .nm, .log li.failed .kind { color: var(--st-live); }
    .log .led.bad { background: var(--st-live); box-shadow: 0 0 8px var(--st-live); }
  `,
})
export class LivePage implements AfterViewInit, OnDestroy {
  protected detection = inject(DetectionService)
  protected matcher = inject(MatcherService)
  protected store = inject(StoreService)
  protected overlay = inject(OverlayService)
  protected readonly HYSTERESIS = HYSTERESIS
  @ViewChild('bars') barsRef!: ElementRef<HTMLCanvasElement>
  @ViewChild('stack') stackRef!: ElementRef<HTMLElement>
  @ViewChild('row') rowRef!: ElementRef<HTMLElement>
  @ViewChild('hud') hudRef!: ElementRef<HTMLElement>
  private raf = 0

  readonly armed = computed(() => this.store.gestures().filter((g) => g.enabled).length)

  /** La liste de mise en route ne vit que le temps de l'installation.
   *  Elle s'accroche aux deux seules conditions VRAIMENT bloquantes ; la
   *  caméra et OBS y figurent comme étapes, mais ne suffisent pas à la faire
   *  revenir — quelqu'un qui coupe sa caméra entre deux streams, ou qui se
   *  sert du deck sans OBS, n'a pas à se faire répéter une leçon apprise. */
  readonly setupOpen = computed(
    () => this.store.loaded() && (!this.store.calibration() || !this.store.gestures().length),
  )

  // ---- La plus grande image qui tient, dans les DEUX dimensions ----
  //
  // La règle est celle de n'importe quel lecteur vidéo : le plus grand rectangle
  // au bon rapport qui entre dans la place libre. Ni la largeur seule ni la
  // hauteur seule ne commandent — c'est la première des deux qui bute.
  //
  //     largeur = min( largeur libre , hauteur libre × rapport )
  //
  // Et la place libre est MESURÉE, pas devinée : hauteur de la colonne, moins la
  // carte du bas telle qu'elle est réellement, moins le bandeau d'instruments.
  // Une version précédente soustrayait une constante de 500 px censée
  // représenter « le reste de la page ». Elle laissait un espace mort en bas
  // parce qu'elle réservait trop, et elle serait redevenue fausse au moindre
  // changement de contenu — une gesture de plus dans la toile, une ligne de plus
  // dans le journal.
  //
  // On agit sur la largeur et jamais sur la hauteur, parce que le cadre doit
  // garder exactement le rapport de la source : le <video> est en `cover` — il
  // recadre — tandis que la toile des landmarks est étirée sur toute la boîte.
  // Une boîte au mauvais rapport fait diverger les deux, et les points tombent à
  // côté du visage.

  /** En dessous, on laisse plutôt la page défiler que réduire l'image à un
   *  timbre-poste : c'est le cas « fenêtre vraiment petite », assumé. */
  private readonly CAM_MIN = 420
  /** L'écart entre les deux étages, tel que déclaré dans .stack. */
  private readonly GAP = 16

  /** Largeur retenue pour l'image, en pixels. Recalculée à chaque frame, mais
   *  n'écrit le signal que lorsqu'elle bouge vraiment : sans ce garde-fou, on
   *  déclencherait un cycle de rendu Angular soixante fois par seconde pour
   *  réécrire la même valeur. */
  protected camPx = signal<number | null>(null)

  private measureCam(): void {
    const stack = this.stackRef?.nativeElement
    const row = this.rowRef?.nativeElement
    const hud = this.hudRef?.nativeElement
    if (!stack || !row || !hud) return
    const s = this.detection.sourceSize()
    const ratio = s ? s.w / s.h : 4 / 3
    const freeW = stack.clientWidth
    const freeH = stack.clientHeight - row.offsetHeight - this.GAP - hud.offsetHeight
    const w = Math.max(this.CAM_MIN, Math.min(freeW, freeH * ratio))
    const px = Math.round(w)
    if (this.camPx() === null || Math.abs(this.camPx()! - px) >= 1) this.camPx.set(px)
  }

  // ---- Réglage de la sensibilité À MÊME le graphe ----
  //
  // Le trait de seuil EST le réglage. Un curseur séparé, plus bas, obligeait à
  // faire l'aller-retour entre la barre qu'on regarde et la commande qu'on
  // manipule, en tenant de tête la correspondance entre un pourcentage et une
  // position. Ici on attrape la chose elle-même.
  //
  // Le panneau « Sensibilité » est conservé, replié : il reste le seul chemin
  // accessible au clavier, qu'une toile ne peut pas offrir.

  /** Zones cliquables reconstruites à chaque tracé — la toile n'a pas de DOM. */
  private hit: { gestureId: string; auto: number; top: number; x: number }[] = []
  private readonly ROW = 66
  /** Tolérance de préhension autour du trait. */
  private readonly GRAB = 9

  protected hover = signal<string | null>(null)
  protected drag = signal<{ gestureId: string; auto: number } | null>(null)

  // ---- Ne montrer que les gestures les plus proches de ce qu'on fait ----
  //
  // Au-delà de trois ou quatre poses, la toile devenait une liste à parcourir
  // pour y chercher la sienne à chaque essai. Une gesture très loin du seuil
  // n'apprend rien : sa barre est un trait au ras de zéro.
  //
  // Le classement se fait sur `distance / seuil`, PAS sur la distance brute.
  // Chaque gesture a son propre seuil (auto × sensibilité) : une pose à 0,22
  // dont le seuil vaut 0,20 est bien plus près de partir qu'une pose à 0,12
  // dont le seuil vaut 0,08. Classer sur les distances reviendrait à les
  // comparer sur une échelle qui n'existe pas.

  /** Lignes affichées simultanément. */
  private readonly SHOWN = 3
  /** Lissage du classement. À 30 Hz, un classement instantané réordonne la
   *  liste à chaque frame dès que deux poses se tiennent de près : les noms
   *  sautent et plus rien ne se lit. */
  private readonly EMA = 0.15
  /** Ce qu'une prétendante doit gagner sur une affichée pour la déloger. Sans
   *  cette marge, deux poses à égalité se relaieraient sans fin. */
  private readonly OUST = 0.85
  /** Durée minimale d'une place, en ms — le temps de lire une ligne. */
  private readonly DWELL = 600

  /** Proximité lissée par gesture. Absente = distance indisponible (bloc requis
   *  manquant, main hors champ) : un trou, pas une valeur lointaine. */
  private prox = new Map<string, number>()
  /** Occupants des places, dans l'ordre d'affichage. Une gesture GARDE sa place
   *  tant qu'elle n'est pas délogée : sans ça les lignes se réordonneraient
   *  sous le curseur pendant qu'on vise une poignée. */
  private slots: string[] = []
  private slotAt = 0

  /**
   * Les gestures à dessiner, au plus `SHOWN`.
   *
   * Trois règles, chacune pour une panne qu'on verrait à l'écran :
   *  · une gesture ACTIVE reste affichée quoi qu'il arrive — c'est précisément
   *    le moment où on la regarde ;
   *  · rien ne bouge pendant un glissement, sinon la ligne dont on règle le
   *    seuil peut disparaître sous la souris en plein réglage ;
   *  · une place ne change qu'après `DWELL`, et seulement pour nettement mieux.
   */
  private pickShown(snaps: GestureSnapshot[]): GestureSnapshot[] {
    const by = new Map(snaps.map((s) => [s.gestureId, s]))
    for (const s of snaps) {
      if (s.dist === null || !s.threshold) {
        this.prox.delete(s.gestureId)
        continue
      }
      const cur = s.dist / s.threshold
      const prev = this.prox.get(s.gestureId)
      this.prox.set(s.gestureId, prev === undefined ? cur : prev + (cur - prev) * this.EMA)
    }
    // Une gesture supprimée ne garde ni sa place ni sa moyenne.
    for (const id of [...this.prox.keys()]) if (!by.has(id)) this.prox.delete(id)
    this.slots = this.slots.filter((id) => by.has(id))

    if (snaps.length <= this.SHOWN) {
      this.slots = snaps.map((s) => s.gestureId)
      return snaps
    }

    if (!this.drag()) {
      const active = snaps.filter((s) => s.state === 'ACTIVE').map((s) => s.gestureId)
      const ranked = [...this.prox.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id)
      const wanted = [...new Set([...active, ...ranked])].slice(0, this.SHOWN)

      // Remplir une place libre ne coûte rien : il n'y a personne à déloger.
      for (const id of wanted) {
        if (this.slots.length >= this.SHOWN) break
        if (!this.slots.includes(id)) this.slots.push(id)
      }
      if (performance.now() - this.slotAt >= this.DWELL) {
        for (const id of wanted) {
          if (this.slots.includes(id)) continue
          // Déloger la moins bonne des affichées, et seulement si l'arrivante
          // fait nettement mieux. Une affichée sans distance (main sortie du
          // champ) cède sa place sans discuter — sa proximité vaut l'infini.
          let worst = -1
          let worstProx = -Infinity
          this.slots.forEach((sid, i) => {
            if (by.get(sid)?.state === 'ACTIVE') return
            const p = this.prox.get(sid) ?? Infinity
            if (p > worstProx) {
              worstProx = p
              worst = i
            }
          })
          const gain = this.prox.get(id) ?? Infinity
          if (worst >= 0 && gain < worstProx * this.OUST) {
            this.slots[worst] = id
            this.slotAt = performance.now()
            break // une seule permutation par palier : la liste reste lisible
          }
        }
      }
    }
    return this.slots.map((id) => by.get(id)!).filter(Boolean)
  }

  private rowAt(ev: MouseEvent): { gestureId: string; auto: number; x: number; near: boolean } | null {
    const canvas = this.barsRef?.nativeElement
    if (!canvas) return null
    const r = canvas.getBoundingClientRect()
    const x = ev.clientX - r.left
    const y = ev.clientY - r.top
    const row = this.hit.find((h) => y >= h.top && y < h.top + this.ROW)
    if (!row) return null
    return { gestureId: row.gestureId, auto: row.auto, x, near: Math.abs(x - row.x) <= this.GRAB }
  }

  onBarsMove(ev: MouseEvent): void {
    const d = this.drag()
    if (d) {
      // Le x se lit sur la toile, PAS via rowAt : sortir de la ligne
      // verticalement pendant qu'on glisse est normal, et ça ne doit pas
      // renvoyer « aucune ligne » donc x = 0, donc sensibilité au minimum.
      const rect = this.barsRef!.nativeElement.getBoundingClientRect()
      const x = ev.clientX - rect.left
      // Position → sensibilité, bornée à la même plage que l'ancien curseur.
      const sens = Math.min(3, Math.max(0.4, (x / Math.max(1, rect.width)) * 3))
      // En mémoire seulement pendant le glissement : écrire sur le disque à
      // chaque pixel ferait des centaines d'écritures par réglage.
      this.store.setSensitivityLocal(d.gestureId, sens)
      return
    }
    const r = this.rowAt(ev)
    this.hover.set(r?.near ? r.gestureId : null)
  }

  onBarsDown(ev: MouseEvent): void {
    const r = this.rowAt(ev)
    if (!r?.near) return
    ev.preventDefault()
    this.drag.set({ gestureId: r.gestureId, auto: r.auto })
  }

  /** Fin de geste : c'est là, et seulement là, qu'on écrit. */
  onBarsUp(): void {
    const d = this.drag()
    if (!d) return
    this.drag.set(null)
    void this.store.persistGesture(d.gestureId)
  }

  /** Double-clic sur la poignée : retour au seuil calculé par le wizard. */
  onBarsDbl(ev: MouseEvent): void {
    const r = this.rowAt(ev)
    if (!r?.near) return
    this.store.setSensitivityLocal(r.gestureId, 1)
    void this.store.persistGesture(r.gestureId)
  }





  readonly flash = signal(false)
  private lastLogged = 0

  label(kind: 'fire' | 'release' | 'error'): string {
    if (kind === 'fire') return 'affiché'
    return kind === 'release' ? 'retiré' : 'action en échec'
  }

  constructor() {
    effect(() => {
      const top = this.matcher.triggerLog()[0]
      if (!top || top.kind !== 'fire' || top.ts === this.lastLogged) return
      this.lastLogged = top.ts
      this.flash.set(true)
      setTimeout(() => this.flash.set(false), 450)
    })
  }

  ngAfterViewInit(): void {
    const draw = () => {
      this.drawBars()
      // Après le tracé : la hauteur de la carte du bas dépend du nombre de
      // lignes qu'elle vient de dessiner. Mesurer avant, ce serait mesurer
      // l'image précédente.
      this.measureCam()
      this.raf = requestAnimationFrame(draw)
    }
    this.raf = requestAnimationFrame(draw)
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.raf)
  }

  /** « main G » = ta main gauche : le flux n'est pas mirroré, la handedness
   *  MediaPipe est donc anatomique. */
  private blockLabel(b: BlockDiag): string {
    if (b.kind === 'face') return 'visage'
    const side = b.slot === 0 ? 'G' : 'D'
    return b.kind === 'hand' ? `main ${side}` : `pos ${side}`
  }

  /** Couleurs lues depuis les tokens CSS : la toile et le DOM ne divergent jamais. */
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

  /** Barre à extrémité arrondie, ancrée à la ligne de base. */
  private bar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
    const r = Math.min(h / 2, w / 2)
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + w - r, y)
    ctx.quadraticCurveTo(x + w, y, x + w, y + r)
    ctx.lineTo(x + w, y + h - r)
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
    ctx.lineTo(x, y + h)
    ctx.closePath()
    ctx.fill()
  }

  private drawBars(): void {
    const canvas = this.barsRef?.nativeElement
    if (!canvas) return
    const all = this.matcher.lastSnapshots
    // `pickShown` est appelée à CHAQUE tracé, y compris quand il n'y a rien à
    // dessiner : c'est elle qui entretient les moyennes glissantes. La sauter
    // quand la liste est vide ferait repartir le classement de zéro à chaque
    // main sortie du champ.
    const snaps = this.pickShown(all)
    const hidden = all.length - snaps.length
    const ROW = this.ROW // une seule source : le tracé et la préhension doivent
    const BAR_H = 12 //     s'accorder au pixel près, sinon on clique à côté
    const cssW = canvas.clientWidth || 480
    // La hauteur suit le nombre de lignes RETENUES : la carte se règle sur ce
    // qu'elle montre, elle ne garde pas la place des gestures écartées.
    const cssH = Math.max(1, snaps.length) * ROW + (hidden > 0 ? 26 : 10)
    const dpr = window.devicePixelRatio || 1
    const pxW = Math.round(cssW * dpr)
    const pxH = Math.round(cssH * dpr)
    // Redimensionner réinitialise le contexte : on le fait AVANT tout réglage.
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW
      canvas.height = pxH
      canvas.style.height = `${cssH}px`
    }

    const ctx = canvas.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, cssH)

    const ink = this.token('--ink')
    const ink2 = this.token('--ink-2')
    const ink3 = this.token('--ink-3')
    const track = this.token('--void')
    const panel = this.token('--panel-2')
    const uiFont = '12.5px "Segoe UI Variable Display", "Segoe UI", system-ui'
    const dataFont = '12px "Cascadia Mono", ui-monospace, Consolas, monospace'

    if (!all.length || !snaps.length) {
      ctx.font = uiFont
      ctx.fillStyle = ink3
      // Trois silences différents, trois phrases différentes. « Aucune ligne »
      // ne veut pas dire la même chose selon qu'il n'y a pas de gesture, que le
      // Panic les a coupées, ou que rien n'est mesurable à cet instant.
      ctx.fillText(
        this.matcher.muted()
          ? 'Gestures coupées par le bouton Panic.'
          : !all.length
            ? 'Rien à mesurer : démarre la caméra et active au moins une pose.'
            : 'Aucune mesure : visage ou main hors du champ.',
        0,
        20,
      )
      return
    }

    // Échelle PAR LIGNE, fondée sur le seuil AUTO de la gesture.
    //
    // Trois exigences qui semblaient s'exclure :
    //   1. le trait de seuil ne doit pas bouger tout seul ;
    //   2. il doit bouger quand on règle la sensibilité — c'est CE qu'on règle ;
    //   3. on doit pouvoir l'attraper à la souris.
    //
    // La faute d'origine n'était pas « échelle absolue » mais « échelle PARTAGÉE
    // et recalculée à chaque frame sur les distances vivantes » : une pose qui
    // s'éloignait faisait glisser les traits de toutes les autres. En prenant
    // `thresholdAuto × SPAN` comme pleine largeur, l'échelle ne dépend plus
    // d'aucune mesure — `thresholdAuto` ne change qu'au réenregistrement.
    //
    // Le trait tombe alors en `sensibilité / SPAN` de la largeur : il ne dépend
    // QUE de la sensibilité. Conséquence heureuse — toutes les gestures laissées
    // en automatique (sensibilité = 1) alignent leur trait au tiers, ce qui
    // reconstitue la colonne de référence, et seules celles qu'on a retouchées
    // s'en écartent visiblement.
    const SPAN = 3 // pleine largeur = 3 × seuil auto, couvre la plage 0,4–3
    // Reconstruites à chaque tracé : une gesture supprimée ne doit pas laisser
    // derrière elle une zone cliquable qui règle un fantôme.
    this.hit = []
    const autoOf = (id: string) => {
      const g = this.store.gestures().find((x) => x.id === id)
      return g ? (g.thresholdAuto ?? g.threshold) : null
    }

    snaps.forEach((s, i) => {
      const y = i * ROW + 8
      const color = this.stateColor(s.state)
      const active = s.state === 'ACTIVE'

      // Le nom porte l'encre du texte, jamais la couleur de série : c'est le
      // voyant à gauche qui porte l'identité d'état, doublé du mot lui-même.
      ctx.beginPath()
      ctx.fillStyle = color
      ctx.arc(4, y + 5, 4, 0, 7)
      ctx.fill()

      ctx.font = uiFont
      ctx.fillStyle = ink
      ctx.fillText(s.name, 15, y + 9)
      const nameW = ctx.measureText(s.name).width

      ctx.font = dataFont
      ctx.fillStyle = ink3
      ctx.fillText(s.state.toLowerCase(), 15 + nameW + 10, y + 9)

      // La valeur, alignée à droite : c'est le chiffre qu'on vient chercher
      ctx.textAlign = 'right'
      ctx.fillStyle = s.dist === null ? ink3 : ink2
      ctx.fillText(s.dist === null ? '—' : s.dist.toFixed(3), cssW, y + 9)
      ctx.textAlign = 'left'

      // Pleine largeur = seuil auto × SPAN. Sans seuil auto connu (gesture tout
      // juste supprimée), on retombe sur le seuil effectif : jamais de division
      // par zéro, jamais de barre qui disparaît.
      const auto = autoOf(s.gestureId) ?? s.threshold ?? 1
      const full = (auto || 1) * SPAN
      const T_X = Math.min(cssW - 2, (s.threshold / full) * cssW)
      this.hit[i] = { gestureId: s.gestureId, auto: auto || 1, top: y, x: T_X }

      const barY = y + 18
      ctx.fillStyle = track
      this.bar(ctx, 0, barY, cssW, BAR_H)
      if (s.dist !== null) {
        const w = Math.max(3, Math.min(cssW, (s.dist / full) * cssW))
        // Une gesture qui déclenche mérite d'être vue du coin de l'œil :
        // c'est le seul moment où la toile s'autorise une lueur.
        if (active) {
          ctx.shadowColor = color
          ctx.shadowBlur = 14
        }
        const grad = ctx.createLinearGradient(0, 0, w, 0)
        grad.addColorStop(0, color + 'bb')
        grad.addColorStop(1, color)
        ctx.fillStyle = grad
        this.bar(ctx, 0, barY, w, BAR_H)
        ctx.shadowBlur = 0
      }

      // Poignée de seuil. Elle ne bouge que si on la bouge — ou si on
      // réenregistre la pose. Épaissie au survol pour dire qu'elle s'attrape.
      const grabbed = this.drag()?.gestureId === s.gestureId
      const hot = grabbed || this.hover() === s.gestureId
      ctx.fillStyle = hot ? color : ink2
      ctx.fillRect(T_X - (hot ? 1 : 0), barY - 7, hot ? 3 : 1.5, BAR_H + 14)
      ctx.strokeStyle = ink3
      ctx.lineWidth = 1
      ctx.setLineDash([2, 3])
      ctx.beginPath()
      const hx = Math.min(cssW - 1, T_X * HYSTERESIS)
      ctx.moveTo(hx, barY - 4)
      ctx.lineTo(hx, barY + BAR_H + 4)
      ctx.stroke()
      ctx.setLineDash([])

      // Pendant le glissement : le pourcentage et le seuil obtenu, au-dessus du
      // curseur. C'est le chiffre qu'affichait l'ancien curseur, rendu là où
      // l'œil est déjà.
      if (grabbed) {
        const sens = s.threshold / (auto || 1)
        const label = `${(sens * 100).toFixed(0)}%  ·  ${s.threshold.toFixed(3)}`
        ctx.font = dataFont
        const tw = ctx.measureText(label).width + 14
        const bx = Math.max(0, Math.min(cssW - tw, T_X - tw / 2))
        ctx.fillStyle = panel
        this.bar(ctx, bx, barY - 30, tw, 20)
        ctx.fillStyle = ink
        ctx.textAlign = 'center'
        ctx.fillText(label, bx + tw / 2, barY - 16)
        ctx.textAlign = 'left'
      }

      // Détail par partie. Comparer un bloc seul au seuil est une heuristique
      // (le seuil porte sur la moyenne) mais c'est ce qui se lit le mieux :
      // « cette partie à elle seule dépasse le budget total ».
      let x = 0
      const chipY = barY + BAR_H + 9
      ctx.font = dataFont
      for (const b of s.blocks ?? []) {
        const label = this.blockLabel(b)
        const text = b.dist === null ? `${label} —` : `${label} ${b.dist.toFixed(2)}`
        const w = ctx.measureText(text).width + 15
        if (x + w > cssW) break // jamais de débordement
        const over = b.dist !== null && b.dist > s.threshold
        const hue =
          b.dist === null
            ? this.token('--st-idle')
            : over
              ? this.token('--st-live')
              : this.token('--st-armed')
        ctx.fillStyle = panel
        this.bar(ctx, x, chipY, w, 18)
        ctx.fillStyle = hue
        ctx.fillRect(x, chipY + 4, 2, 10) // liseré : l'état se lit aussi à la forme
        ctx.fillStyle = b.dist === null ? ink3 : ink2
        ctx.fillText(text, x + 10, chipY + 12.5)
        x += w + 5 // écart de surface entre pastilles
      }
    })

    // Dire ce qui n'est pas montré. Sans cette ligne, quelqu'un qui a douze
    // poses et n'en voit que trois croit en avoir perdu neuf.
    if (hidden > 0) {
      ctx.font = uiFont
      ctx.fillStyle = ink3
      ctx.fillText(
        `+${hidden} pose(s) plus loin du seuil, masquée(s)`,
        0,
        snaps.length * ROW + 18,
      )
    }
  }
}
