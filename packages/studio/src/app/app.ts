import { Component, effect, inject } from '@angular/core'
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router'
import { listen } from '@tauri-apps/api/event'
import { Confirm } from './components/confirm'
import { Icon } from './components/icon'
import { DetectionService } from './services/detection.service'
import { MatcherService } from './services/matcher.service'
import { StoreService } from './services/store.service'
import { UpdateService } from './services/update.service'
import { VcamService } from './services/vcam.service'

/**
 * Coque de l'application : rail à gauche, écran à droite.
 *
 * Le rail n'est pas qu'une navigation. Son tiers bas est une régie toujours
 * visible — profil actif, cadence, coupure d'urgence — parce que ce sont les
 * trois choses qu'on cherche en panique pendant un live, et qu'aller les
 * chercher dans un écran serait déjà trop long.
 */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, Icon, Confirm],
  template: `
    <div class="shell">
      <aside class="rail">
        <div class="brand">
          <span class="mark"></span>
          <span class="word">deck<b>4</b>me</span>
        </div>

        <!-- Cinq destinations, et une seule langue.
             « Gestures » disait en anglais ce que tout le reste de
             l'application appelle une pose — jusque dans le même écran, où le
             titre annonçait Gestures et le sous-titre comptait des poses. Deux
             mots pour un objet, c'est un objet de plus à apprendre. -->
        <nav>
          <a routerLink="/live" routerLinkActive="on"><app-icon name="live" /> Live</a>
          <a routerLink="/gestures" routerLinkActive="on"><app-icon name="hand" /> Poses</a>
          <a routerLink="/macros" routerLinkActive="on"><app-icon name="zap" /> Macros</a>
          <a routerLink="/deck" routerLinkActive="on"><app-icon name="keyboard" /> Deck</a>
          <a routerLink="/reglages" routerLinkActive="on"><app-icon name="sliders" /> Réglages</a>
        </nav>

        <span class="spacer"></span>

        <!-- Le diagnostic n'est pas une destination.
             Il occupait un sixième du rail, au même poids visuel que Live, sur
             le chemin normal — avec des sections nommées « Stabilité des
             blendshapes ». Le public visé n'a pas à savoir ce qu'est un
             blendshape. Il reste atteignable, en bas, en discret. -->
        <a class="diag" routerLink="/debug" routerLinkActive="on">
          <app-icon name="pulse" [size]="14" /> Diagnostic
        </a>

        <!-- Régie -->
        <div class="console">
          @if (store.profiles().length > 1) {
            <label class="prof">
              <app-icon name="layers" [size]="15" />
              <select
                [value]="store.activeProfile()?.id ?? ''"
                (change)="switchProfile($event)"
                aria-label="Profil actif"
              >
                <!-- [selected] sur l'option, pas seulement [value] sur le
                     select : la valeur du select est posée AVANT que @for ait
                     créé les options, elle ne correspond donc à rien et
                     l'affichage retombe sur la première entrée. -->
                @for (p of store.profiles(); track p.id) {
                  <option [value]="p.id" [selected]="p.isActive">{{ p.name }}</option>
                }
              </select>
            </label>
          }

          <div class="meter" [class.armed]="detection.running()">
            <span class="lbl">cadence</span>
            <span class="val num">{{ detection.running() ? detection.fps() : '—' }}</span>
            <span class="unit">fps</span>
          </div>

          @if (matcher.muted()) {
            <button class="primary wide" (click)="matcher.unmute()">
              <app-icon name="play" [size]="16" /> Réactiver
            </button>
            <p class="cut">Poses coupées.</p>
          } @else {
            <button class="danger wide" (click)="matcher.panic()">
              <app-icon name="power" [size]="16" /> Panic
            </button>
          }
        </div>
      </aside>

      <main>
        <!-- Panne bloquante : sans serveur local, rien n'arrive jamais dans
             OBS. Ça se dit en haut de chaque écran, pas dans un journal. -->
        @if (store.serverError(); as err) {
          <div class="fatal rise">
            <app-icon name="power" [size]="18" />
            <div>
              <b>Le serveur local n'a pas démarré.</b>
              <p>{{ err }}</p>
            </div>
          </div>
        }
        <router-outlet />
      </main>
    </div>

    <!-- Montée une seule fois pour toute l'app : une boîte de confirmation
         par écran, c'est quatre fois le même code et quatre occasions de
         diverger. -->
    <app-confirm />
  `,
  styles: `
    .shell { display: flex; height: 100vh; overflow: hidden; }

    .rail {
      width: var(--rail);
      flex: none;
      display: flex;
      flex-direction: column;
      padding: 18px 14px 14px;
      gap: 4px;
      background: linear-gradient(180deg, #17161f, #121118);
      border-right: 1px solid var(--line);
      box-shadow: 1px 0 0 #ffffff06;
      z-index: 5;
    }

    /* Marque : le carré d'accent porte l'identité, le mot la porte en creux.
       Le 4 en violet fait le lien entre le pictogramme et le nom. */
    .brand { display: flex; align-items: center; gap: 10px; padding: 4px 8px 20px; }
    .mark {
      width: 22px; height: 22px; border-radius: 7px;
      background: linear-gradient(145deg, var(--accent-hi), var(--accent-lo));
      box-shadow: 0 4px 14px -4px var(--accent-glow), inset 0 1px 0 #ffffff40;
      position: relative;
    }
    .mark::after {
      content: '';
      position: absolute; inset: 6px 6px auto 6px; height: 3px;
      border-radius: 99px; background: #ffffffd0;
      box-shadow: 0 5px 0 #ffffff70;
    }
    .word { font-size: 15.5px; font-weight: 640; letter-spacing: -0.025em; }
    .word b { color: var(--accent-hi); font-weight: 640; }

    nav { display: flex; flex-direction: column; gap: 2px; }
    nav a {
      position: relative;
      display: flex; align-items: center; gap: 11px;
      padding: 9px 11px; border-radius: 9px;
      color: var(--ink-2); text-decoration: none;
      font-size: 13.5px; font-weight: 520;
      transition: color 160ms var(--ease), background 160ms var(--ease);
    }
    nav a app-icon { color: var(--ink-3); transition: color 160ms var(--ease); }
    nav a:hover { color: var(--ink); background: #ffffff08; }
    nav a:hover app-icon { color: var(--ink-2); }
    nav a.on { color: var(--ink); background: var(--accent-wash); font-weight: 580; }
    nav a.on app-icon { color: var(--accent-hi); }
    /* Marqueur de position : un trait lumineux collé au bord du rail */
    nav a.on::before {
      content: '';
      position: absolute; left: -14px; top: 50%; transform: translateY(-50%);
      width: 3px; height: 20px; border-radius: 0 3px 3px 0;
      background: var(--accent-hi);
      box-shadow: 0 0 12px var(--accent);
    }

    .diag {
      display: flex; align-items: center; gap: 9px;
      padding: 6px 11px; margin-bottom: 8px; border-radius: 9px;
      color: var(--ink-3); text-decoration: none; font-size: 12px;
      transition: color 160ms var(--ease), background 160ms var(--ease);
    }
    .diag app-icon { color: var(--ink-3); }
    .diag:hover { color: var(--ink-2); background: #ffffff06; }
    .diag.on { color: var(--ink-2); background: #ffffff0a; }

    .console {
      display: flex; flex-direction: column; gap: 9px;
      padding: 12px; border-radius: var(--r-panel);
      background: #0d0c12;
      border: 1px solid var(--line-soft);
      box-shadow: var(--edge);
    }

    .prof { display: flex; align-items: center; gap: 8px; color: var(--ink-3); }
    .prof select {
      flex: 1; min-width: 0; padding: 6px 26px 6px 9px;
      font-size: 12.5px; background-color: var(--panel-2);
      background-position: right 8px center;
    }

    /* Cadran de cadence : le chiffre domine, l'unité s'efface */
    .meter {
      display: flex; align-items: baseline; gap: 6px;
      padding: 2px 2px 4px;
    }
    .meter .lbl { flex: 1; font-size: 10px; }
    .meter .val {
      font-size: 21px; font-weight: 600; letter-spacing: -0.03em;
      color: var(--ink-3); transition: color 300ms var(--ease);
    }
    .meter.armed .val { color: var(--st-armed); text-shadow: 0 0 18px #17a26866; }
    .meter .unit { font-size: 10.5px; color: var(--ink-3); }

    .wide { width: 100%; }
    .cut { margin: 0; font-size: 11.5px; color: var(--st-live); text-align: center; }

    main { flex: 1; min-width: 0; overflow-y: auto; padding: 26px 30px 40px; }

    .fatal {
      display: flex; align-items: flex-start; gap: 12px;
      padding: 14px 17px; margin-bottom: 20px;
      border-radius: var(--r-panel); font-size: 13px; line-height: 1.55;
      background: #e03e4e16; border: 1px solid #e03e4e66;
      box-shadow: var(--edge);
      color: #f3b6bc;
    }
    .fatal app-icon { color: var(--st-live); margin-top: 1px; }
    .fatal b { display: block; font-weight: 620; color: var(--ink); margin-bottom: 3px; }
    .fatal p { margin: 0; }
  `,
})
export class App {
  protected detection = inject(DetectionService)
  protected matcher = inject(MatcherService)
  protected store = inject(StoreService)
  private updates = inject(UpdateService)
  private vcam = inject(VcamService)

  constructor() {
    // Tout ce qui suit attend que les réglages soient lus : ce sont eux qui
    // disent quoi reprendre au lancement.
    void this.store.load().then(() => this.onSettingsReady())
    this.detection.onCameraChange = (id) => void this.store.saveSettings({ detectionCamera: id })
    this.matcher.init()
    void this.bindHotkeys()

    // Le raccourci « panic » est traité côté Rust (l'overlay est nettoyé même
    // si la webview rame) ; ici on ne fait que refléter l'état.
    effect(() => {
      if (this.matcher.muted()) document.title = 'deck4me — COUPÉ'
      else document.title = 'deck4me Studio'
    })
  }

  private async onSettingsReady(): Promise<void> {
    const s = this.store.settings()
    this.detection.adoptSavedCamera(s.detectionCamera)
    // La caméra virtuelle d'abord : elle prend la webcam physique et la
    // détection bascule ensuite sur « deck4me Camera ». Dans l'autre ordre, la
    // webcam serait déjà prise et la caméra virtuelle échouerait.
    await this.vcam.autoStartIfWanted()
    if (s.detectionAutoStart && !this.detection.running()) {
      // Un échec ici (webcam débranchée, prise par un autre logiciel) ne doit
      // pas empêcher l'application de s'ouvrir : le statut le dira.
      await this.detection.start().catch(() => {})
    }
    await this.updates.checkOnStartup()
  }

  private async bindHotkeys(): Promise<void> {
    try {
      await listen<string>('hotkey', ({ payload }) => {
        switch (payload) {
          case 'panic':
            void this.matcher.panic()
            break
          case 'resume':
            this.matcher.unmute()
            break
          case 'toggle_detection':
            if (this.detection.running()) this.detection.stop()
            else void this.detection.start().catch(() => {})
            break
          case 'next_profile':
            void this.store.nextProfile()
            break
        }
      })
    } catch {
      /* hors webview Tauri : pas de raccourcis, le reste marche */
    }
  }

  async switchProfile(ev: Event): Promise<void> {
    await this.store.setActiveProfile((ev.target as HTMLSelectElement).value)
  }
}
