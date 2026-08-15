import { Routes } from '@angular/router'
import { DebugPage } from './pages/debug.page'
import { GesturesPage } from './pages/gestures.page'
import { LivePage } from './pages/live.page'
import { SettingsPage } from './pages/settings.page'

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'live' },
  { path: 'gestures', component: GesturesPage },
  { path: 'live', component: LivePage },
  { path: 'debug', component: DebugPage },
  { path: 'reglages', component: SettingsPage },
]
