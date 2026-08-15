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
      <span style="flex:1"></span>
      @if (matcher.muted()) {
        <button class="primary" (click)="matcher.unmute()">Gestures coupées — réactiver</button>
      } @else if (detection.running()) {
        <span class="badge ok">détection {{ detection.fps() }} fps</span>
        <button class="danger" (click)="matcher.panic()">PANIC</button>
      } @else {
        <span class="badge">caméra off</span>
      }
    </header>
    <main>
      <router-outlet />
    </main>
  `,
  styles: `
    header {
      display: flex; align-items: center; gap: 20px;
      padding: 10px 20px; background: #1e293b; border-bottom: 1px solid #334155;
      position: sticky; top: 0; z-index: 10;
    }
    .logo { font-weight: 800; letter-spacing: .02em; color: #38bdf8; }
    nav { display: flex; gap: 4px; }
    nav a { color: #94a3b8; text-decoration: none; padding: 5px 12px; border-radius: 6px; }
    nav a.on { background: #0f172a; color: #e2e8f0; }
    main { padding: 20px; }
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
