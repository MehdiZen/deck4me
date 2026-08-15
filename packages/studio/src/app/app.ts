import { Component, inject } from '@angular/core'
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router'
import { DetectionService } from './services/detection.service'
import { MatcherService } from './services/matcher.service'
import { StoreService } from './services/store.service'

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <header>
      <span class="logo">meme4me</span>
      <nav>
        <a routerLink="/gestures" routerLinkActive="on">Gestures</a>
        <a routerLink="/live" routerLinkActive="on">Live</a>
        <a routerLink="/reglages" routerLinkActive="on">Réglages</a>
      </nav>
      <span class="spacer"></span>
      @if (matcher.muted()) {
        <span class="badge err"><i class="led live"></i>gestures coupées</span>
        <button class="primary" (click)="matcher.unmute()">Réactiver</button>
      } @else if (detection.running()) {
        <span class="badge ok">
          <i class="led on"></i>détection
          <b class="num">{{ detection.fps() }}</b> fps
        </span>
        <button class="danger" (click)="matcher.panic()">Panic</button>
      } @else {
        <span class="badge"><i class="led"></i>caméra à l'arrêt</span>
      }
    </header>
    <main>
      <router-outlet />
    </main>
  `,
  styles: `
    header {
      display: flex; align-items: center; gap: 22px;
      padding: 11px 22px;
      background: var(--panel);
      border-bottom: 1px solid var(--line);
      position: sticky; top: 0; z-index: 10;
    }
    .logo {
      font-weight: 700; font-size: 15px; letter-spacing: -0.02em;
      color: var(--ink);
    }
    .logo::before {
      content: ''; display: inline-block;
      width: 8px; height: 8px; margin-right: 9px; vertical-align: 1px;
      border-radius: 2px; background: var(--accent);
    }
    .spacer { flex: 1; }
    /* Navigation en segments : on voit où on est, pas juste où on peut aller */
    nav {
      display: flex; gap: 2px;
      background: var(--ground);
      border: 1px solid var(--line-soft);
      border-radius: 9px;
      padding: 3px;
    }
    nav a {
      color: var(--ink-2); text-decoration: none;
      padding: 5px 13px; border-radius: 6px;
      font-size: 13px; font-weight: 500;
      transition: color 120ms ease, background 120ms ease;
    }
    nav a:hover { color: var(--ink); }
    nav a.on { background: var(--panel-2); color: var(--ink); box-shadow: var(--shadow); }
    header .badge b { font-weight: 600; }
    main { padding: 22px; }
  `,
})
export class App {
  protected detection = inject(DetectionService)
  protected matcher = inject(MatcherService)
  private store = inject(StoreService)

  constructor() {
    void this.store.load()
    this.matcher.init()
  }
}
